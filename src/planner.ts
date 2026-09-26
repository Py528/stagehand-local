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
} from "./conversation.js";
import { activePage, navigate, dismissCookies, captureScreenshotBase64 } from "./browser.js";
import type { PlanAction } from "./types.js";

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
- Multi-step Research & Deep Navigation:
  * A search results page (e.g. Google Search) is only an index of links. To answer specific questions (e.g. company job openings, career roles, product features, pricing, documentation), DO NOT extract repeatedly on the search engine page. Use "act" to CLICK the most relevant organic search result or careers link to visit the actual website (e.g. {"action":"act","instruction":"click on the Roboflow careers or jobs search result link"})!
  * Once on the company's real website or careers board, THEN use "extract" to read the actual job listings or page content.
- For video/media playback (e.g. YouTube):
  * On search results: click the video title or thumbnail to open it.
  * On the video page (/watch?v=...): you can seek to a timestamp by navigating to the URL with "&t=60s" (for 1 minute ahead) or clicking the video timeline.
  * Once the requested video is open and positioned as requested, return "done" with a concise confirmation message. Do NOT loop actions on the player.
- DO NOT repeat an action that failed or already succeeded — check history and dynamically adjust your plan.
- If you have navigated to the destination page and extracted the factual answer satisfying the goal, return "done" with the answer summary.
- Return ONLY valid JSON.`;

/** Extract and return the raw text. */
export async function extractText(sh: Stagehand, instruction: string, page: any): Promise<string> {
  const result = await retry(() => sh.extract(instruction, { page }), "Extract");
  const data = typeof result.data === "string" ? result.data : result.data?.extraction || JSON.stringify(result.data, null, 2);
  return data;
}

/** Check if extraction result is empty/trivial or just element IDs. */
export function isExtractionValid(text: string): boolean {
  if (!text || text.length < 10) return false;
  // Common empty patterns from Stagehand
  const cleaned = text.replace(/[\s{}":\[\]]/g, "").replace(/extraction/gi, "");
  if (cleaned.length < 5) return false;

  // If text is purely a list of element IDs like "0-5710, 0-5967, 0-5999" without real content
  const idOnlyPattern = /^(\s*\d+-\d+\s*[,;\s]*)+$/;
  if (idOnlyPattern.test(text.trim())) return false;

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
  const extracted = await extractText(sh, question, page);

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
    result?: string;
    screenshot?: string;
  }): void;
}

export async function runAgent(
  goal: string,
  sh: Stagehand,
  initialPage: any,
  onStep?: AgentStepCallback
): Promise<string | undefined> {
  console.log(`\n🤖 Agent: "${goal}"\n`);
  const history: string[] = [];
  let answer: string | undefined;
  let lastActionKey = "";

  const context = getConversationContext();
  const contextNote = context ? `\nSession context (prior data/conversation):\n${context.slice(0, 2000)}` : "";

  for (let step = 1; step <= cfg.agent.maxSteps; step++) {
    const page = await activePage(sh, initialPage);
    const url = await page.url().catch(() => "about:blank");
    const title = await page.title().catch(() => "");

    console.log(`[${step}/${cfg.agent.maxSteps}] 📍 "${title || "Blank"}" (${url})`);
    process.stdout.write(`   🤔 Planning...\r`);

    let plan: any;
    try {
      const c: any = await withTimeout(
        localClient.chat.completions.create({
          model: cfg.llm.modelId,
          messages: [
            { role: "system", content: PLANNER_PROMPT },
            {
              role: "user",
              content: `Goal: "${goal}"\nPage: "${title}" (${url})\nHistory:\n${
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
      return undefined;
    }
    lastActionKey = actionKey;

    if (plan.action === "done") {
      console.log(`\n🎉 ${plan.message || "Done!"}\n`);
      if (onStep) {
        const screenshot = await captureScreenshotBase64(page);
        onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan, result: plan.message || "Done", screenshot });
      }
      return plan.message || "Done";
    }

    if (plan.action === "wait") {
      const ms = Math.min(plan.ms || 2000, 10000);
      console.log(`   ⏳ Waiting ${ms}ms...`);
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
      console.log(`   ⚡ "${plan.instruction}"`);
      history.push(`Act: "${plan.instruction}"`);
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
      console.log(`   🔍 "${plan.instruction}"`);
      if (onStep) onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan });
      try {
        await sleep(500);
        const text = await extractText(sh, plan.instruction, page);

        if (!isExtractionValid(text)) {
          console.log(`   ⚠️ Extraction returned empty, trivial, or element ID data.`);
          history.push(`Extract returned minimal/element-ID data for "${plan.instruction}" on ${url}. Need to click into a specific result link to visit the destination site.`);
          continue;
        }

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
          if (onStep) {
            const screenshot = await captureScreenshotBase64(page);
            onStep({ step, maxSteps: cfg.agent.maxSteps, title, url, plan, result: answer, screenshot });
          }
          break;
        } else {
          console.log(`   ℹ️ Extraction partial. Continuing exploration...`);
          history.push(`Extracted from ${url}: "${text.slice(0, 300)}". Result was partial/inconclusive. Continue by clicking target links.`);
        }
      } catch (e: any) {
        console.warn(`   ⚠️ ${e?.message}`);
        history.push(`Extract failed: ${e?.message}`);
      }
      continue;
    }
  }

  return answer;
}
