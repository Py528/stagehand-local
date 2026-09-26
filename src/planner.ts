import type { Stagehand } from "@browserbasehq/stagehand";
import { cfg } from "./config.js";
import { localClient } from "./llm.js";
import {
  cleanJson,
  withTimeout,
  retry,
  sleep,
  ts,
} from "./utils.js";
import {
  session,
  addToConversation,
  pinLatestExtraction,
  getConversationContext,
  sessionMetrics,
  resetSessionMetrics,
  logSessionMetrics,
} from "./conversation.js";
import { activePage, navigate, dismissCookies, captureScreenshotBase64 } from "./browser.js";
import type { PlanAction } from "./types.js";
import {
  distillPage,
  getCapturedApiData,
  fastExtract,
  buildPlannerSnapshot,
  distillGoogleSearch,
} from "./distill.js";
import { tryHeuristic, resetAdSkipState } from "./heuristics.js";
import { compileGoal, type ExecutionPlan } from "./compiler.js";
import { handleInterstitials } from "./interstitial.js";
import { playbooks, autoLearnFromPage, tryDirectAtsFetch, findAtsUrlOnPage } from "./playbook.js";

export const PLANNER_PROMPT = `You are an autonomous web agent planner controlling a browser.
Given the user goal, current page, action history, and session context, decide ONE next action.

Actions:
1. {"action":"navigate","url":"https://..."}
2. {"action":"act","instruction":"atomic browser action description"}
3. {"action":"extract","instruction":"what to extract from the page"}
4. {"action":"wait","ms":2000}
5. {"action":"done","message":"summary"}

Rules:
- For search queries (Google, YouTube, GitHub, etc.), navigate directly to the search URL when starting.
  * Search Query Entity Preservation: Include ALL identifying keywords (subject, song title, and artist/channel/author name) in the search query URL. Never truncate or omit the artist/source name (e.g. "play crown on youtube from txt" → navigate to "https://www.youtube.com/results?search_query=crown+txt", NOT just "crown").
- Multi-step Research & Deep Navigation:
  * A search results page (e.g. Google Search) is only an index of links. To answer specific questions (e.g. company job openings, career roles, product features, pricing, documentation), DO NOT extract repeatedly on the search engine page. Use "navigate" to the target URL directly from the results or use "act" to CLICK the most relevant organic search result or careers link to visit the actual website (e.g. {"action":"navigate","url":"https://roboflow.com/careers"} or {"action":"act","instruction":"click on the Roboflow careers search result link"})!
  * Once on the company's real website or careers board, THEN use "extract" to read the actual job listings or page content.
- For video/media playback (e.g. YouTube):
  * On search results: click the video title or thumbnail that best matches the requested title and artist.
  * On the video page (/watch?v=...): you can seek to a timestamp by navigating to the URL with "&t=60s" (for 1 minute ahead) or clicking the video timeline.
  * Once the requested video is open, loaded, or playing, return "done" immediately with a concise confirmation message. Do NOT loop actions on the player.
- DO NOT repeat an action that failed or already succeeded — check history and dynamically adjust your plan.
- If you have navigated to the destination page and extracted the factual answer satisfying the goal, return "done" with the answer summary.
- If a "Page Snapshot" is provided, use it to understand what interactive elements (buttons, links, inputs) and content are on the current page. Target actions at real elements you can see in the snapshot.
- Return ONLY valid JSON.`;

