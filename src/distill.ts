/**
 * distill.ts — DOM Distillation & Network Interception
 *
 * Three strategies to slash token counts on local LLMs:
 * 1. In-browser DOM distillation  → ~1000–2000 tokens (vs 8k–25k from Stagehand's AXTree)
 * 2. Network API interception     → ~200–600 tokens  (bypasses DOM entirely)
 * 3. Fast extract via distilled   → uses (1) or (2) to answer without full Stagehand extract
 */

import { localClient } from "./llm.js";
import { cfg } from "./config.js";
import { cleanJson, withTimeout } from "./utils.js";
import MiniSearch from "minisearch";

/* ══════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════ */

export interface DistilledPage {
  /** Compact semantic markdown of page content */
  content: string;
  /** Interactive elements list: [idx] <tag> label */
  interactive: string[];
  /** Individual semantic text blocks for search ranking */
  blocks?: string[];
}

export interface GoogleSerpSummary {
  aiOverview?: string;
  results: Array<{ title: string; url: string; index: number }>;
}

/* ══════════════════════════════════════════════════════════════
   Network API Response Interceptor
   
   Modern SPAs (YouTube, GitHub, dashboards) fetch structured 
   JSON from internal endpoints. Intercepting these payloads
   gives us clean data at ~200-500 tokens instead of parsing
   the rendered DOM at 20,000+ tokens.
   ══════════════════════════════════════════════════════════════ */

const API_PATTERNS = [
  "/api/",
  "/v1/",
  "/v2/",
  "/v3/",
  "/graphql",
  "/_next/data/",
  "/youtubei/",
  "/browse/",
  "/search",
  ".json",
];

const MAX_CAPTURE_BYTES = 8000;
const MAX_CAPTURES = 15;

const capturedResponses = new Map<string, string>();
const listenedPages = new WeakSet<object>();

const INIT_SCRIPT = `
(function() {
  if (window.__stagehand_api_hooked) return;
  window.__stagehand_api_hooked = true;
  window.__stagehand_api_cache = window.__stagehand_api_cache || [];

  var API_PATTERNS = ["/api/", "/v1/", "/v2/", "/v3/", "/graphql", "/_next/data/", "/youtubei/", "/browse/", "/search", ".json"];
  var MAX_CAPTURE_BYTES = 8000;
  var MAX_CAPTURES = 15;

  function shouldCapture(url) {
    if (!url || typeof url !== "string") return false;
    for (var i = 0; i < API_PATTERNS.length; i++) {
      if (url.indexOf(API_PATTERNS[i]) !== -1) return true;
    }
    return false;
  }

  function record(url, body) {
    try {
      if (!body || body.length < 50 || body.length > 200000) return;
      if (window.__stagehand_api_cache.length >= MAX_CAPTURES) {
        window.__stagehand_api_cache.shift();
      }
      window.__stagehand_api_cache.push({
        url: url.slice(0, 300),
        data: body.slice(0, MAX_CAPTURE_BYTES)
      });
    } catch (e) {}
  }

  try {
    var origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function() {
        var args = arguments;
        return origFetch.apply(this, args).then(function(res) {
          try {
            var url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
            if (shouldCapture(url)) {
              var clone = res.clone();
              clone.text().then(function(text) {
                record(url, text);
              }).catch(function() {});
            }
          } catch (e) {}
          return res;
        });
      };
    }
  } catch (e) {}

  try {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      try {
        this.__stagehand_url = typeof url === "string" ? url : String(url);
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      try {
        var self = this;
        this.addEventListener("load", function() {
          try {
            var url = self.__stagehand_url || "";
            if (shouldCapture(url) && self.responseText) {
              record(url, self.responseText);
            }
          } catch (e) {}
        });
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  } catch (e) {}
})();
`;

/** Attach a response listener to a page (idempotent — safe to call repeatedly). */
export function setupApiInterceptor(page: any): void {
  if (!page || listenedPages.has(page)) return;
  listenedPages.add(page);

  // In Stagehand v4, page.on() only supports "console", so we use addInitScript
  // which works cleanly on both Stagehand Page and Playwright Page.
  if (typeof page.addInitScript === "function") {
    page.addInitScript(INIT_SCRIPT).catch(() => {});
  }
}

