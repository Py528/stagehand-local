/**
 * trace.ts — Self-Building Execution Memory
 *
 * Records successful agent runs as reusable "playbook traces". Each trace
 * captures the full execution path: service intent, query tokens, URL sequence,
 * Playwright actions, selectors, and timing.
 *
 * Traces are stored in data/traces.json and queried by the matcher before
 * hitting the LLM planner. The system builds its own heuristic rules from use
 * — no manual configuration needed.
 *
 * Storage format: { [traceId]: ExecutionTrace }
 * Match quality: 0–1.0  (>= REPLAY_THRESHOLD triggers auto-replay)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * SelectorChain — ordered from most stable to least stable.
 *
 * Replay tries each level in order. On failure, it tries the next.
 * On success with a fallback selector, it updates the chain for next time.
 *
 * Stability ranking (most → least):
 *   role+name  — semantic, survives redesigns (Playwright getByRole)
 *   text       — readable, usually stable (getByText)
 *   css        — structural but named (id, data-*) attributes
 *   xpath      — most fragile, breaks on any DOM restructure
 *
 * Example for "click first YouTube video":
 *   role:  { role: "link", name: /crown/i }         ← survives YouTube redesign
 *   css:   "ytd-video-renderer a#video-title"        ← 5-year stable YouTube selector
 *   xpath: "/html[1]/body[1]/ytd-app[1]/...//a[1]"  ← last resort, frequently breaks
 */
export interface SelectorChain {
  /** Playwright getByRole: most stable. Role + accessible name (can be regex string). */
  role?: { role: string; name: string; exact?: boolean };
  /** Playwright getByText: human-readable label. */
  text?: string;
  /** CSS selector using stable attributes (id, data-*, aria-*). Avoid class selectors. */
  css?: string;
  /** XPath — least stable. Only used as fallback. Stored for self-healing: when this
   *  fails and role/text succeeds, the chain is updated with the new element's selectors. */
  xpath?: string;
  /** Which selector was last successful (used to start from best known working level) */
  lastWorking?: "role" | "text" | "css" | "xpath";
  /** How many times this chain has been used in replay */
  replayUses?: number;
  /** ISO timestamp of last successful replay using this chain */
  lastSuccessAt?: string;
}

export interface TraceStep {
  action: "navigate" | "act" | "extract" | "wait" | "heuristic" | "ats_api";
  /** URL the page was at when this step ran */
  url: string;
  /** For act: the natural-language instruction (used as fallback if SelectorChain fails) */
  instruction?: string;
  /** For navigate: the target URL */
  targetUrl?: string;
  /** For extract: the extraction instruction + result snippet (first 300 chars) */
  extractInstruction?: string;
  extractSnippet?: string;
  /** Stable multi-level selector chain for act steps — replaces fragile single XPath */
  selectorChain?: SelectorChain;
  /** Legacy: DOM selector(s) from Stagehand AX tree (kept for backward compat) */
  selectors?: string[];
  /** Elapsed ms for this step */
  elapsedMs?: number;
}

export interface ExecutionTrace {
  id: string;
  /** Raw original goal string */
  goal: string;
  /** Normalised tokens from goal (lowercased, stop-words removed) */
  goalTokens: string[];
  /**
   * Structural skeleton of the goal — slot values replaced with SLOT placeholders.
   * e.g. "play SLOT by SLOT on youtube"
   * Used for structural matching instead of keyword overlap.
   * Populated from patterns.ts extractPattern() output.
   */
  skeleton?: string;
  /** Service determined by compiler: youtube | google | careers_ats | generic */
  service: string;
  /** Intent: media_play | info_extract | form_fill | general_navigate */
  intent: string;
  /** Primary entity name (song title, company, etc.) */
  entity?: string;
  /** Creator / artist / org name */
  creator?: string;
  /** Domain that produced the final answer */
  answerDomain: string;
  /** Ordered steps taken */
  steps: TraceStep[];
  /** Final answer snippet (first 500 chars) */
  answerSnippet: string;
  /** ISO timestamp of recording */
  recordedAt: string;
  /** Number of successful replays */
  replayCount: number;
  /** Number of failed replays (after which trace is demoted) */
  failCount: number;
  /** Total execution time ms */
  totalMs: number;
  /** Tier stats from original run */
  tier0: number;
  tier1: number;
  tier2: number;
}