/** Extract and return the raw text. */
export async function extractText(sh: Stagehand, instruction: string, page: any): Promise<string> {
  // 1. Try fast extract via distilled page content (smaller prompt → faster prefill)
  try {
    const distilled = await distillPage(page);
    const apiData = getCapturedApiData();
    if (distilled.content.length > 50 || apiData) {
      const fast = await fastExtract(distilled, instruction, apiData);
      if (fast && isExtractionValid(fast)) return fast;
    }
  } catch { /* fall through */ }

  // 2. Scoped fallback: Detect the main content container via quick DOM evaluation.
  // Never allow an unscoped fallback to avoid 20,000+ token AXTree dumps and timeouts.
  try {
    const mainSelector = await page.evaluate(() => {
      const candidates = [
        "main",
        "#content",
        "#main-content",
        '[role="main"]',
        ".jobs",
        ".careers",
        ".openings",
        "article",
        "section",
      ];
      for (const c of candidates) {
        const el = document.querySelector(c);
        if (el && (el as HTMLElement).innerText && (el as HTMLElement).innerText.length > 80) {
          return c;
        }
      }
      return null;
    }).catch(() => null);

    if (mainSelector) {
      try {
        const locator = typeof page.locator === "function" ? page.locator(mainSelector) : undefined;
        const scopedResult = await retry(
          () => sh.extract(instruction, { page, locator, selector: mainSelector } as any),
          "ScopedExtract"
        );
        const data =
          typeof scopedResult.data === "string"
            ? scopedResult.data
            : scopedResult.data?.extraction || JSON.stringify(scopedResult.data, null, 2);
        if (isExtractionValid(data)) return data;
      } catch {
        // Scoped locator failed, fall through to direct text
      }
    }
  } catch {}

  // 3. Fallback: Direct visible text extraction from DOM to local LLM
  // Bypasses Stagehand's 30,000-token AXTree dump completely
  try {
    const visibleText = await page.evaluate(() => {
      const main =
        document.querySelector('main, #content, [role="main"], .jobs, .careers, article') ||
        document.body;
      return (main as HTMLElement).innerText?.slice(0, 15000) || "";
    }).catch(() => "");

    if (visibleText && visibleText.length > 80) {
      const fastFallback = await fastExtract(
        { content: visibleText, interactive: [] },
        instruction,
        null
      );
      if (fastFallback && isExtractionValid(fastFallback)) return fastFallback;
    }
  } catch {}

  // Guard: Never allow an unscoped fallback (which builds 20,000+ token trees and times out)
  return "";
}

/** Check if extraction result is empty/trivial, element IDs, or degraded N/A data. */
export function isExtractionValid(text: string): boolean {
  if (!text || text.length < 10) return false;
  // Common empty patterns from Stagehand
  const cleaned = text.replace(/[\s{}":\[\]]/g, "").replace(/extraction/gi, "");
  if (cleaned.length < 5) return false;

  // If text is purely a list of element IDs like "0-5710, 0-5967, 0-5999" without real content
  const idOnlyPattern = /^(\s*\d+-\d+\s*[,;\s]*)+$/;
  if (idOnlyPattern.test(text.trim())) return false;

  // Structural self-verification: If JSON array of objects, verify data isn't mostly "N/A" / "Unknown" / null
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      let invalidCount = 0;
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const titleVal = String(
          item.title ?? item.name ?? item.role ?? item.item ?? item.description ?? ""
        ).trim().toLowerCase();
        if (
          !titleVal ||
          titleVal === "n/a" ||
          titleVal === "unknown" ||
          titleVal === "null" ||
          titleVal === "none" ||
          titleVal === "undefined"
        ) {
          invalidCount++;
        }
      }
      // If more than 35% of items have N/A / Unknown title, reject this degraded extraction!
      if (invalidCount / parsed.length > 0.35) {
        return false;
      }
    }
  } catch {}

  return true;
}

export interface SynthesisResult {
  answer: string;
  isComplete: boolean;
}