/** Clear captured API data (call on navigation to a new page). */
export function clearCapturedApi(): void {
  capturedResponses.clear();
}

/** Get all captured API response data as a formatted string, or null if none captured. */
export function getCapturedApiData(): string | null {
  if (capturedResponses.size === 0) return null;

  const parts: string[] = [];
  let total = 0;
  for (const [url, data] of capturedResponses) {
    if (total > 10_000) break;
    try {
      const path = new URL(url).pathname;
      const entry = `[${path}]:\n${data.slice(0, 3000)}`;
      parts.push(entry);
      total += entry.length;
    } catch {
      parts.push(data.slice(0, 3000));
      total += 3000;
    }
  }
  return parts.join("\n\n");
}

/* ══════════════════════════════════════════════════════════════
   In-Browser DOM Distillation
   
   Runs entirely inside the browser via page.evaluate() — zero
   network overhead, ~10-30ms execution time.  Produces:
   - Headings (h1-h4) as markdown
   - Interactive elements with labels, types, ARIA attributes
   - Text content blocks (paragraphs, list items, table cells)
   - Captured in-browser API cache & SPA state
   
   Output is capped at ~1500 tokens (6000 chars).
   ══════════════════════════════════════════════════════════════ */

export async function distillPage(page: any): Promise<DistilledPage> {
  try {
    const res = await Promise.race([
      page.evaluate(() => {
        const headings: string[] = [];
        const interactive: string[] = [];
        const textBlocks: string[] = [];
        const seen = new Set<string>();
        let iIdx = 0;

        // ── Headings ──
        document.querySelectorAll("h1, h2, h3, h4").forEach((el) => {
          try {
            const s = window.getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") return;
          } catch {
            return;
          }
          const t = el.textContent?.trim();
          if (t && t.length > 1 && t.length < 200) {
            headings.push(
              "#".repeat(parseInt(el.tagName[1] || "1")) + " " + t.slice(0, 120)
            );
          }
        });

        // ── Interactive Elements ──
        const iSel = [
          "button",
          "input",
          "select",
          "textarea",
          "a[href]",
          '[role="button"]',
          '[role="link"]',
          '[role="tab"]',
          '[role="menuitem"]',
          '[role="option"]',
          '[role="search"]',
          '[role="combobox"]',
        ].join(", ");

        document.querySelectorAll(iSel).forEach((el) => {
          if (iIdx >= 50) return;
          try {
            const s = window.getComputedStyle(el);
            if (
              s.display === "none" ||
              s.visibility === "hidden" ||
              s.opacity === "0"
            )
              return;
          } catch {
            return;
          }

          const tag = el.tagName.toLowerCase();
          const raw = (el.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 60);
          const aria = el.getAttribute("aria-label") || "";
          const ph = (el as HTMLInputElement).placeholder || "";
          const type = (el as HTMLInputElement).type || "";

          const label = aria || raw || ph;
          if (!label || label.length < 2) return;

          let d = `[${iIdx}] <${tag}`;
          if (type && !["submit", "button", "hidden"].includes(type))
            d += ` type="${type}"`;
          d += `> ${label}`;
          interactive.push(d);
          iIdx++;
        });

        // ── Text Content ──
        // ── Text Content ──
        const contentSelector = [
          "li",
          '[role="listitem"]',
          "article",
          "tr",
          "p",
          "td",
          "th",
          "figcaption",
          "blockquote",
          '[role="article"]',
          "dt",
          "dd",
          "pre",
          '[class*="job"]',
          '[class*="career"]',
          '[class*="position"]',
          '[class*="role"]',
          '[class*="opening"]',
        ].join(", ");

        document.querySelectorAll(contentSelector).forEach((el) => {
          if (textBlocks.length >= 150) return;
          try {
            const s = window.getComputedStyle(el);
            if (
              s.display === "none" ||
              s.visibility === "hidden" ||
              s.opacity === "0"
            )
              return;
          } catch {
            return;
          }

          // Skip navigation or footer noise when extracting main content
          const noise = el.closest("nav, footer, script, style, noscript");
          if (noise) return;

          // Only extract terminal/leaf text (elements where children.length === 0 or standard list items)
          const isStandardListItem =
            el.tagName.toLowerCase() === "li" ||
            el.getAttribute("role") === "listitem";
          const isLeaf = el.children.length === 0;
          if (!isLeaf && !isStandardListItem) return;

          const t = el.textContent?.trim().replace(/\s+/g, " ");
          if (!t || t.length < 10 || t.length > 300) return;

          const key = t.slice(0, 100);
          if (seen.has(key)) return;
          seen.add(key);
          textBlocks.push(t);
        });

        // ── Assemble ──
        let md = "";
        if (headings.length) md += headings.join("\n") + "\n\n";
        if (textBlocks.length) md += textBlocks.join("\n");

        // ── Harvest in-browser API cache and SPA data globals ──
        const apiEntries: Array<{ url: string; data: string }> = [];
        const win = window as any;
        if (win.__stagehand_api_cache && Array.isArray(win.__stagehand_api_cache)) {
          for (const item of win.__stagehand_api_cache) {
            if (item && item.url && item.data) {
              apiEntries.push(item);
            }
          }
        }
        if (win.__NEXT_DATA__?.props) {
          try {
            apiEntries.push({
              url: "window.__NEXT_DATA__",
              data: JSON.stringify(win.__NEXT_DATA__.props).slice(0, 6000),
            });
          } catch {}
        }

        return { content: md.slice(0, 12000), interactive, blocks: textBlocks, apiEntries };
      }),
      // Safety timeout — never block more than 3s on a janky page
      new Promise<{ content: string; interactive: string[]; blocks?: string[]; apiEntries?: Array<{ url: string; data: string }> }>((r) =>
        setTimeout(() => r({ content: "", interactive: [], blocks: [] }), 3000)
      ),
    ]);

    if (res.apiEntries?.length) {
      for (const entry of res.apiEntries) {
        if (capturedResponses.size < MAX_CAPTURES) {
          capturedResponses.set(entry.url, entry.data);
        }
      }
    }

    return { content: res.content, interactive: res.interactive, blocks: res.blocks || [] };
  } catch {
    return { content: "", interactive: [], blocks: [] };
  }
}