export interface TraceMatch {
  trace: ExecutionTrace;
  /** Similarity score 0–1 */
  score: number;
  /** Tokens substituted for replay (old entity/creator → new) */
  substitutions: Record<string, string>;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const REPLAY_THRESHOLD = 0.72;    // minimum score to attempt replay
export const REPLAY_THRESHOLD_STRUCTURAL = 0.58; // lower threshold for same service+intent, low token overlap (structural replay)
export const DEMOTE_FAIL_RATIO = 0.4;    // demote trace if failCount/replayCount > this
export const MAX_TRACES = 500;           // prune LRU when over this
export const MAX_STEPS_PER_TRACE = 12;

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "on", "in", "at", "for", "to", "from",
  "of", "by", "with", "play", "watch", "open", "find", "search", "get",
  "go", "show", "what", "how", "is", "are", "can", "could", "please",
  "youtube", "google", "me", "its", "tell", "use", "using",
]);

// ── Storage ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "data");
const TRACES_FILE = path.join(DATA_DIR, "traces.json");

type TracesStore = Record<string, ExecutionTrace>;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadTraces(): TracesStore {
  ensureDataDir();
  if (!fs.existsSync(TRACES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(TRACES_FILE, "utf-8")) as TracesStore;
  } catch {
    return {};
  }
}

export function saveTraces(store: TracesStore): void {
  ensureDataDir();
  // Prune LRU if over limit
  let entries = Object.entries(store);
  if (entries.length > MAX_TRACES) {
    entries.sort(
      (a, b) =>
        new Date(a[1].recordedAt).getTime() - new Date(b[1].recordedAt).getTime()
    );
    const pruned: TracesStore = {};
    for (const [id, t] of entries.slice(-MAX_TRACES)) {
      pruned[id] = t;
    }
    store = pruned;
  }
  fs.writeFileSync(TRACES_FILE, JSON.stringify(store, null, 2), "utf-8");
}

// ── Token helpers ──────────────────────────────────────────────────────────

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ── Trace ID ───────────────────────────────────────────────────────────────

export function makeTraceId(
  service: string,
  intent: string,
  goalTokens: string[]
): string {
  const key = `${service}:${intent}:${goalTokens.slice(0, 5).join("+")}`;
  // Simple deterministic hash
  let h = 0;
  for (const c of key) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return `${service}_${intent}_${Math.abs(h).toString(36)}`;
}

// ── Recording ─────────────────────────────────────────────────────────────

export interface TraceRecordingParams {
  goal: string;
  service: string;
  intent: string;
  entity?: string;
  creator?: string;
  steps: TraceStep[];
  answerSnippet: string;
  answerDomain: string;
  totalMs: number;
  tier0: number;
  tier1: number;
  tier2: number;
}

export function recordTrace(params: TraceRecordingParams): ExecutionTrace {
  const store = loadTraces();
  const goalTokens = tokenise(params.goal);
  const id = makeTraceId(params.service, params.intent, goalTokens);

  const existing = store[id];
  const trace: ExecutionTrace = {
    id,
    goal: params.goal,
    goalTokens,
    service: params.service,
    intent: params.intent,
    ...(params.entity !== undefined ? { entity: params.entity } : {}),
    ...(params.creator !== undefined ? { creator: params.creator } : {}),
    answerDomain: params.answerDomain,
    steps: params.steps.slice(0, MAX_STEPS_PER_TRACE),
    answerSnippet: params.answerSnippet.slice(0, 500),
    recordedAt: existing?.recordedAt ?? new Date().toISOString(),
    replayCount: existing?.replayCount ?? 0,
    failCount: existing?.failCount ?? 0,
    totalMs: params.totalMs,
    tier0: params.tier0,
    tier1: params.tier1,
    tier2: params.tier2,
  };

  store[id] = trace;
  saveTraces(store);
  return trace;
}

