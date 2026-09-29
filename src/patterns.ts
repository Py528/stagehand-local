/**
 * patterns.ts — Abstract Pattern Engine
 *
 * The core idea: instead of matching goals by keyword overlap (fragile),
 * extract the STRUCTURAL PATTERN of a goal — the template with named slots
 * — and match by pattern identity + slot similarity.
 *
 * Example:
 *   "play millionaire by honey singh on youtube"
 *   → pattern: "youtube::media_play::SONG+ARTIST"
 *   → slots:   { SONG: "millionaire", ARTIST: "honey singh" }
 *
 *   "play crown by txt on youtube"
 *   → pattern: "youtube::media_play::SONG+ARTIST"    ← IDENTICAL PATTERN
 *   → slots:   { SONG: "crown", ARTIST: "txt" }
 *
 * Pattern match score: 1.0 if pattern keys match exactly.
 * Slot similarity: trigram character n-gram similarity (handles typos,
 * phonetic variants, abbreviations — "milliner" ≈ "millionaire" via shared
 * character sequences). No external libraries, no ML models.
 *
 * Storage: data/patterns.json
 *   {
 *     "youtube::media_play::SONG+ARTIST": {
 *       patternKey: "youtube::media_play::SONG+ARTIST",
 *       slotNames: ["SONG", "ARTIST"],
 *       templateSteps: [                         ← steps with {{SONG}} etc.
 *         { action: "navigate", targetUrl: "https://www.youtube.com/results?search_query={{SONG}}+{{ARTIST}}" },
 *         { action: "act", instruction: "click the video '{{SONG}} by {{ARTIST}}'" }
 *       ],
 *       exampleGoals: ["play crown by txt on youtube"],
 *       successCount: 3,
 *       failCount: 0,
 *       avgSteps: 2,
 *       avgMs: 4200,
 *       createdAt: "...",
 *       lastUsed: "...",
 *     }
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fuse from "fuse.js";
import type { TraceStep } from "./trace.js";

// ── File paths ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DATA_DIR      = path.resolve(__dirname, "..", "data");
const PATTERNS_FILE = path.join(DATA_DIR, "patterns.json");

// ── Types ──────────────────────────────────────────────────────────────────

export interface PatternSlots {
  [slotName: string]: string;
}

export interface AbstractGoal {
  /** e.g. "youtube::media_play::SONG+ARTIST" */
  patternKey: string;
  /** Slot values extracted from this concrete goal */
  slots: PatternSlots;
  /** Raw goal for debugging */
  rawGoal: string;
}

export interface PatternTemplate {
  patternKey: string;
  slotNames: string[];
  /** Steps with {{SLOT_NAME}} placeholders */
  templateSteps: TraceStep[];
  /** Representative goals that produced this pattern */
  exampleGoals: string[];
  successCount: number;
  failCount: number;
  avgSteps: number;
  avgMs: number;
  createdAt: string;
  lastUsed: string;
}

export interface PatternMatch {
  template: PatternTemplate;
  /** Exact pattern key match (1.0) or slot-similarity match (0-1) */
  confidence: number;
  /** Slot values filled in from the incoming goal */
  slots: PatternSlots;
  /** Steps with slots already substituted, ready to replay */
  replaySteps: TraceStep[];
}

type PatternStore = Record<string, PatternTemplate>;

// ── Storage ────────────────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadPatterns(): PatternStore {
  ensureDataDir();
  if (!fs.existsSync(PATTERNS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf-8")) as PatternStore;
  } catch {
    return {};
  }
}