/* ══════════════════════════════════════════════════════════════
   MiniSearch Pre-Extraction Filter
   
   Indexes terminal distilled text blocks and ranks them against
   the instruction query to eliminate context bloat. Rather than
   dumping 35+ job cards into the LLM, this delivers the top 5-8
   most relevant blocks (~180 tokens) with high relevance.
   ══════════════════════════════════════════════════════════════ */

const STOP_WORDS = new Set([
  "find",
  "extract",
  "all",
  "from",
  "for",
  "the",
  "and",
  "with",
  "what",
  "are",
  "is",
  "to",
  "in",
  "on",
  "of",
  "a",
  "an",
  "tell",
  "me",
  "does",
  "have",
  "page",
  "specifically",
  "looking",
  "roles",
]);

export function rankDistilledBlocks(
  blocks: string[],
  query: string,
  topK = 8
): string[] {
  if (!blocks || blocks.length === 0) return [];
  if (blocks.length <= topK) return blocks;

  const lowerQuery = query.toLowerCase();
  const isBroadExtraction =
    lowerQuery.includes("all") ||
    lowerQuery.includes("list") ||
    lowerQuery.includes("every") ||
    lowerQuery.includes("openings") ||
    lowerQuery.includes("roles");

  // For broad/list queries, expand to up to 30 blocks (~800 tokens)
  const effectiveTopK = isBroadExtraction ? Math.min(blocks.length, 30) : topK;

  try {
    const miniSearch = new MiniSearch({
      fields: ["text"],
      storeFields: ["text", "id"],
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
      },
    });

    const documents = blocks.map((text, idx) => ({ id: idx, text }));
    miniSearch.addAll(documents);

    // Expand role/job queries with role synonyms so actual job titles match
    let queryExpanded = query;
    if (/job|role|career|position|opening/i.test(query)) {
      queryExpanded += " engineer developer scientist lead remote manager analyst designer";
    }

    // Strip stop-words and punctuation from query
    const cleanTokens = queryExpanded
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    const cleanedQuery = cleanTokens.join(" ");
    if (!cleanedQuery.trim()) return blocks.slice(0, effectiveTopK);

    const searchResults = miniSearch.search(cleanedQuery);
    if (searchResults && searchResults.length > 0) {
      const topResults = searchResults.slice(0, effectiveTopK).map((r) => r.text as string);
      const totalChars = topResults.reduce((s, r) => s + r.length, 0);
      // Safety floor: if ranked results are trivial (< 200 chars), fall back to top blocks
      if (totalChars > 200 || blocks.length <= effectiveTopK) {
        return topResults;
      }
    }
  } catch {
    /* fallback to slice if MiniSearch throws */
  }

  return blocks.slice(0, effectiveTopK);
}