// ── Match & Similarity ────────────────────────────────────────────────────

/**
 * Score a candidate trace against an incoming goal.
 *
 * Scoring rubric (adds to ~1.0):
 *   0.35  — service exact match (hard-required; returns 0 on mismatch)
 *   0.25  — intent exact match
 *   0.25  — Structural similarity:
 *             • If both have skeletons: skeleton match (exact=1.0, partial based on shared SLOT positions)
 *             • If skeleton missing: Jaccard token similarity (legacy fallback)
 *   0.10  — same answer domain bonus
 *   0.05  — replay reliability bonus
 */
export function scoreTrace(
  trace: ExecutionTrace,
  service: string,
  intent: string,
  goalTokens: string[],
  answerDomain?: string,
  incomingSkeleton?: string
): number {
  if (trace.service !== service) return 0;

  let score = 0.35;

  if (trace.intent === intent) score += 0.25;

  // Structural similarity: skeleton-based beats Jaccard for cross-entity matching
  if (incomingSkeleton && trace.skeleton) {
    // Normalize: collapse SLOT names to generic SLOT for comparison
    const normA = incomingSkeleton.replace(/\{\{[^}]+\}\}/g, "SLOT").replace(/SLOT_\w+/g, "SLOT");
    const normB = trace.skeleton.replace(/\{\{[^}]+\}\}/g, "SLOT").replace(/SLOT_\w+/g, "SLOT");
    if (normA === normB) {
      // Exact structural match — full 0.25 even if tokens are different
      score += 0.25;
    } else {
      // Partial skeleton match: count shared structural words
      const wordsA = normA.split(/\s+/);
      const wordsB = normB.split(/\s+/);
      const sharedStructure = wordsA.filter(w => w !== "SLOT" && wordsB.includes(w)).length;
      const totalStructure  = new Set([...wordsA.filter(w => w !== "SLOT"), ...wordsB.filter(w => w !== "SLOT")]).size;
      score += totalStructure > 0 ? (sharedStructure / totalStructure) * 0.25 : 0;
    }
  } else {
    // Legacy: Jaccard token similarity (no skeleton available)
    const incomingSet = new Set(goalTokens);
    const traceSet    = new Set(trace.goalTokens);
    const jaccard     = jaccardSimilarity(incomingSet, traceSet);
    score += jaccard * 0.25;
  }

  if (answerDomain && trace.answerDomain === answerDomain) score += 0.10;

  if (trace.replayCount > 0) {
    const failRatio = trace.failCount / trace.replayCount;
    if (failRatio < DEMOTE_FAIL_RATIO) {
      score += Math.min(0.05, (trace.replayCount / 20) * 0.05);
    } else {
      score -= 0.10;
    }
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Find the best matching trace for an incoming goal.
 *
 * Uses two thresholds:
 * - REPLAY_THRESHOLD (0.72): high-confidence match (same tokens, same domain)
 * - REPLAY_THRESHOLD_STRUCTURAL (0.58): structural replay (same service+intent, different tokens)
 *   → replaces entity/creator tokens in step instructions and replays the path shape
 *
 * When skeleton is available (from patterns.ts extractPattern), skeleton similarity
 * replaces Jaccard token overlap — enabling cross-entity matching:
 * "play millionaire by honey singh" matches "play crown by txt" via skeleton.
 */
export function findBestTrace(
  service: string,
  intent: string,
  goalTokens: string[],
  answerDomain?: string,
  incomingSkeleton?: string
): TraceMatch | null {
  const store = loadTraces();
  const candidates = Object.values(store);
  if (candidates.length === 0) return null;

  let best: TraceMatch | null = null;

  for (const trace of candidates) {
    const score = scoreTrace(trace, service, intent, goalTokens, answerDomain, incomingSkeleton);

    // Determine the effective threshold for this candidate
    // For structural replays (same service+intent but different tokens), lower bar is acceptable
    // because the path shape (navigate to search → click result) is domain-invariant
    const effectiveThreshold =
      trace.service === service && trace.intent === intent && score < REPLAY_THRESHOLD
        ? REPLAY_THRESHOLD_STRUCTURAL
        : REPLAY_THRESHOLD;

    if (score >= effectiveThreshold && (!best || score > best.score)) {
      const substitutions = computeSubstitutions(trace, goalTokens);
      // Only use structural replay if we actually have substitutions to apply
      if (score < REPLAY_THRESHOLD && Object.keys(substitutions).length === 0) continue;
      best = { trace, score, substitutions };
    }
  }

  return best;
}

/**
 * Compute entity/creator substitutions for replay.
 *
 * Strategy: incoming tokens that do NOT appear in the stored trace's goal tokens
 * are assumed to be the new entity/creator. We map them over the trace's old
 * entity/creator strings positionally.
 *
 * For the creator, we take ALL remaining new tokens (not just creatorLen) to
 * handle cases where the creator name has more words than the stored trace's
 * creator (e.g. trace stored "txt" → 1 token, incoming "honey singh" → 2 tokens).
 *
 * Example (fixed):
 *   Trace: entity="crown" (1 tok), creator="txt" (1 tok)
 *   Incoming: ["milliner", "honey", "singh"]
 *   → entity sub: "crown" → "milliner"
 *   → creator sub: "txt" → "honey singh"  ← ALL remaining tokens
 */
function computeSubstitutions(
  trace: ExecutionTrace,
  incomingTokens: string[]
): Record<string, string> {
  const subs: Record<string, string> = {};
  const traceSet = new Set(trace.goalTokens);

  // Tokens in incoming that don't exist in the stored trace = "new" content
  const newTokens = incomingTokens.filter((t) => !traceSet.has(t));
  if (newTokens.length === 0) return subs;

  let cursor = 0;

  if (trace.entity) {
    // For entity: use same number of tokens as stored entity
    const entityLen = tokenise(trace.entity).length;
    const replacement = newTokens.slice(cursor, cursor + entityLen).join(" ");
    if (replacement) {
      subs[trace.entity.toLowerCase()] = replacement;
      cursor += entityLen;
    }
  }

  if (trace.creator && cursor < newTokens.length) {
    // For creator: take ALL remaining new tokens — handles multi-word creators
    // (e.g. "txt" → "honey singh" even though "txt" was only 1 token)
    const replacement = newTokens.slice(cursor).join(" ");
    if (replacement) {
      subs[trace.creator.toLowerCase()] = replacement;
    }
  }

  return subs;
}

/**
 * Apply substitutions to a step instruction / URL string.
 * Handles both plain-text and URL-encoded (+ and %20) variants.
 */
export function applySubstitutions(
  text: string,
  substitutions: Record<string, string>
): string {
  let result = text;
  for (const [from, to] of Object.entries(substitutions)) {
    if (!from || !to) continue;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Plain-text replacement
    result = result.replace(new RegExp(escaped, "gi"), to);
    // URL-encoded replacement (spaces → +)
    const encodedFrom = from.replace(/ /g, "+");
    const encodedTo   = to.replace(/ /g, "+");
    if (encodedFrom !== from) {
      const escapedEncoded = encodedFrom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escapedEncoded, "gi"), encodedTo);
    }
    // URL-encoded replacement (spaces → %20)
    const pctFrom = encodeURIComponent(from);
    const pctTo   = encodeURIComponent(to);
    if (pctFrom !== from) {
      const escapedPct = pctFrom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escapedPct, "gi"), pctTo);
    }
  }
  return result;
}

