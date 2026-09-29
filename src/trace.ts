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

export interface TraceStep {
  action: "navigate" | "act" | "extract" | "wait" | "heuristic" | "ats_api";
  /** URL the page was at when this step ran */
  url: string;
  /** For act: the natural-language instruction */
  instruction?: string;
  /** For navigate: the target URL */
  targetUrl?: string;
  /** For extract: the extraction instruction + result snippet (first 300 chars) */
  extractInstruction?: string;
  extractSnippet?: string;
  /** DOM selector(s) that were targeted (harvested from distilled interactive list) */
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