/* ══════════════════════════════════════════════════════════════
   Fast Extract via Distilled Content
   
   Instead of Stagehand's full pipeline (AXTree → 20k tokens →
   LLM → Zod validation), this sends ~180-500 tokens of distilled
   content to the LLM for extraction. ~10x faster prefill.
   
   Returns null if the distilled content doesn't have enough 
   data — caller should fall back to scoped extract.
   ══════════════════════════════════════════════════════════════ */

export async function fastExtract(
  distilled: DistilledPage,
  instruction: string,
  apiData: string | null
): Promise<string | null> {
  let context = "";
  if (apiData) context += `API Data:\n${apiData.slice(0, 4000)}\n\n`;

  // Pre-filter content blocks using MiniSearch so Gemma 4 evaluates ~180 tokens
  let contentText = distilled.content;
  const blocks =
    distilled.blocks && distilled.blocks.length > 0
      ? distilled.blocks
      : distilled.content
          .split("\n")
          .map((b) => b.trim())
          .filter((b) => b.length >= 10);

  if (blocks.length > 6) {
    const ranked = rankDistilledBlocks(blocks, instruction, 6);
    if (ranked.length > 0) {
      contentText = ranked.join("\n");
      process.stdout.write(
        `   🔍 MiniSearch filtered: ${blocks.length} blocks → ${ranked.length} ranked blocks (~${Math.round(contentText.length / 4)} tokens)\n`
      );
    }
  }

  if (contentText)
    context += `Page Content:\n${contentText.slice(0, 4000)}\n\n`;
  if (distilled.interactive.length)
    context +=
      `Interactive Elements:\n${distilled.interactive.slice(0, 20).join("\n")}\n`;

  if (context.length < 50) return null;

  try {
    process.stdout.write(`   ⚡ Fast extract...                          \r`);
    const c: any = await withTimeout(
      localClient.chat.completions.create({
        model: cfg.llm.modelId,
        messages: [
          {
            role: "system",
            content: `You extract data from page content. Respond ONLY with JSON: {"extraction": "<extracted data as string>"}
If the content does not contain what is requested, return {"extraction": ""}`,
          },
          { role: "user", content: `Extract: "${instruction}"\n\n${context}` },
        ],
        response_format: { type: "json_object" as const },
        temperature: cfg.llm.temperature,
      }),
      cfg.llm.stepTimeoutMs,
      "FastExtract"
    );

    const raw = c?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(cleanJson(raw));
    const val = parsed?.extraction ?? parsed?.data ?? "";
    if (typeof val === "string" && val.length > 10) {
      process.stdout.write(
        `   ⚡ Fast extract succeeded (${val.length} chars)     \n`
      );
      return val;
    }
    if (typeof val === "object" && val !== null) {
      const str = JSON.stringify(val, null, 2);
      if (str.length > 10) {
        process.stdout.write(
          `   ⚡ Fast extract succeeded (${str.length} chars)     \n`
        );
        return str;
      }
    }
  } catch {
    /* fall through */
  }
  process.stdout.write(
    `   ↩️  Fast extract insufficient, falling back...  \r`
  );
  return null;
}