// ── Replay step builder ───────────────────────────────────────────────────

/**
 * Build a substituted step list ready for replay.
 */
export function buildReplaySteps(match: TraceMatch): TraceStep[] {
  return match.trace.steps.map((step) => {
    const out: TraceStep = { action: step.action, url: step.url };
    if (step.instruction !== undefined) {
      out.instruction = applySubstitutions(step.instruction, match.substitutions);
    }
    if (step.targetUrl !== undefined) {
      out.targetUrl = applySubstitutions(step.targetUrl, match.substitutions);
    }
    if (step.extractInstruction !== undefined) {
      out.extractInstruction = applySubstitutions(step.extractInstruction, match.substitutions);
    }
    if (step.extractSnippet !== undefined) out.extractSnippet = step.extractSnippet;
    if (step.selectors !== undefined) out.selectors = step.selectors;
    if (step.elapsedMs !== undefined) out.elapsedMs = step.elapsedMs;
    return out;
  });
}

// ── Bookkeeping ───────────────────────────────────────────────────────────

export function markReplaySuccess(traceId: string): void {
  const store = loadTraces();
  const t = store[traceId];
  if (t) {
    t.replayCount++;
    saveTraces(store);
  }
}

export function markReplayFail(traceId: string): void {
  const store = loadTraces();
  const t = store[traceId];
  if (t) {
    t.failCount++;
    saveTraces(store);
  }
}