/** Ask the local LLM to evaluate and synthesize extracted data against the goal. */
export async function synthesize(
  goal: string,
  extractedText: string,
  currentUrl = "",
  isFinalStep = false
): Promise<SynthesisResult | undefined> {
  if (!cfg.agent.synthesize) return undefined;
  if (!isExtractionValid(extractedText)) return undefined;

  const context = getConversationContext();
  process.stdout.write(`   💡 Evaluating extraction...\r`);
  try {
    const isSearchPage = /google\.com\/search|bing\.com\/search|duckduckgo\.com/i.test(currentUrl);

    const c: any = await withTimeout(
      localClient.chat.completions.create({
        model: cfg.llm.modelId,
        messages: [
          {
            role: "system",
            content: `You evaluate and synthesize web data extracted by a browser agent to answer the user's goal.

User Goal: "${goal}"
Current Page URL: "${currentUrl}"
${context ? `\nSession context (prior conversation/data):\n${context}` : ""}

Analyze whether the extracted data directly and factually answers the user's goal.

Respond ONLY with a JSON object matching this schema:
{
  "isComplete": boolean,
  "answer": string
}

Guidelines:
1. "isComplete": true ONLY if the extracted data contains the factual, concrete information needed to answer the user's goal (e.g. specific gold rate, specific job listings and remote status, direct price, exact documentation).
   "isComplete": false if the extracted data is only a list of search snippets, search links, inconclusive text, or if visiting the actual target website/careers page is still required to answer the goal. ${isSearchPage && !isFinalStep ? 'NOTE: If currently on a search engine results page and the user asked a deep factual question (e.g. open jobs at a company), isComplete SHOULD BE false so the agent navigates into the target website.' : ''}
2. "answer": A clear, concise markdown answer. If isComplete is false, summarize what was found so far and what page should be visited next.`,
          },
          { role: "user", content: `Extracted Data:\n${extractedText}` },
        ],
        response_format: { type: "json_object" },
        temperature: cfg.llm.temperature,
      }),
      cfg.llm.stepTimeoutMs,
      "Synthesize"
    );
    process.stdout.write("                                        \r");
    const parsed = JSON.parse(cleanJson(c?.choices?.[0]?.message?.content ?? "{}"));
    return {
      answer: typeof parsed.answer === "string" ? parsed.answer.trim() : "",
      isComplete: Boolean(parsed.isComplete),
    };
  } catch (e: any) {
    process.stdout.write("                                        \r");
    if (e?.message?.includes("timed out")) console.warn(`   ⚠️ Synthesis timed out.`);
    return undefined;
  }
}

export function detectUrlQuestion(input: string): { url: string; question: string } | null {
  const m = input.match(/^(https?:\/\/\S+)\s+(.+)$/i);
  if (m && m[1] && m[2]) return { url: m[1], question: m[2] };
  const m2 = input.match(/^([a-z0-9-]+\.[a-z]{2,}\S*)\s+(.+)$/i);
  if (m2 && m2[1] && m2[2] && m2[1].includes("/")) return { url: "https://" + m2[1], question: m2[2] };
  return null;
}

export function detectSearchShortcut(input: string): string | null {
  for (const [key, template] of Object.entries(cfg.shortcuts)) {
    const patterns = [
      new RegExp(`^${key}\\s+(.+)$`, "i"),
      new RegExp(`^search\\s+${key}\\s+(?:for\\s+)?(.+)$`, "i"),
    ];
    for (const pat of patterns) {
      const m = input.match(pat);
      if (m && m[1]) return template.replace("{{query}}", encodeURIComponent(m[1].trim()));
    }
  }
  return null;
}

/** Fast path: URL + question → navigate → extract → synthesize. */
export async function fastUrlQuestion(
  url: string,
  question: string,
  sh: Stagehand,
  page: any,
  onStep?: (info: { step: number; title: string; url: string; action: string; result?: string; screenshot?: string }) => void
): Promise<boolean> {
  console.log(`\n🚀 Fast path: navigate → extract → answer\n`);
  console.log(`   🌐 Navigating: ${url}`);
  if (onStep) onStep({ step: 1, title: "Navigating", url, action: `Navigate to ${url}` });
  await navigate(page, url);
  await dismissCookies(sh, page);

  const title = await page.title().catch(() => "");
  console.log(`   📍 "${title}"`);

  console.log(`   🔍 Extracting: "${question}"`);
  if (onStep) onStep({ step: 2, title, url, action: `Extract: "${question}"` });
  let extracted = await tryDirectAtsFetch(url);
  if (!extracted) {
    const atsLink = await findAtsUrlOnPage(page);
    if (atsLink) extracted = await tryDirectAtsFetch(atsLink);
  }
  if (!extracted) {
    extracted = await extractText(sh, question, page);
  }


  if (!isExtractionValid(extracted)) {
    console.log(`\n⚠️ Extraction returned empty/minimal data from this page.`);
    console.log(`   Try: extract <more specific instruction>\n`);
    addToConversation({
      role: "data",
      content: `Visited ${url} ("${title}") but extraction was empty.`,
      label: "failed_extraction",
    });
    if (onStep) onStep({ step: 2, title, url, action: "Extract failed", result: "Extraction was empty" });
    return false;
  }

  console.log(`\n📄 Extracted:\n${extracted}\n`);
  pinLatestExtraction(extracted, `${url} ("${title}")`);

  const syn = await synthesize(`${url} — ${question}`, extracted, url, true);
  if (syn?.answer) {
    session.lastAnswer = syn.answer;
    console.log(`\n📢 Answer:\n${syn.answer}\n`);
    addToConversation({ role: "assistant", content: syn.answer, label: "answer" });
    session.history.push({ ts: ts(), url, goal: question, result: syn.answer.slice(0, 2000) });
    if (onStep) {
      const screenshot = await captureScreenshotBase64(page);
      onStep({ step: 3, title, url, action: "Completed", result: syn.answer, screenshot });
    }
  }
  return true;
}