export function savePatterns(store: PatternStore): void {
  ensureDataDir();
  fs.writeFileSync(PATTERNS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

// ── Trigram character n-gram similarity ────────────────────────────────────
//
// Trigrams give us partial string overlap. "millionaire" and "milliner" share
// many trigrams: "mil", "ill", "lli", "lin", "ina", etc. → high similarity.
// This handles typos, abbreviations, and phonetic variants without any model.
//
// Dice coefficient: 2 * |intersection| / (|A| + |B|)
// O(n) after building trigram sets. ~0.1ms for typical song titles.

function buildTrigrams(s: string): Set<string> {
  const padded = `  ${s.toLowerCase().replace(/\s+/g, " ")}  `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.toLowerCase() === b.toLowerCase()) return 1;
  const ta = buildTrigrams(a);
  const tb = buildTrigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

// ── Slot value fuzzy normalization (fuse.js) ───────────────────────────────
//
// When a user types "milliner" but means "millionaire", fuse.js can find the
// correct slot value in a known list (e.g. previously seen song titles).
// This is used as a pre-step before pattern extraction to fix typos in slot values.
//
// The known list is built lazily from all example goals in the pattern store.

let _fuseIndex: Fuse<string> | null = null;
let _fuseList: string[] = [];

function refreshFuseIndex(): void {
  const store = loadPatterns();
  const seen = new Set<string>();
  for (const t of Object.values(store)) {
    for (const goal of t.exampleGoals) {
      // Extract all non-stop-word tokens as known values
      goal.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 2 && !["play","watch","youtube","google","the","and","by","on","from","in","at","for","of","a","an"].includes(w))
        .forEach(w => seen.add(w));
    }
  }
  _fuseList = Array.from(seen);
  _fuseIndex = new Fuse(_fuseList, {
    includeScore: true,
    threshold: 0.35, // allow ~35% character difference
    minMatchCharLength: 3,
  });
}

/**
 * Attempt to fuzzy-correct a single word against known slot values.
 * Returns the best match if score is good, otherwise returns the original.
 * Used for typo correction: "milliner" → "millionaire"
 */
export function fuzzyCorrectSlotWord(word: string): string {
  if (!word || word.length < 4) return word;
  if (!_fuseIndex || _fuseList.length === 0) refreshFuseIndex();
  if (!_fuseIndex || _fuseList.length === 0) return word;
  const results = _fuseIndex.search(word);
  if (results.length > 0 && results[0]) {
    const best = results[0];
    // Only correct if the score is very good AND the match is substantially different
    if ((best.score ?? 1) < 0.2 && best.item !== word && trigramSimilarity(word, best.item) > 0.45) {
      return best.item;
    }
  }
  return word;
}

/**
 * Invalidate the fuse index cache after new patterns are recorded.
 */
export function invalidateFuseCache(): void {
  _fuseIndex = null;
  _fuseList = [];
}

// ── Slot similarity ─────────────────────────────────────────────────────────
//
// Compares two slot value sets. Uses trigram similarity on individual slot
// values so "honey singh" ≈ "yo yo honey singh", "crown" ≈ "crown" = 1.0.
// Returns a score 0-1 indicating how similar the slots are.
// If slots are completely different (new entity/artist), still returns score=1
// because the PATTERN matches — we just need slot substitution, not slot similarity.

export function slotSimilarity(a: PatternSlots, b: PatternSlots): number {
  const keys = Object.keys(a);
  if (keys.length === 0) return 1.0;
  let total = 0;
  for (const k of keys) {
    const av = a[k] ?? "";
    const bv = b[k] ?? "";
    if (!av || !bv) { total += 0.5; continue; }
    total += trigramSimilarity(av, bv);
  }
  return total / keys.length;
}

// ── Pattern Extractors ─────────────────────────────────────────────────────
//
// Each extractor maps a natural-language goal to:
//   { patternKey, slots }
//
// Pattern keys use a canonical format:
//   "<service>::<intent>::<slot1>+<slot2>..."
//
// This is purely deterministic regex — zero LLM calls, <1ms execution.

/**
 * Extract abstract goal pattern from a natural language string.
 * Returns null if no known pattern matches.
 */
export function extractPattern(goal: string): AbstractGoal | null {
  const g = goal.trim();

  // Try each extractor in priority order
  return (
    extractYouTubePlay(g)      ||
    extractYouTubeSearch(g)    ||
    extractWeatherQuery(g)     ||
    extractRestaurantHours(g)  ||
    extractRestaurantSearch(g) ||
    extractJobSearch(g)        ||
    extractGoogleSearch(g)     ||
    extractDirectNavigate(g)   ||
    null
  );
}

// ── Individual pattern extractors ──────────────────────────────────────────

function extractYouTubePlay(goal: string): AbstractGoal | null {
  // Patterns: "play X by/from Y on youtube", "play X on youtube by Y", "youtube X by Y"
  const patterns = [
    /(?:play|watch|listen\s+to|open)\s+(?:the\s+)?(?:song\s+|video\s+|track\s+)?(.+?)\s+(?:by|from)\s+(.+?)\s+on\s+(?:youtube|yt)\b/i,
    /(?:play|watch|listen\s+to|open)\s+(?:the\s+)?(?:song\s+|video\s+|track\s+)?(.+?)\s+on\s+(?:youtube|yt)\s+(?:by|from)\s+(.+)/i,
    /(?:youtube|yt)[,:]?\s+(?:play|watch)?\s*(.+?)\s+(?:by|from)\s+(.+)/i,
    /(?:play|watch)\s+(.+?)\s+(?:by|from)\s+(.+)/i,  // implicit youtube
  ];
  for (const pat of patterns) {
    const m = goal.match(pat);
    if (m && m[1] && m[2]) {
      const song   = m[1].replace(/^(the|a)\s+/i, "").trim();
      const artist = m[2].replace(/\s+(?:on\s+youtube.*|official.*|video.*)/i, "").trim();
      if (song.length > 0 && artist.length > 0) {
        return {
          patternKey: "youtube::media_play::SONG+ARTIST",
          slots: { SONG: song, ARTIST: artist },
          rawGoal: goal,
        };
      }
    }
  }
  // Play X on youtube (no artist)
  const noArtist = goal.match(/(?:play|watch|listen\s+to)\s+(?:the\s+)?(.+?)\s+on\s+(?:youtube|yt)\b/i);
  if (noArtist && noArtist[1]) {
    return {
      patternKey: "youtube::media_play::SONG",
      slots: { SONG: noArtist[1].trim() },
      rawGoal: goal,
    };
  }
  return null;
}

function extractYouTubeSearch(goal: string): AbstractGoal | null {
  const m = goal.match(/(?:search|find|look\s+up)\s+(.+?)\s+on\s+(?:youtube|yt)\b/i);
  if (m && m[1]) {
    return { patternKey: "youtube::search::QUERY", slots: { QUERY: m[1].trim() }, rawGoal: goal };
  }
  return null;
}

function extractWeatherQuery(goal: string): AbstractGoal | null {
  const m = goal.match(/(?:weather|temperature|forecast|rain|climate)\s+(?:in|at|for|of)?\s+(.+?)(?:\s+today|\s+tomorrow|\s+this\s+week)?$/i);
  if (m && m[1]) {
    return { patternKey: "google::weather::CITY", slots: { CITY: m[1].trim() }, rawGoal: goal };
  }
  const m2 = goal.match(/(?:what.s|tell\s+me|how.s)\s+(?:the\s+)?weather(?:\s+like)?\s+(?:in|at)?\s*(.+)/i);
  if (m2 && m2[1]) {
    return { patternKey: "google::weather::CITY", slots: { CITY: m2[1].trim() }, rawGoal: goal };
  }
  return null;
}

function extractRestaurantHours(goal: string): AbstractGoal | null {
  const m = goal.match(/(?:hours?|timing|timings|open(?:ing\s+hours?)?|close[sd]?|when\s+(?:does|is))\s+(?:of|for|at)?\s+(.+?)\s+(?:in|at|on|near|,)?\s+([a-z\s]+?)(?:\s+today|\s+tomorrow|\s+for\s+tomorrow)?$/i);
  if (m && m[1]) {
    const restaurant = m[1].trim();
    const location   = m[2]?.trim() || "";
    return {
      patternKey: location ? "restaurant::hours::RESTAURANT+LOCATION" : "restaurant::hours::RESTAURANT",
      slots: location ? { RESTAURANT: restaurant, LOCATION: location } : { RESTAURANT: restaurant },
      rawGoal: goal,
    };
  }
  // "is X open" or "X opening hours"
  const m2 = goal.match(/(?:is\s+)?(.+?)\s+(?:open|opening\s+hours?|timings?|close[sd]?)\s+(?:in|at|on)?\s+([a-z\s]+)/i);
  if (m2 && m2[1] && !/^(the|a)\s+/i.test(m2[1])) {
    const restaurant = m2[1].replace(/^(?:check|tell\s+me|find)\s+/i, "").trim();
    const location   = m2[2]?.trim() || "";
    return {
      patternKey: location ? "restaurant::hours::RESTAURANT+LOCATION" : "restaurant::hours::RESTAURANT",
      slots: location ? { RESTAURANT: restaurant, LOCATION: location } : { RESTAURANT: restaurant },
      rawGoal: goal,
    };
  }
  return null;
}

function extractRestaurantSearch(goal: string): AbstractGoal | null {
  const m = goal.match(/(?:find|search|look\s+for|show|nearby|best|top)\s+(.+?)\s+(?:restaurant|food|cafe|eat(?:ery)?|dining)\s+(?:in|near|at)\s+(.+)/i);
  if (m && m[1] && m[2]) {
    return {
      patternKey: "restaurant::search::CUISINE+LOCATION",
      slots: { CUISINE: m[1].trim(), LOCATION: m[2].trim() },
      rawGoal: goal,
    };
  }
  return null;
}

function extractJobSearch(goal: string): AbstractGoal | null {
  // "remote ML jobs at Roboflow", "open CV engineer roles at Ambient.ai"
  const m = goal.match(/(?:open|remote|find|search)?\s*(.+?)\s+(?:job|role|position|opening)s?\s+(?:at|for)\s+(.+)/i);
  if (m && m[1] && m[2]) {
    return {
      patternKey: "careers::job_search::ROLE+COMPANY",
      slots: { ROLE: m[1].trim(), COMPANY: m[2].trim() },
      rawGoal: goal,
    };
  }
  return null;
}

function extractGoogleSearch(goal: string): AbstractGoal | null {
  // "search google for X", "google X"
  const m = goal.match(/(?:search|google|look\s+up)\s+(?:for\s+)?(?:on\s+google\s+)?(.+)/i);
  if (m && m[1]) {
    return { patternKey: "google::search::QUERY", slots: { QUERY: m[1].trim() }, rawGoal: goal };
  }
  return null;
}

function extractDirectNavigate(goal: string): AbstractGoal | null {
  const urlMatch = goal.match(/(?:go\s+to|open|navigate\s+to|visit)\s+(https?:\/\/\S+|[a-z0-9-]+\.[a-z]{2,}\S*)/i);
  if (urlMatch && urlMatch[1]) {
    return { patternKey: "browser::navigate::URL", slots: { URL: urlMatch[1].trim() }, rawGoal: goal };
  }
  return null;
}

// ── Template operations ─────────────────────────────────────────────────────

/**
 * Replace {{SLOT_NAME}} placeholders in a step template with concrete values.
 */
export function fillSlots(template: string, slots: PatternSlots): string {
  let result = template;
  for (const [name, value] of Object.entries(slots)) {
    // Plain {{SLOT}}
    result = result.replace(new RegExp(`\\{\\{${name}\\}\\}`, "gi"), value);
    // URL-encoded +  {{SLOT}} → value with spaces as +
    const plus = value.replace(/ /g, "+");
    result = result.replace(new RegExp(`\\{\\{${name}\\+\\}\\}`, "gi"), plus);
    // URL-encoded %20  {{SLOT%20}}
    const pct = encodeURIComponent(value);
    result = result.replace(new RegExp(`\\{\\{${name}%20\\}\\}`, "gi"), pct);
  }
  return result;
}

/**
 * Convert concrete TraceSteps to abstract template steps by replacing
 * slot values with {{SLOT_NAME}} placeholders.
 */
export function abstractSteps(steps: TraceStep[], slots: PatternSlots): TraceStep[] {
  const slotEntries = Object.entries(slots).sort((a, b) => b[1].length - a[1].length); // longest first

  return steps.map((step) => {
    const out: TraceStep = { ...step };

    const replace = (text: string): string => {
      let t = text;
      for (const [name, value] of slotEntries) {
        if (!value) continue;
        const esc     = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escPlus = value.replace(/ /g, "+").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escPct  = encodeURIComponent(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        t = t.replace(new RegExp(esc,     "gi"), `{{${name}}}`);
        t = t.replace(new RegExp(escPlus, "gi"), `{{${name}+}}`);
        t = t.replace(new RegExp(escPct,  "gi"), `{{${name}%20}}`);
      }
      return t;
    };

    if (out.instruction !== undefined) out.instruction = replace(out.instruction);
    if (out.targetUrl   !== undefined) out.targetUrl   = replace(out.targetUrl);
    if (out.extractInstruction !== undefined) out.extractInstruction = replace(out.extractInstruction);

    return out;
  });
}

/**
 * Expand template steps by filling slots with concrete values.
 */
export function expandSteps(templateSteps: TraceStep[], slots: PatternSlots): TraceStep[] {
  return templateSteps.map((step) => {
    const out: TraceStep = { ...step };
    if (out.instruction !== undefined) out.instruction = fillSlots(out.instruction, slots);
    if (out.targetUrl   !== undefined) out.targetUrl   = fillSlots(out.targetUrl, slots);
    if (out.extractInstruction !== undefined) out.extractInstruction = fillSlots(out.extractInstruction, slots);
    return out;
  });
}

// ── Pattern Store operations ────────────────────────────────────────────────

/**
 * Record a successful execution as a reusable pattern.
 * If the pattern already exists, merges/updates it.
 */
export function recordPattern(params: {
  abstractGoal: AbstractGoal;
  steps: TraceStep[];
  totalMs: number;
  answerSnippet: string;
}): PatternTemplate {
  const store = loadPatterns();
  const { patternKey, slots } = params.abstractGoal;

  // Abstract the steps by replacing slot values with placeholders
  const templateSteps = abstractSteps(params.steps, slots);

  const existing = store[patternKey];
  const now = new Date().toISOString();

  if (existing) {
    // Update: merge stats, keep best template steps (fewest steps wins)
    const template: PatternTemplate = {
      ...existing,
      successCount: existing.successCount + 1,
      avgSteps: Math.round((existing.avgSteps * existing.successCount + params.steps.length) / (existing.successCount + 1)),
      avgMs:    Math.round((existing.avgMs    * existing.successCount + params.totalMs)      / (existing.successCount + 1)),
      lastUsed: now,
      // Keep shorter template (more direct path)
      templateSteps: params.steps.length <= existing.avgSteps ? templateSteps : existing.templateSteps,
      exampleGoals: [...new Set([...existing.exampleGoals, params.abstractGoal.rawGoal])].slice(0, 5),
    };
    store[patternKey] = template;
    savePatterns(store);
    return template;
  }

  const template: PatternTemplate = {
    patternKey,
    slotNames: Object.keys(slots),
    templateSteps,
    exampleGoals: [params.abstractGoal.rawGoal],
    successCount: 1,
    failCount: 0,
    avgSteps: params.steps.length,
    avgMs: params.totalMs,
    createdAt: now,
    lastUsed: now,
  };
  store[patternKey] = template;
  savePatterns(store);
  invalidateFuseCache(); // rebuild slot value index with new known words
  return template;
}

/**
 * Find the best matching pattern for an incoming goal.
 *
 * Matching strategy:
 * 1. Extract pattern from incoming goal → get patternKey + slots
 * 2. Look up exact patternKey in store → EXACT MATCH (confidence=1.0)
 * 3. If not found, return null (no fuzzy cross-pattern matching needed —
 *    the pattern key IS the structure; if it doesn't match, it's a different task)
 *
 * The trigram similarity is used WITHIN a slot to score how well the
 * stored trace's entity matches the incoming entity — but since we're
 * doing slot substitution, slot similarity doesn't affect whether we
 * replay; it only affects whether we show a confidence warning.
 */
export function findPattern(goal: string): PatternMatch | null {
  const abstractGoal = extractPattern(goal);
  if (!abstractGoal) return null;

  const store = loadPatterns();
  const template = store[abstractGoal.patternKey];
  if (!template) return null;

  // Pattern key matched exactly — this IS the right structural template
  // Confidence = 1.0 (structure matches) regardless of slot values
  // Slot values just get substituted, not compared for similarity
  const replaySteps = expandSteps(template.templateSteps, abstractGoal.slots);

  // Mark as used
  template.lastUsed = new Date().toISOString();
  store[abstractGoal.patternKey] = template;
  savePatterns(store);

  return {
    template,
    confidence: 1.0,
    slots: abstractGoal.slots,
    replaySteps,
  };
}

/**
 * Mark a pattern replay as succeeded or failed.
 */
export function markPatternSuccess(patternKey: string): void {
  const store = loadPatterns();
  const t = store[patternKey];
  if (t) { t.successCount++; t.lastUsed = new Date().toISOString(); savePatterns(store); }
}

export function markPatternFail(patternKey: string): void {
  const store = loadPatterns();
  const t = store[patternKey];
  if (t) { t.failCount++; savePatterns(store); }
}

/**
 * List all stored patterns with stats.
 */
export function listPatterns(): PatternTemplate[] {
  const store = loadPatterns();
  return Object.values(store).sort((a, b) => b.successCount - a.successCount);
}

/**
 * Get stats summary.
 */
export function getPatternStats(): {
  total: number;
  byService: Record<string, number>;
  byIntent: Record<string, number>;
  totalReplays: number;
  topPatterns: string[];
} {
  const store = loadPatterns();
  const vals  = Object.values(store);
  const byService: Record<string, number> = {};
  const byIntent:  Record<string, number> = {};
  let totalReplays = 0;

  for (const t of vals) {
    const [svc, intent] = t.patternKey.split("::");
    if (svc)    byService[svc]    = (byService[svc]    ?? 0) + 1;
    if (intent) byIntent[intent]  = (byIntent[intent]  ?? 0) + 1;
    totalReplays += t.successCount;
  }

  const topPatterns = vals
    .sort((a, b) => b.successCount - a.successCount)
    .slice(0, 5)
    .map(t => `${t.patternKey} (×${t.successCount})`);

  return { total: vals.length, byService, byIntent, totalReplays, topPatterns };
}