// ── Stats & Listing ───────────────────────────────────────────────────────

export interface TraceStats {
  total: number;
  byService: Record<string, number>;
  byIntent: Record<string, number>;
  totalReplays: number;
}

export function getTraceStats(): TraceStats {
  const store = loadTraces();
  const traces = Object.values(store);

  const byService: Record<string, number> = {};
  const byIntent: Record<string, number> = {};
  let totalReplays = 0;

  for (const t of traces) {
    byService[t.service] = (byService[t.service] ?? 0) + 1;
    byIntent[t.intent] = (byIntent[t.intent] ?? 0) + 1;
    totalReplays += t.replayCount;
  }

  return { total: traces.length, byService, byIntent, totalReplays };
}

export function listTraces(limit = 20): ExecutionTrace[] {
  const store = loadTraces();
  return Object.values(store)
    .sort(
      (a, b) =>
        b.replayCount - a.replayCount ||
        new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
    )
    .slice(0, limit);
}

// ── SelectorChain Replay Engine ─────────────────────────────────────────────
//
// This is the core of zero-LLM path replay. Instead of sh.act() (which costs
// 1-3s LLM + AX tree), we try selectors in order from most stable to least.
// On success: update lastWorking and lastSuccessAt for that chain.
// On failure of lower levels: triggers self-healing (re-extract from page).

export type SelectorLevel = "role" | "text" | "css" | "xpath";

export interface SelectorResult {
  success: boolean;
  level?: SelectorLevel;       // which level worked
  selfHealed?: boolean;        // did we discover a better selector?
  newChain?: SelectorChain;    // updated chain if self-healed
  elapsedMs: number;
}

/**
 * Try to click an element using the SelectorChain without LLM.
 * Falls back through role → text → css → xpath → null.
 * On failure, optionally self-heals by extracting stable selectors from the page.
 */
