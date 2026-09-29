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
  resetSession,
  logSessionMetrics,
  validateAndResolveAttachments,
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
import {
  tokenise,
  findBestTrace,
  recordTrace,
  buildReplaySteps,
  markReplaySuccess,
  markReplayFail,
  REPLAY_THRESHOLD,
  REPLAY_THRESHOLD_STRUCTURAL,
  type TraceStep,
} from "./trace.js";

export const PLANNER_PROMPT = `You are an autonomous web agent planner controlling a real browser.
Given the user goal, the current page state, action history, and session context, decide ONE next action.

Available actions:
1. {"action":"navigate","url":"https://..."}          — go to a URL directly
2. {"action":"act","instruction":"..."}               — click/type/press on an element (be PRECISE)
3. {"action":"extract","instruction":"..."}           — pull data from the current page
4. {"action":"wait","ms":2000}                        — pause (max 10000ms)
5. {"action":"done","message":"final answer here"}    — task complete, include full answer

═══ ACT INSTRUCTION RULES (critical — vague instructions cause failures) ═══
• ALWAYS reference a VISIBLE element from the Page Snapshot. Never invent element labels.
• Format: verb + exact visible text or ARIA label. Examples:
    ✓ "click the button labeled 'Accept All Cookies'"
    ✓ "type 'software engineer' into the search input field"
    ✓ "click the link 'Anti-Hero (Official Music Video)' in the search results list"
    ✗ "click the video"  ← too vague
    ✗ "click submit"     ← use exact visible label from snapshot
• For forms: fill fields one at a time. Use "type '...' into the <label> field".
• For navigation inside a page: use "click the link/button '<exact text>'" not navigate.

═══ SEARCH & NAVIGATION ═══
• For search queries, navigate DIRECTLY to the search URL (never load the homepage first):
    YouTube:  https://www.youtube.com/results?search_query=crown+txt
    Google:   https://www.google.com/search?q=roboflow+careers&hl=en
    GitHub:   https://github.com/search?q=...&type=repositories
• Include ALL entity keywords in queries (artist, company, product name). Never truncate.
• A search results page is an INDEX — do NOT extract from it. Click through to the target page.
• On Google results: navigate directly to the company URL OR act to click the organic result.

═══ VIDEO / MEDIA ═══
• YouTube search results → click the video whose title best matches.
• On /watch?v=...: seek to a timestamp by appending &t=<seconds>s to the URL.
• Once the video is playing/loaded → return "done" immediately. Do NOT loop on the player.

═══ FAILURE RECOVERY (mandatory when history shows repeated failures) ═══
• If an act failed: read the snapshot carefully — find the EXACT element label and retry once.
• If extract returned empty twice on the same URL: navigate to a deeper page or try a different selector.
• If you are stuck (3+ steps with no progress): change strategy completely — try a different URL, a different search query, or a direct API shortcut.
• Never repeat the exact same failed action. Every step must differ from the one before it.

═══ DONE CRITERIA ═══
• Return "done" ONLY when the factual answer or the requested action is confirmed complete.
• For info tasks: include the answer text in the "message" field.
• For media/navigation tasks: confirm what was opened/played.
• Return ONLY valid JSON. No markdown, no explanation outside the JSON object.`;

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

  // Precondition Validation: Verify any referenced attachments exist before a single planner step runs
  const attachCheck = await validateAndResolveAttachments(goal);
  if (!attachCheck.ok) {
    const errorMsg = attachCheck.error || "Missing referenced attachment";
    console.error(`\n❌ Precondition Failed: ${errorMsg}\n`);
    if (onStep) {
      onStep({
        step: 1,
        maxSteps: cfg.agent.maxSteps,
        title: "Precondition Check",
        url: "about:blank",
        plan: { action: "done", message: errorMsg },
        result: errorMsg,
      });
    }
    session.lastAnswer = errorMsg;
    addToConversation({ role: "assistant", content: errorMsg, label: "answer" });
    return errorMsg;
  }
  goal = attachCheck.resolvedInput;

  resetSession();        // clear prior task context so it doesn't bleed into this run
  resetAdSkipState();

  // Collect steps for trace recording at end of run
  const runStartMs = Date.now();
  const currentRunSteps: TraceStep[] = [];

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

  // ─── TIER 0.5: Trace Memory Replay (<50ms, ~0 tokens) ───
  // Check if we have a stored execution trace for a similar goal that can be replayed
  try {
    const service = compiledPlan?.service ?? "generic";
    const intent = compiledPlan?.intent ?? "general_navigate";
    const goalTokens = tokenise(goal);
    const traceMatch = findBestTrace(service, intent, goalTokens);

    if (traceMatch && traceMatch.score >= REPLAY_THRESHOLD_STRUCTURAL) {
      const isStructural = traceMatch.score < REPLAY_THRESHOLD;
      console.log(`\n   🧠 Trace Memory Hit! Score=${traceMatch.score.toFixed(2)} [${isStructural ? "structural" : "exact"}] (${traceMatch.trace.id})`);
      console.log(`   📖 Replaying ${traceMatch.trace.steps.length}-step trace from "${traceMatch.trace.goal}"`);
      if (Object.keys(traceMatch.substitutions).length > 0) {
        console.log(`   🔄 Substitutions: ${JSON.stringify(traceMatch.substitutions)}`);
      }

      const replaySteps = buildReplaySteps(traceMatch);
      const replayPage = await activePage(sh, initialPage);
      let replaySuccess = false;
      let replayAnswer: string | undefined;

      for (let rIdx = 0; rIdx < replaySteps.length; rIdx++) {
        const rStep = replaySteps[rIdx];
        if (!rStep) continue;

        const rUrl = await replayPage.url().catch(() => "about:blank");
        const rTitle = await replayPage.title().catch(() => "");
        const stepMs = Date.now();

        try {
          if (rStep.action === "navigate" && rStep.targetUrl) {
            console.log(`   [R${rIdx + 1}] 🌐 ${rStep.targetUrl}`);
            await navigate(replayPage, rStep.targetUrl);
            await dismissCookies(sh, replayPage);
            if (onStep) onStep({ step: rIdx + 1, maxSteps: replaySteps.length, title: rTitle, url: rUrl, plan: { action: "navigate", url: rStep.targetUrl } });

          } else if (rStep.action === "act" && rStep.instruction) {
            console.log(`   [R${rIdx + 1}] ⚡ "${rStep.instruction}"`);
            const r = await retry(() => sh.act(rStep.instruction!, { page: replayPage }), "ReplayAct");
            const msg = r.data?.message || "Done";
            console.log(`   ✅ ${msg}`);
            await replayPage.waitForLoadState("domcontentloaded").catch(() => {});
            await sleep(cfg.agent.postActionMs);
            if (onStep) onStep({ step: rIdx + 1, maxSteps: replaySteps.length, title: rTitle, url: rUrl, plan: { action: "act", instruction: rStep.instruction } });

          } else if (rStep.action === "extract") {
            const instr = rStep.extractInstruction || "extract main content";
            console.log(`   [R${rIdx + 1}] 🔍 "${instr}"`);
            const text = await extractText(sh, instr, replayPage);
            if (isExtractionValid(text)) {
              pinLatestExtraction(text, rUrl);
              const finalUrl = await replayPage.url().catch(() => rUrl);
              const syn = await synthesize(goal, text, finalUrl, true);
              if (syn?.answer && syn.isComplete) {
                replayAnswer = syn.answer;
                replaySuccess = true;
                if (onStep) {
                  const sc = await captureScreenshotBase64(replayPage);
                  onStep({ step: rIdx + 1, maxSteps: replaySteps.length, title: rTitle, url: finalUrl, plan: { action: "done", message: replayAnswer }, result: replayAnswer, screenshot: sc });
                }
                break;
              }
            }

          } else if (rStep.action === "heuristic") {
            // Heuristics replay themselves naturally in the next loop iteration; break out
            replaySuccess = false;
            break;
          }

          const stepRecord: TraceStep = { action: rStep.action, url: rUrl, elapsedMs: Date.now() - stepMs };
          if (rStep.instruction !== undefined) stepRecord.instruction = rStep.instruction;
          if (rStep.targetUrl !== undefined) stepRecord.targetUrl = rStep.targetUrl;
          if (rStep.extractInstruction !== undefined) stepRecord.extractInstruction = rStep.extractInstruction;
          currentRunSteps.push(stepRecord);

        } catch (replayErr: any) {
          console.warn(`   ⚠️ Replay step ${rIdx + 1} failed: ${replayErr?.message}. Falling back to full agent.`);
          replaySuccess = false;
          break;
        }
      }

      if (replaySuccess && replayAnswer) {
        markReplaySuccess(traceMatch.trace.id);
        session.lastAnswer = replayAnswer;
        console.log(`\n📢 Answer (from trace replay):\n${replayAnswer}\n`);
        addToConversation({ role: "assistant", content: replayAnswer, label: "answer" });
        session.history.push({ ts: ts(), url: await (await activePage(sh, initialPage)).url().catch(() => ""), goal, result: replayAnswer.slice(0, 2000) });
        console.log(`🎉 Goal completed via Trace Memory Replay! (${Date.now() - runStartMs}ms)\n`);
        sessionMetrics.tier0++;
        sessionMetrics.tokensSaved += 1500;
        logSessionMetrics();
        return replayAnswer;
      } else {
        markReplayFail(traceMatch.trace.id);
        console.log(`   ⚠️ Trace replay failed — falling back to full agent pipeline.\n`);
      }
    }
  } catch {
    // Non-fatal — continue to full agent
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
  // Only inject the last 800 chars of context into each planner step — enough signal, not a token bomb
  const contextNote = context ? `\nRecent session context:\n${context.slice(-800)}` : "";

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
          // ── Auto-record trace for heuristic fast-paths ──
          try {
            currentRunSteps.push({ action: "heuristic", url, instruction: heuristic.description });
            const traceParams: import("./trace.js").TraceRecordingParams = {
              goal,
              service: compiledPlan?.service ?? "generic",
              intent: compiledPlan?.intent ?? "general_navigate",
              steps: currentRunSteps,
              answerSnippet: heuristic.doneMessage.slice(0, 500),
              answerDomain: normalizeDomain(url),
              totalMs: Date.now() - runStartMs,
              tier0: sessionMetrics.tier0,
              tier1: sessionMetrics.tier1,
              tier2: sessionMetrics.tier2,
            };
            if (compiledPlan?.targetName) traceParams.entity = compiledPlan.targetName;
            if (compiledPlan?.creatorOrOrg) traceParams.creator = compiledPlan.creatorOrOrg;
            recordTrace(traceParams);
            console.log(`   💾 Trace recorded.`);
          } catch {}
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
          currentRunSteps.push({ action: "ats_api", url, extractInstruction: goal, extractSnippet: answer.slice(0, 300) });
          // ── Auto-record trace ──
          try {
            const tp: import("./trace.js").TraceRecordingParams = {
              goal, service: compiledPlan?.service ?? "careers_ats", intent: compiledPlan?.intent ?? "info_extract",
              steps: currentRunSteps, answerSnippet: answer.slice(0, 500), answerDomain: normalizeDomain(url),
              totalMs: Date.now() - runStartMs, tier0: sessionMetrics.tier0, tier1: sessionMetrics.tier1, tier2: sessionMetrics.tier2,
            };
            if (compiledPlan?.targetName) tp.entity = compiledPlan.targetName;
            if (compiledPlan?.creatorOrOrg) tp.creator = compiledPlan.creatorOrOrg;
            recordTrace(tp);
            console.log(`   💾 Trace recorded.`);
          } catch {}
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

    // Cache distillPage for this URL — reuse the result if we already distilled earlier in this step
    // Avoids running two separate page.evaluate() calls (one in extractText, one here)
    let stepDistilled: import("./distill.js").DistilledPage | null = null;
    const stepApiData = getCapturedApiData();


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
      if (!stepDistilled) stepDistilled = await distillPage(page);
      snapshot = buildPlannerSnapshot(stepDistilled, stepApiData);
      if (stepDistilled.interactive.length > 0 || stepDistilled.content.length > 50) {
        console.log(`   📄 Distilled: ${stepDistilled.interactive.length} elements, ~${Math.round(stepDistilled.content.length / 4)} tokens`);
      }
    }

    // Trim snapshot to stay under context budget (avoid 4k+ token planner prompts)
    const MAX_SNAPSHOT_CHARS = 4000;
    if (snapshot.length > MAX_SNAPSHOT_CHARS) {
      snapshot = snapshot.slice(0, MAX_SNAPSHOT_CHARS) + "\n... [truncated]";
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
      console.log(`⚠️ Loop detected (same action repeated). Invoking recovery re-planner...`);

      // ── Recovery Re-Planner: ask the LLM to break the loop with a completely different approach ──
      try {
        const recoveryC: any = await withTimeout(
          localClient.chat.completions.create({
            model: cfg.llm.modelId,
            messages: [
              {
                role: "system",
                content: `You are a recovery planner for a stuck web agent.
The agent has attempted the SAME action twice with no progress. You must break the loop.

Goal: "${goal}"
Current Page: "${title}" (${url})
Failed Action (repeated): ${JSON.stringify(plan)}
Action History:
${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Provide ONE new action that is COMPLETELY DIFFERENT from the failed action above.
Try a different strategy: different URL, different selector wording, scroll the page, navigate to a sub-page, or use the direct search URL.
Return ONLY valid JSON action: {"action":"...","instruction":"..."|"url":"..."|"message":"..."}`,
              },
            ],
            response_format: { type: "json_object" },
            temperature: 0.3,
          }),
          cfg.llm.stepTimeoutMs,
          "RecoveryPlanner"
        );
        const recoveryPlan = JSON.parse(cleanJson(recoveryC?.choices?.[0]?.message?.content ?? "{}"));
        if (recoveryPlan?.action && recoveryPlan.action !== plan.action) {
          console.log(`   🔄 Recovery plan: ${JSON.stringify(recoveryPlan)}`);
          plan = recoveryPlan;
          lastActionKey = ""; // reset so this new plan can execute
        } else {
          console.log(`⚠️ Recovery planner returned same action. Stopping.`);
          logSessionMetrics();
          return answer;
        }
      } catch {
        console.log(`⚠️ Recovery planner failed. Stopping.`);
        logSessionMetrics();
        return answer;
      }
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
      currentRunSteps.push({ action: "navigate", url, targetUrl: target });
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
      currentRunSteps.push({ action: "act", url, instruction: plan.instruction });
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
        currentRunSteps.push({ action: "extract", url, extractInstruction: plan.instruction, extractSnippet: text.slice(0, 300) });

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
          // ── Auto-record trace ──
          try {
            const tp: import("./trace.js").TraceRecordingParams = {
              goal, service: compiledPlan?.service ?? "generic", intent: compiledPlan?.intent ?? "general_navigate",
              steps: currentRunSteps, answerSnippet: answer.slice(0, 500), answerDomain: normalizeDomain(url),
              totalMs: Date.now() - runStartMs, tier0: sessionMetrics.tier0, tier1: sessionMetrics.tier1, tier2: sessionMetrics.tier2,
            };
            if (compiledPlan?.targetName) tp.entity = compiledPlan.targetName;
            if (compiledPlan?.creatorOrOrg) tp.creator = compiledPlan.creatorOrOrg;
            recordTrace(tp);
            console.log(`   💾 Trace recorded (${currentRunSteps.length} steps).`);
          } catch {}
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

  // ── Final Verification: did we actually complete the goal? ──
  // Run ONCE after the main loop ends. If the goal is not yet complete,
  // produce one fresh recovery plan and execute it before giving up.
  if (!answer) {
    try {
      const verifyPage = await activePage(sh, initialPage);
      const verifyUrl = await verifyPage.url().catch(() => "about:blank");
      const verifyTitle = await verifyPage.title().catch(() => "");
      const verifyDistilled = await distillPage(verifyPage);
      const verifySnapshot = buildPlannerSnapshot(verifyDistilled, getCapturedApiData());

      process.stdout.write(`   🔍 Final verification — checking goal completion...\r`);
      const verifyC: any = await withTimeout(
        localClient.chat.completions.create({
          model: cfg.llm.modelId,
          messages: [
            {
              role: "system",
              content: `You are a goal-completion verifier for a web agent.
The main agent loop has ended without a confirmed answer. Check if the goal is complete based on the current page.

Goal: "${goal}"
Page: "${verifyTitle}" (${verifyUrl})
Action History:
${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Respond with JSON: {"isComplete": boolean, "answer": string, "nextAction": object|null}
- "isComplete": true if the goal is achieved on the current page.
- "answer": the answer text if complete, or empty string.
- "nextAction": if NOT complete, the single best next action to try, in the same format as the planner
  (e.g. {"action":"navigate","url":"..."} or {"action":"act","instruction":"..."} or {"action":"extract","instruction":"..."}).
  Return null if you cannot determine a useful next step.`,
            },
            {
              role: "user",
              content: `Current page snapshot:\n${verifySnapshot.slice(0, 3000)}`,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
        }),
        cfg.llm.stepTimeoutMs,
        "FinalVerify"
      );
      process.stdout.write("                                                         \r");

      const vResult = JSON.parse(cleanJson(verifyC?.choices?.[0]?.message?.content ?? "{}"));

      if (vResult?.isComplete && vResult?.answer && String(vResult.answer).length > 10) {
        answer = String(vResult.answer);
        session.lastAnswer = answer;
        console.log(`\n✅ Final verification confirmed goal complete.\n📢 Answer:\n${answer}\n`);
        addToConversation({ role: "assistant", content: answer, label: "answer" });
        session.history.push({ ts: ts(), url: verifyUrl, goal, result: answer.slice(0, 2000) });
      } else if (vResult?.nextAction?.action) {
        // Execute one more step from the verifier's plan
        console.log(`\n   🔁 Final verifier suggests one more step: ${JSON.stringify(vResult.nextAction)}`);
        const nextAct = vResult.nextAction;
        try {
          if (nextAct.action === "navigate" && nextAct.url) {
            await navigate(verifyPage, nextAct.url);
            await dismissCookies(sh, verifyPage);
            const finalExtract = await extractText(sh, goal, verifyPage);
            if (isExtractionValid(finalExtract)) {
              const finalSyn = await synthesize(goal, finalExtract, nextAct.url, true);
              if (finalSyn?.answer) {
                answer = finalSyn.answer;
                session.lastAnswer = answer;
                console.log(`\n📢 Answer (post-verify):\n${answer}\n`);
                addToConversation({ role: "assistant", content: answer, label: "answer" });
                session.history.push({ ts: ts(), url: nextAct.url, goal, result: answer.slice(0, 2000) });
              }
            }
          } else if (nextAct.action === "extract" && nextAct.instruction) {
            const finalExtract = await extractText(sh, nextAct.instruction, verifyPage);
            if (isExtractionValid(finalExtract)) {
              const finalSyn = await synthesize(goal, finalExtract, verifyUrl, true);
              if (finalSyn?.answer) {
                answer = finalSyn.answer;
                session.lastAnswer = answer;
                console.log(`\n📢 Answer (post-verify extract):\n${answer}\n`);
                addToConversation({ role: "assistant", content: answer, label: "answer" });
                session.history.push({ ts: ts(), url: verifyUrl, goal, result: answer.slice(0, 2000) });
              }
            }
          } else if (nextAct.action === "act" && nextAct.instruction) {
            await retry(() => sh.act(nextAct.instruction, { page: verifyPage }), "PostVerifyAct");
            await verifyPage.waitForLoadState("domcontentloaded").catch(() => {});
            await sleep(cfg.agent.postActionMs);
            const postActExtract = await extractText(sh, goal, verifyPage);
            if (isExtractionValid(postActExtract)) {
              const finalSyn = await synthesize(goal, postActExtract, verifyUrl, true);
              if (finalSyn?.answer) {
                answer = finalSyn.answer;
                session.lastAnswer = answer;
                console.log(`\n📢 Answer (post-verify act):\n${answer}\n`);
                addToConversation({ role: "assistant", content: answer, label: "answer" });
                session.history.push({ ts: ts(), url: verifyUrl, goal, result: answer.slice(0, 2000) });
              }
            }
          }
        } catch (verifyActErr: any) {
          console.warn(`   ⚠️ Post-verify action failed: ${verifyActErr?.message}`);
        }
      } else {
        console.log(`   ℹ️ Final verifier: goal not complete and no recovery action available.`);
      }
    } catch (verifyErr: any) {
      // Non-fatal — just log and fall through
      if (!verifyErr?.message?.includes("timed out")) {
        console.warn(`   ⚠️ Final verification error: ${verifyErr?.message}`);
      }
    }
  }

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