export interface AgentStepCallback {
  (info: {
    step: number;
    maxSteps: number;
    title: string;
    url: string;
    plan: PlanAction;
    result?: string | undefined;
    screenshot?: string | undefined;
  }): void;
}

export async function runAgent(
  goal: string,
  sh: Stagehand,
  initialPage: any,
  onStep?: AgentStepCallback
): Promise<string | undefined> {
  console.log(`\n🤖 Agent: "${goal}"\n`);
  resetSessionMetrics();
  resetAdSkipState();

  // ─── TIER 0: Compile Goal Contract at t=0 (<300ms) ───
  let compiledPlan: ExecutionPlan | null = null;
  try {
    compiledPlan = await compileGoal(goal);
    if (compiledPlan && compiledPlan.primaryQuery) {
      const extra = [
        compiledPlan.targetName ? `Target: "${compiledPlan.targetName}"` : "",
        compiledPlan.creatorOrOrg ? `By: "${compiledPlan.creatorOrOrg}"` : "",
        compiledPlan.timeOffsetSeconds ? `Offset: ${compiledPlan.timeOffsetSeconds}s` : "",
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`   🎯 Goal Plan [t=0]: Service=${compiledPlan.service} | Query="${compiledPlan.primaryQuery}"${extra ? ` (${extra})` : ""}`);
    }
  } catch {
    // Non-fatal fallback
  }

  const history: string[] = [];
  const actionRecords: Array<{
    action: string;
    url: string;
    instruction?: string;
    empty?: boolean;
  }> = [];
  let answer: string | undefined;
  let lastActionKey = "";

  const context = getConversationContext();
  const contextNote = context ? `\nSession context (prior data/conversation):\n${context.slice(0, 2000)}` : "";

  for (let step = 1; step <= cfg.agent.maxSteps; step++) {
    const page = await activePage(sh, initialPage);
    const url = await page.url().catch(() => "about:blank");
    const title = await page.title().catch(() => "");

    console.log(`[${step}/${cfg.agent.maxSteps}] 📍 "${title || "Blank"}" (${url})`);

    // ─── INTERSTITIAL RECOVERY PROTOCOL: Detect & Clear Blockers (Ads, Modals, Overlays) ───
    try {
      const interstitial = await handleInterstitials(page);
      if (interstitial.handled) {
        console.log(`   🛡️ Interstitial Handled: ${interstitial.action}`);
        history.push(`Dismantled blocker: ${interstitial.action}`);
      }
    } catch {}

    // ─── TIER 0: Zero-LLM Heuristic Fast-Paths (<100ms, 0 tokens) ───
    try {
      const heuristic = await tryHeuristic(page, goal, url, history, compiledPlan || undefined);
      if (heuristic) {
        sessionMetrics.tier0++;
        sessionMetrics.tokensSaved += 600;
        console.log(`   ${heuristic.description}`);
        history.push(heuristic.description);
        actionRecords.push({ action: "heuristic", url, instruction: heuristic.description });
        if (onStep) {
          const screenshot = await captureScreenshotBase64(page);
          onStep({
            step, maxSteps: cfg.agent.maxSteps, title, url,
            plan: heuristic.doneMessage
              ? { action: "done", message: heuristic.doneMessage }
              : { action: "act", instruction: heuristic.description },
            result: heuristic.doneMessage,
            screenshot,
          });
        }
        if (heuristic.doneMessage) {
          console.log(`\n🎉 ${heuristic.doneMessage}\n`);
          logSessionMetrics();
          // Auto-learn from this page
          const capturedUrls = Array.from(
            (getCapturedApiData() || "").matchAll(/\[([^\]]+)\]:/g)
          ).map((m) => m[1]!);
          await autoLearnFromPage(page, url, capturedUrls);
          playbooks.recordSuccess(normalizeDomain(url));
          return heuristic.doneMessage;
        }
        if (heuristic.continueLoop) continue;
      }
    } catch {
      // Heuristic failure is non-fatal — fall through to planner
    }

    // ─── TIER 1: Playbook / Site Memory Check & Master ATS Archetype Direct API ───
    try {
      const domain = normalizeDomain(url);
      const pb = playbooks.get(domain);
      if (pb && pb.endpoints.length > 0) {
        // Check if any captured API data matches known endpoints
        const apiData = getCapturedApiData();
        if (apiData && apiData.length > 100) {
          sessionMetrics.tier1++;
          sessionMetrics.tokensSaved += 500;
          console.log(`   📚 Playbook hit: ${domain} (${pb.endpoints.length} known endpoints, archetype: ${pb.archetypeId || "none"})`);
        }
      }

      // Master ATS Archetype Direct API Fetch (Ashby, Greenhouse, Lever)
      // When on an ATS domain OR on a careers page that embeds/links to an ATS:
      let directAtsJobs: string | null = null;
      let targetAtsUrl: string | null = null;

      if (/ashbyhq\.com|greenhouse\.io|lever\.co/i.test(url)) {
        targetAtsUrl = url;
      } else if (
        /careers?|jobs?|openings/i.test(url) ||
        /careers?|jobs?|openings|roles?|hiring|engineer|developer/i.test(goal)
      ) {
        targetAtsUrl = await findAtsUrlOnPage(page);
      }

      if (targetAtsUrl) {
        directAtsJobs = await tryDirectAtsFetch(targetAtsUrl);
      }

      if (directAtsJobs && directAtsJobs.length > 20) {
        sessionMetrics.tier1++;
        sessionMetrics.tokensSaved += 2500;
        const jobCount = directAtsJobs.split("\n").length;
        console.log(`   ⚡ Master ATS Archetype hit: Direct API fetched ${jobCount} listings (<200ms, 0 DOM tokens)`);
        pinLatestExtraction(directAtsJobs, url);

        const syn = await synthesize(goal, directAtsJobs, url, true);
        if (syn?.answer && (syn.isComplete || step >= cfg.agent.maxSteps - 1)) {
          answer = syn.answer;
          session.lastAnswer = answer;
          console.log(`\n📢 Answer:\n${answer}\n`);
          addToConversation({ role: "assistant", content: answer, label: "answer" });
          session.history.push({ ts: ts(), url, goal, result: answer.slice(0, 2000) });
          console.log(`🎉 Goal completed via ATS Direct API Fast-Path!\n`);
          logSessionMetrics();
          if (onStep) {
            const screenshot = await captureScreenshotBase64(page);
            onStep({
              step,
              maxSteps: cfg.agent.maxSteps,
              title,
              url,
              plan: { action: "done", message: answer },
              result: answer,
              screenshot,
            });
          }
          return answer;
        }
      }
    } catch {
      // Non-critical
    }

    // ─── TIER 2: Distilled LLM Planner ───
    let snapshot = "";


    // Dedicated Google SERP handling: AI Overview / Featured Snippet check & clean organic results
    if (url.includes("google.com/search")) {
      const serp = await distillGoogleSearch(page);

      // Path A: Opportunistic check — does AI Overview or Featured Snippet directly answer the goal?
      if (serp.aiOverview && serp.aiOverview.length > 60) {
        process.stdout.write(`   ⚡ Checking Google direct answer / AI Overview...\r`);
        const answerCandidate = await fastExtract(
          { content: serp.aiOverview, interactive: [] },
          `Does this information factually answer: "${goal}"? If so, extract the complete answer. If visiting the company or destination website is still required, return empty string.`,
          null
        );
        if (answerCandidate && isExtractionValid(answerCandidate)) {
          const syn = await synthesize(goal, answerCandidate, url, true);
          if (syn?.isComplete && syn.answer) {
            sessionMetrics.tier0++;
            sessionMetrics.tokensSaved += 800;
            console.log(`\n🎉 Answered via Google direct answer!\n`);
            console.log(`📢 Answer:\n${syn.answer}\n`);
            logSessionMetrics();
            session.lastAnswer = syn.answer;
            addToConversation({ role: "assistant", content: syn.answer, label: "answer" });
            session.history.push({ ts: ts(), url, goal, result: syn.answer.slice(0, 2000) });
            if (onStep) {
              const screenshot = await captureScreenshotBase64(page);
              onStep({
                step,
                maxSteps: cfg.agent.maxSteps,
                title,
                url,
                plan: { action: "done", message: syn.answer },
                result: syn.answer,
                screenshot,
              });
            }
            return syn.answer;
          }
        }
      }

      // Path B: Only feed Title + Clean Target URL to the planner snapshot (slashes ~800 tokens to ~120)
      if (serp.results.length > 0) {
        snapshot =
          `=== GOOGLE SEARCH RESULTS ===\n` +
          serp.results.map((r) => `[${r.index}] "${r.title}" -> ${r.url}`).join("\n") +
          `\n\nInstruction: Choose the best organic result link. You can navigate directly using {"action":"navigate","url":"<URL>"} or click its title.`;
        console.log(`   📄 Distilled Google SERP: ${serp.results.length} clean organic results (~${Math.round(snapshot.length / 4)} tokens)`);
      }
    }

    if (!snapshot) {
      // Distill page for planner context (~20ms in-browser)
      const distilled = await distillPage(page);
      const apiData = getCapturedApiData();
      snapshot = buildPlannerSnapshot(distilled, apiData);
      if (distilled.interactive.length > 0 || distilled.content.length > 50) {
        console.log(`   📄 Distilled: ${distilled.interactive.length} elements, ~${Math.round(distilled.content.length / 4)} tokens`);
      }
    }

    process.stdout.write(`   🤔 Planning...\r`);
    sessionMetrics.tier2++;

    let plan: any;
    try {
      const c: any = await withTimeout(
        localClient.chat.completions.create({
          model: cfg.llm.modelId,
          messages: [
            { role: "system", content: PLANNER_PROMPT },
            {
              role: "user",
              content: `Goal: "${goal}"\nPage: "${title}" (${url})${
                snapshot ? `\n\nPage Snapshot:\n${snapshot}` : ""
              }\nHistory:\n${
                history.length ? history.map((h, i) => `${i + 1}. ${h}`).join("\n") : "None"
              }${contextNote}`,
            },
          ],
          response_format: { type: "json_object" },
          temperature: cfg.llm.temperature,
        }),
        cfg.llm.stepTimeoutMs,
        "Planner"
      );
      plan = JSON.parse(cleanJson(c?.choices?.[0]?.message?.content ?? "{}"));
    } catch (e: any) {
      if (e?.message?.includes("timed out")) {
        console.warn(`\n⚠️ Planner timed out at step ${step}. Stopping.`);
        break;
      }
      console.warn(`\n⚠️ Planner error: ${e?.message}`);
      plan = { action: "act", instruction: goal };
    }

    process.stdout.write("                                     \r");
    if (!plan?.action) {
      console.log("⚠️ No action. Stopping.");
      break;
    }

    const actionKey = `${plan.action}:${plan.instruction || plan.url || ""}`;
    if (actionKey === lastActionKey && plan.action !== "done" && plan.action !== "wait") {
      console.log(`⚠️ Loop detected (same action repeated). Stopping.`);
      logSessionMetrics();
      return undefined;
    }
    lastActionKey = actionKey;

    if (plan.action === "done") {
      console.log(`\n🎉 ${plan.message || "Done!"}\n`);
      logSessionMetrics();
      if (onStep) {
        const screenshot = await captureScreenshotBase64(page);
        onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan, result: plan.message || "Done", screenshot });
      }
      return plan.message || "Done";
    }

    if (plan.action === "wait") {
      const ms = Math.min(plan.ms || 2000, 10000);
      console.log(`   ⏳ Waiting ${ms}ms...`);
      actionRecords.push({ action: "wait", url });
      if (onStep) onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan });
      await sleep(ms);
      history.push(`Waited ${ms}ms`);
      continue;
    }

    if (plan.action === "navigate") {
      let target = plan.url || "";
      if (!/^https?:\/\//i.test(target)) target = "https://" + target;
      console.log(`   🌐 ${target}`);
      history.push(`Nav → ${target}`);
      actionRecords.push({ action: "navigate", url: target });
      if (onStep) onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan });
      try {
        await navigate(page, target);
        await dismissCookies(sh, page);
      } catch (e: any) {
        console.warn(`   ⚠️ ${e?.message}`);
        history.push(`Nav failed: ${e?.message}`);
      }
      continue;
    }

    if (plan.action === "act") {
      const lowerInstruction = (plan.instruction || "").toLowerCase();

      // State Gate: Disallow media seeking/skipping on search result pages
      if (
        (url.includes("youtube.com/results") || url.includes("google.com/search")) &&
        (lowerInstruction.includes("skip") || lowerInstruction.includes("seek") || lowerInstruction.includes("fast forward"))
      ) {
        console.log(`   ⛔ State Gate: Prevented seek/skip act on search results page. Selecting target card instead.`);
        const clickResult = await tryHeuristic(page, goal, url, history, compiledPlan || undefined);
        if (clickResult?.continueLoop) continue;
        if (clickResult?.doneMessage) return clickResult.doneMessage;
      }

      console.log(`   ⚡ "${plan.instruction}"`);
      history.push(`Act: "${plan.instruction}"`);
      actionRecords.push({ action: "act", instruction: plan.instruction, url });
      if (onStep) onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan });
      try {
        const r = await retry(() => sh.act(plan.instruction, { page }), "Act");
        const msg = r.data?.message || "Done";
        console.log(`   ✅ ${msg}`);
        history.push(`Result: ${msg}`);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await sleep(cfg.agent.postActionMs);
      } catch (e: any) {
        console.warn(`   ⚠️ ${e?.message}`);
        history.push(`Act failed: ${e?.message}`);
      }
      continue;
    }

    if (plan.action === "extract") {
      // ─── ANTI-REPEAT "ACTION DEDUP" CIRCUIT BREAKER ───
      // If previous action was extract on the exact same page with empty/failed return:
      const prevAction = actionRecords[actionRecords.length - 1];
      const isConsecutiveEmptyExtract =
        prevAction?.action === "extract" &&
        prevAction.empty &&
        prevAction.url === url;

      if (isConsecutiveEmptyExtract) {
        console.log(`   🔁 Repetitive extraction failure detected on ${url}. Activating circuit breaker.`);

        // Step A: Check for ATS link or direct ATS API
        const atsLink = await findAtsUrlOnPage(page);
        if (atsLink) {
          console.log(`   ⚡ Circuit breaker found ATS link: ${atsLink}`);
          const directData = await tryDirectAtsFetch(atsLink);
          if (directData && directData.length > 20) {
            sessionMetrics.tier1++;
            sessionMetrics.tokensSaved += 2000;
            console.log(`   🚀 Direct ATS API fetched (${directData.split("\n").length} jobs)!`);
            pinLatestExtraction(directData, url);
            const syn = await synthesize(goal, directData, url, true);
            if (syn?.answer) {
              answer = syn.answer;
              session.lastAnswer = answer;
              console.log(`\n📢 Answer:\n${answer}\n`);
              addToConversation({ role: "assistant", content: answer, label: "answer" });
              session.history.push({ ts: ts(), url, goal, result: answer.slice(0, 2000) });
              console.log(`🎉 Goal completed via Circuit Breaker ATS Fast-Path!\n`);
              logSessionMetrics();
              if (onStep) {
                const screenshot = await captureScreenshotBase64(page);
                onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan: { action: "done", message: answer }, result: answer, screenshot });
              }
              return answer;
            }
          }

          // If direct API didn't return data, navigate directly to the ATS board
          console.log(`   🌐 Navigating directly to ATS board: ${atsLink}`);
          actionRecords.push({ action: "navigate", url: atsLink });
          history.push(`Circuit breaker navigated to ATS: ${atsLink}`);
          if (onStep) onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan: { action: "navigate", url: atsLink } });
          try {
            await navigate(page, atsLink);
            await dismissCookies(sh, page);
          } catch {}
          continue;
        }

        // Step B: Check for navigation/career links on the page to click or navigate to
        const nextLink = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
          for (const l of links) {
            const href = l.href;
            const text = (l.innerText || "").toLowerCase();
            if (
              (href.includes("/jobs") || href.includes("/careers") || href.includes("/openings")) &&
              !href.includes("#") &&
              href !== window.location.href
            ) {
              return href;
            }
            if (
              text.includes("view open") ||
              text.includes("see open") ||
              text.includes("open roles") ||
              text.includes("current openings")
            ) {
              return href;
            }
          }
          return null;
        }).catch(() => null);

        if (nextLink && nextLink !== url) {
          console.log(`   🌐 Circuit breaker navigating to discovered link: ${nextLink}`);
          actionRecords.push({ action: "navigate", url: nextLink });
          history.push(`Circuit breaker navigated to: ${nextLink}`);
          if (onStep) onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan: { action: "navigate", url: nextLink } });
          try {
            await navigate(page, nextLink);
            await dismissCookies(sh, page);
          } catch {}
          continue;
        }

        // Step C: Scroll heuristic to trigger dynamic rendering
        console.log(`   📜 Circuit breaker scrolling page to reveal dynamic content...`);
        await page.evaluate(() => window.scrollBy(0, 1000)).catch(() => {});
        await sleep(1000);
        history.push(`Circuit breaker scrolled page`);
        actionRecords.push({ action: "act", instruction: "scroll", url });
        continue;
      }

      console.log(`   🔍 "${plan.instruction}"`);
      if (onStep) onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan });
      try {
        await sleep(500);
        const text = await extractText(sh, plan.instruction, page);

        if (!isExtractionValid(text)) {
          console.log(`   ⚠️ Extraction returned empty, trivial, or element ID data.`);
          history.push(`Extract returned minimal/element-ID data for "${plan.instruction}" on ${url}. Need to click into a specific result link to visit the destination site.`);
          actionRecords.push({ action: "extract", instruction: plan.instruction, url, empty: true });
          continue;
        }

        actionRecords.push({ action: "extract", instruction: plan.instruction, url, empty: false });
        console.log(`\n📄 Extracted:\n${text}\n`);
        pinLatestExtraction(text, url);

        const isFinalStep = step === cfg.agent.maxSteps;
        const syn = await synthesize(goal, text, url, isFinalStep);

        if (syn?.isComplete || isFinalStep) {
          answer = syn?.answer || text;
          session.lastAnswer = answer;
          console.log(`\n📢 Answer:\n${answer}\n`);
          addToConversation({ role: "assistant", content: answer, label: "answer" });
          session.history.push({ ts: ts(), url, goal, result: answer.slice(0, 2000) });
          console.log(`🎉 Goal completed!\n`);
          logSessionMetrics();
          if (onStep) {
            const screenshot = await captureScreenshotBase64(page);
            onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan, result: answer, screenshot });
          }
          // Auto-learn from successful extraction
          try {
            const capturedUrls = Array.from(
              (getCapturedApiData() || "").matchAll(/\[([^\]]+)\]:/g)
            ).map((m) => m[1]!);
            await autoLearnFromPage(page, url, capturedUrls);
            playbooks.recordSuccess(normalizeDomain(url));
          } catch {}
          break;
        } else {
          console.log(`   ℹ️ Extraction partial. Continuing exploration...`);
          history.push(`Extracted from ${url}: "${text.slice(0, 300)}". Result was partial/inconclusive. Continue by clicking target links.`);
        }
      } catch (e: any) {
        console.warn(`   ⚠️ ${e?.message}`);
        history.push(`Extract failed: ${e?.message}`);
        actionRecords.push({ action: "extract", instruction: plan.instruction, url, empty: true });
      }
      continue;
    }

  }

  // Auto-learn from page even if we didn't fully complete
  try {
    const finalPage = await activePage(sh, initialPage);
    const finalUrl = await finalPage.url().catch(() => "");
    if (finalUrl && finalUrl !== "about:blank") {
      const capturedUrls = Array.from(
        (getCapturedApiData() || "").matchAll(/\[([^\]]+)\]:/g)
      ).map((m) => m[1]!);
      await autoLearnFromPage(finalPage, finalUrl, capturedUrls);
    }
  } catch {}

  logSessionMetrics();
  return answer;
}

/** Helper: normalize domain from a URL */
function normalizeDomain(urlStr: string): string {
  try {
    const u = new URL(urlStr.startsWith("http") ? urlStr : `https://${urlStr}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return urlStr;
  }
}