/* ══════════════════════════════════════════════════════════════
   Planner Snapshot Builder
   
   Produces a compact page representation (~500-1000 tokens)
   for the planner LLM. This is the single biggest improvement:
   the planner currently only sees "Page: title (url)" and has
   to guess what's on the page. With the snapshot, it knows
   exactly what buttons, links, and content are available.
   ══════════════════════════════════════════════════════════════ */

export function buildPlannerSnapshot(
  distilled: DistilledPage,
  apiData: string | null,
  maxChars = 4000
): string {
  const parts: string[] = [];
  if (distilled.interactive.length) {
    parts.push(
      "Interactive Elements:\n" +
        distilled.interactive.slice(0, 30).join("\n")
    );
  }
  if (distilled.content) {
    parts.push("Page Content:\n" + distilled.content.slice(0, 2000));
  }
  if (apiData) {
    parts.push("API Data:\n" + apiData.slice(0, 800));
  }
  let s = parts.join("\n\n");
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return s;
}

/* ══════════════════════════════════════════════════════════════
   Dedicated Google SERP Distiller
   
   Parses Google Search results directly to extract:
   1. Google AI Overview / Featured Snippet (if visible)
   2. Clean Organic Results (Title + URL only)
   
   Slashes SERP tokens from ~800 to ~100-150 and enables 0-hop
   factual completions.
   ══════════════════════════════════════════════════════════════ */

export async function distillGoogleSearch(page: any): Promise<GoogleSerpSummary> {
  try {
    return await Promise.race([
      page.evaluate(() => {
        // 1. Extract Google AI Overview / Featured Snippet (if already visible)
        let aiOverview: string | undefined;

        // Check AI Overview heading / container
        const aioHeading = Array.from(document.querySelectorAll("h1, h2, div, span")).find(
          (el) => el.textContent?.trim() === "AI Overview"
        );
        if (aioHeading) {
          let parent = aioHeading.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!parent) break;
            const text = (parent as HTMLElement).innerText?.trim();
            if (text && text.length > 80 && text !== "AI Overview") {
              aiOverview = text.slice(0, 1500);
              break;
            }
            parent = parent.parentElement;
          }
        }

        // Fallback: Check standard Featured Snippet box
        if (!aiOverview) {
          const snippetBox = document.querySelector(
            'div[data-attrid="wa:/description"], div.LGOjhe, [data-async-context*="overview"]'
          );
          if (snippetBox) {
            aiOverview = (snippetBox as HTMLElement).innerText.trim().slice(0, 1000);
          }
        }

        // 2. Extract Clean Organic Results (Title + Target URL)
        const results: Array<{ title: string; url: string; index: number }> = [];
        const searchBlocks = document.querySelectorAll("#search div.g, #search div[data-hveid], #rso div.g");
        let idx = 1;

        for (const block of Array.from(searchBlocks)) {
          const anchor = block.querySelector('a[href^="http"]:not([href*="google.com"])') as HTMLAnchorElement | null;
          const heading = block.querySelector("h3");
          if (anchor && heading && heading.textContent) {
            const title = heading.textContent.trim();
            const url = anchor.href;
            if (url && !results.some((r) => r.url === url) && title.length > 2) {
              results.push({ index: idx++, title, url });
            }
          }
          if (results.length >= 7) break;
        }

        // Fallback if specific searchBlocks didn't catch links
        if (results.length === 0) {
          const anchors = document.querySelectorAll('#search a[href^="http"]:not([href*="google.com"])');
          for (const el of Array.from(anchors)) {
            const heading = el.querySelector("h3");
            if (heading && heading.textContent) {
              const title = heading.textContent.trim();
              const url = (el as HTMLAnchorElement).href;
              if (url && !results.some((r) => r.url === url) && title.length > 2) {
                results.push({ index: idx++, title, url });
              }
            }
            if (results.length >= 7) break;
          }
        }

        return { aiOverview, results };
      }),
      new Promise<GoogleSerpSummary>((r) => setTimeout(() => r({ results: [] }), 2500)),
    ]);
  } catch {
    return { results: [] };
  }
}

