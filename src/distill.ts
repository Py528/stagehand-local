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

/* ══════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════ */

export interface DistilledPage {
  /** Compact semantic markdown of page content */
  content: string;
  /** Interactive elements list: [idx] <tag> label */
  interactive: string[];
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
        document
          .querySelectorAll(
            'p, li, td, th, figcaption, blockquote, [role="article"], [role="listitem"], dt, dd, pre'
          )
          .forEach((el) => {
            if (textBlocks.length >= 40) return;
            const t = el.textContent?.trim().replace(/\s+/g, " ");
            if (!t || t.length < 15) return;
            try {
              const s = window.getComputedStyle(el);
              if (s.display === "none" || s.visibility === "hidden") return;
            } catch {
              return;
            }
            const key = t.slice(0, 80);
            if (seen.has(key)) return;
            seen.add(key);
            textBlocks.push(t.slice(0, 250));
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

        return { content: md.slice(0, 6000), interactive, apiEntries };
      }),
      // Safety timeout — never block more than 3s on a janky page
      new Promise<{ content: string; interactive: string[]; apiEntries?: Array<{ url: string; data: string }> }>((r) =>
        setTimeout(() => r({ content: "", interactive: [] }), 3000)
      ),
    ]);

    if (res.apiEntries?.length) {
      for (const entry of res.apiEntries) {
        if (capturedResponses.size < MAX_CAPTURES) {
          capturedResponses.set(entry.url, entry.data);
        }
      }
    }

    return { content: res.content, interactive: res.interactive };
  } catch {
    return { content: "", interactive: [] };
  }
}

/* ══════════════════════════════════════════════════════════════
   Fast Extract via Distilled Content
   
   Instead of Stagehand's full pipeline (AXTree → 20k tokens →
   LLM → Zod validation), this sends ~1500 tokens of distilled
   content to the LLM for extraction. ~10x faster prefill.
   
   Returns null if the distilled content doesn't have enough 
   data — caller should fall back to full Stagehand extract.
   ══════════════════════════════════════════════════════════════ */

export async function fastExtract(
  distilled: DistilledPage,
  instruction: string,
  apiData: string | null
): Promise<string | null> {
  let context = "";
  if (apiData) context += `API Data:\n${apiData.slice(0, 4000)}\n\n`;
  if (distilled.content)
    context += `Page Content:\n${distilled.content.slice(0, 4000)}\n\n`;
  if (distilled.interactive.length)
    context +=
      `Interactive Elements:\n${distilled.interactive.slice(0, 30).join("\n")}\n`;

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
  maxChars = 2500
): string {
  const parts: string[] = [];
  if (distilled.interactive.length) {
    parts.push(
      "Interactive Elements:\n" +
        distilled.interactive.slice(0, 25).join("\n")
    );
  }
  if (distilled.content) {
    parts.push("Page Content:\n" + distilled.content.slice(0, 1200));
  }
  if (apiData) {
    parts.push("API Data:\n" + apiData.slice(0, 800));
  }
  let s = parts.join("\n\n");
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return s;
}