export async function replayWithSelectorChain(
  page: any,
  chain: SelectorChain,
  timeoutMs = 3000
): Promise<SelectorResult> {
  const t0 = Date.now();

  // Determine starting level (use lastWorking to skip re-checking failed levels)
  const levels: SelectorLevel[] = ["role", "text", "css", "xpath"];
  const startIdx = chain.lastWorking ? levels.indexOf(chain.lastWorking) : 0;

  // Try from last known working level forward, then wrap to earlier levels
  const orderedLevels = [
    ...levels.slice(startIdx),
    ...levels.slice(0, startIdx),
  ] as SelectorLevel[];

  for (const level of orderedLevels) {
    try {
      let locator: any = null;

      if (level === "role" && chain.role) {
        const { role, name, exact } = chain.role;
        // Convert string regex back to RegExp if it looks like one
        const nameArg = name.startsWith("/") && name.endsWith("/i")
          ? new RegExp(name.slice(1, -2), "i")
          : name.startsWith("/") && name.endsWith("/")
            ? new RegExp(name.slice(1, -1))
            : name;
        locator = page.getByRole(role, { name: nameArg, exact: exact ?? false });
      } else if (level === "text" && chain.text) {
        locator = page.getByText(chain.text, { exact: false });
      } else if (level === "css" && chain.css) {
        locator = page.locator(chain.css);
      } else if (level === "xpath" && chain.xpath) {
        locator = page.locator(chain.xpath);
      }

      if (!locator) continue;

      // Check element is visible before clicking
      const visible = await locator.first().isVisible({ timeout: Math.min(timeoutMs, 1500) });
      if (!visible) continue;

      await locator.first().click({ timeout: timeoutMs });

      return {
        success: true,
        level,
        selfHealed: level !== chain.lastWorking && chain.lastWorking !== undefined,
        elapsedMs: Date.now() - t0,
      };
    } catch {
      // This level failed — try next
    }
  }

  return { success: false, elapsedMs: Date.now() - t0 };
}

/**
 * After a successful act(), extract a SelectorChain from the element
 * that was just clicked. Call this post-act to upgrade concrete XPath
 * traces to stable semantic selectors.
 */
export async function extractSelectorChain(
  page: any,
  xpathOrCss: string
): Promise<SelectorChain | null> {
  try {
    const chain = await page.evaluate((selector: string): SelectorChain | null => {
      // Try to find the element using the selector
      let el: Element | null = null;
      try {
        // Try CSS first
        el = document.querySelector(selector);
        if (!el) {
          // Try XPath
          const result = document.evaluate(
            selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
          );
          el = result.singleNodeValue as Element | null;
        }
      } catch { return null; }

      if (!el) return null;

      // Extract stable identifiers
      const role   = el.getAttribute("role") ||
                     el.tagName.toLowerCase().replace("ytd-", "").split("-")[0] || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const textContent = (el as HTMLElement).innerText?.trim().slice(0, 80) || "";
      const id     = el.id ? `#${el.id}` : "";
      const dataId = Array.from(el.attributes)
        .find(a => a.name.startsWith("data-") && a.value.length < 50);

      // Build stable CSS selector (prefer id > data-* > tagName+class pattern)
      const parent = el.parentElement;
      const parentTag = parent?.tagName.toLowerCase() ?? "";
      let css = "";
      if (id) css = id;
      else if (dataId) css = `[${dataId.name}="${dataId.value}"]`;
      else if (parentTag && id) css = `${parentTag} ${id}`;
      else if (el.tagName === "A" && parentTag.includes("video")) css = `${parentTag} a`;

      // exactOptionalPropertyTypes: only include defined fields
      const out: SelectorChain = {};
      if (role && textContent) out.role = { role: role === "a" ? "link" : role, name: textContent.slice(0, 50) };
      if (textContent) out.text = textContent;
      if (css) out.css = css;
      return out;
    }, xpathOrCss);

    return chain;
  } catch {
    return null;
  }
}

/**
 * Reliability score for a trace: 0 (never use) → 1 (always use).
 * Accounts for success rate, recency, and step count.
 */
export function traceReliability(trace: ExecutionTrace): number {
  const total = trace.replayCount + trace.failCount;
  if (total === 0) return 0.5; // never replayed — unknown reliability

  const successRate = trace.replayCount / total;

  // Recency: penalize paths not used in >7 days (may have stale selectors)
  const daysSinceLastSuccess = trace.replayCount > 0
    ? (Date.now() - new Date(trace.recordedAt).getTime()) / 86_400_000
    : 999;
  const recencyScore = Math.max(0, 1 - daysSinceLastSuccess / 30); // 0 after 30 days

  // Brevity: shorter paths are more reliable (less can go wrong)
  const brevityScore = Math.max(0, 1 - (trace.steps.length - 1) / 10);

  // Weighted combination
  return Math.min(1, 0.6 * successRate + 0.25 * recencyScore + 0.15 * brevityScore);
}

