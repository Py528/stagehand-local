# Goal Structure Extraction & Pattern-Based Trace Matching
## Research Summary + Concrete Implementation Plan

---

## 1. The Core Problem

Current `trace.ts` uses **Jaccard token similarity** to match goals. This fails when:
- Tokens completely differ ("play millionaire by honey singh" vs "play besharam rang by deepika")  
- The user changes artist/song but keeps the same structural intent
- New goals have **zero token overlap** with stored traces despite being structurally identical

**The insight**: `play [SONG] by [ARTIST] on [PLATFORM]` is a *structural pattern*, not a keyword bag. Any goal matching this template can reuse the trace with slot substitution.

---

## 2. Research Findings

### 2.1 NER Approaches Lightweight Enough for Node.js

**Best option: `compromise` (npm: `compromise`)**
- Pure JS, no WASM, no model download, ~200KB
- POS-tags + chunks text: can identify VerbPhrase, NounPhrase, ProperNoun
- API: `nlp("play millionaire by honey singh").verbs().text()` → "play"
- Does NOT require external ML — uses rule-based English grammar

**Second option: `wink-nlp` + `wink-eng-lite-web-model`**
- Slightly heavier (~1MB model), but proper NER (People, Organizations, Locations)
- Can identify "honey singh" as a Person entity
- TypeScript-native

**Verdict for your use case**: `compromise` alone is sufficient because we don't need general NER. We need **domain-specific slot extraction** based on structural position, not entity type classification. "Honey singh" is an ARTIST because it follows `by` in a media-play goal — positional grammar, not NER.

**Key insight from Alexa/Siri research**: Voice assistants don't use general NER for slot filling. They use **position-relative extraction** from matched templates. The pattern `play {song} by {artist}` works purely by regex + positional capture.

### 2.2 Template/Slot Extraction (How Alexa/Siri Do It)

Alexa's interaction model is fundamentally:
1. **Carrier phrase** = invariant part (`"play ... by ... on youtube"`)
2. **Slots** = variable parts (`{song}`, `{artist}`, `{platform}`) 
3. **Intent** = semantic label for the action (`PlayMusic`)

The Alexa/Siri approach uses **pre-authored templates** — you enumerate the patterns, they do fuzzy matching. For browser automation, we want to **auto-discover** templates from execution traces.

Key technique from voice assistant research:
> "After replacement, patterns are analyzed to determine frequency. If frequency exceeds a threshold, the pattern is identified as a valid pattern."

This is exactly what we need: **frequency-based pattern promotion**. When 3+ traces share the same structural skeleton, auto-promote it to a template.

### 2.3 Browser Agent Frameworks

**OpenAdapt** has directly addressed this with their "Abstraction Ladder":
```
Level 0: Literal   (raw clicks/coords)
Level 1: Symbolic  (type "hello")
Level 2: Template  (type "{name}")     ← THIS IS WHERE WE NEED TO BE
Level 3: Semantic  (greet user)        ← Research phase
Level 4: Goal      ("Welcome customer") ← Future
```

OpenAdapt calls Level 2 → Level 3 transition "Symbolic to Template" and implements it via regex extraction on the action parameters. The compiler then promotes values to typed parameters.

**Stagehand** takes a different approach: `observe()` + `act(cachedAction)` where the cache key is the instruction string. For pattern-based replay, they use `cacheDir` with key = instruction + page state. This is instruction-level caching, not structural pattern matching.

**The gap**: None of the existing frameworks do **automatic structural abstraction of goals** — they all require either pre-authored templates (Alexa) or per-page caching (Stagehand). The insight of abstracting goals into POS-level skeletons and using those for cross-goal matching is novel for browser agents.

### 2.4 Abstracted Execution Traces in Program Synthesis

From FlashFill (Gulwani, 2011) and Syren (2025):
- **Trivial solution**: trace that replays recorded values verbatim (your current traces)
- **Generalized solution**: trace where constant values → typed parameters
- **Key heuristic**: "a value typed into a field carries the field's own label" → parameterize it

The program synthesis insight: when you have multiple traces of the same intent, **align them positionally** and any position where the value differs = a parameter slot. Where it's always the same = a constant.

For browser goals:
```
Trace 1: "play crown by txt on youtube"     → entity=crown,  creator=txt
Trace 2: "play millionaire by honey singh"  → entity=millionaire, creator=honey singh
Trace 3: "play lean on me by bill withers"  → entity=lean on me, creator=bill withers

Aligned skeleton: "play {entity} by {creator} [on youtube]"
Slot types inferred by position: slot[1]=entity, slot[2]=creator
```

This is **Programming by Example (PBE)** applied to goal abstraction. The "examples" are your stored traces.

### 2.5 TypeScript/npm Packages for Intent Extraction

| Package | Approach | ML Required | Size | Verdict |
|---------|----------|-------------|------|---------|
| `compromise` | Rule-based POS + NLP | ❌ None | 200KB | ✅ Best for structural extraction |
| `wink-nlp` | Pre-trained lite model | ✅ 1MB model | 2MB | Good for NER |
| `unified-ner` | compromise + wink-nlp | ✅ | 3MB | Overkill |
| `@rebelstack-io/intent` | Neural/Bayes classifier | ✅ Trains | Variable | Needs training data |
| `node-nlp-typescript` | Full NLP suite | ✅ | Large | Too heavy |

**Pure heuristic approach** (no packages needed):
The `tdcommons.org` patent reveals Google/Apple's approach for media queries:
1. Identify **arguments** (song/artist/album/platform) via web annotations and structural patterns
2. **Pattern Discovery**: replace arguments with annotators ($artist, $song), count frequencies
3. **Grammar Generation**: if frequency > threshold, it becomes a valid grammar rule

This is achievable in pure TypeScript with regex alone.

---

## 3. Concrete Implementation Plan

### 3.1 New Data Structure: `GoalPattern`

Add to `trace.ts` (or new `pattern.ts` file):

```typescript
export interface GoalPattern {
  id: string;
  /** POS-level skeleton: "VERB NOUN by PROPER_NOUN on PLATFORM" */
  skeleton: string;
  /** Named slots with their positions in the skeleton */
  slots: SlotDefinition[];
  /** Service + intent this pattern covers */
  service: string;
  intent: string;
  /** Trace IDs that match this pattern (for reliability scoring) */
  traceIds: string[];
  /** Regex pattern string for matching */
  regexPattern: string;
  /** Promotion threshold: pattern is promoted once traceIds.length >= MIN_TRACES_TO_PROMOTE */
  promoted: boolean;
  createdAt: string;
}

export interface SlotDefinition {
  name: "entity" | "creator" | "platform" | "query" | "org" | "role";
  /** Position in the skeleton */
  position: number;
  /** Regex group that captures this slot */
  captureGroup: number;
}
```

### 3.2 The Structural Fingerprinting Algorithm (~60 lines)

The key insight: replace the VALUES extracted by `compiler.ts` with slot markers, producing a **structural fingerprint** of the goal.

```typescript
// pattern-extractor.ts

const ACTION_VERBS = ["play", "watch", "listen", "open", "search", "find", "get", "show", "navigate", "go"];
const PLATFORM_WORDS = ["youtube", "google", "spotify", "netflix", "amazon", "twitter", "linkedin"];
const PREP_BY = ["by", "from", "created by", "made by"];
const PREP_ON = ["on", "at", "via", "through", "using"];

export interface StructuralFingerprint {
  skeleton: string;           // "VERB SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM"
  slots: Record<string, string>; // { SLOT_ENTITY: "millionaire", SLOT_CREATOR: "honey singh", ... }
  verbAnchor: string;         // "play"
  platformAnchor: string | null; // "youtube"
}

/**
 * Extract structural fingerprint from a compiled goal.
 * Pure logic — no external packages.
 */
export function extractFingerprint(
  rawGoal: string,
  plan: ExecutionPlan
): StructuralFingerprint {
  const lower = rawGoal.toLowerCase().trim();
  
  // Step 1: Identify verb anchor (first action verb)
  const verbAnchor = ACTION_VERBS.find(v => lower.startsWith(v + " ") || lower.includes(" " + v + " ")) ?? "navigate";
  
  // Step 2: Identify platform anchor
  const platformAnchor = PLATFORM_WORDS.find(p => lower.includes(p)) ?? null;
  
  // Step 3: Use compiler's extracted fields as slots — these are already identified
  const slots: Record<string, string> = {};
  if (plan.targetName) slots["SLOT_ENTITY"] = plan.targetName;
  if (plan.creatorOrOrg) slots["SLOT_CREATOR"] = plan.creatorOrOrg;
  if (platformAnchor) slots["SLOT_PLATFORM"] = platformAnchor;
  
  // Step 4: Build skeleton by replacing slot values in the original goal
  let skeleton = lower;
  // Sort by length desc to avoid partial replacements
  for (const [slotKey, slotValue] of Object.entries(slots).sort((a, b) => b[1].length - a[1].length)) {
    const escaped = slotValue.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    skeleton = skeleton.replace(new RegExp(escaped, "gi"), slotKey);
  }
  
  // Step 5: Normalize stop-words in skeleton to produce clean structural representation
  skeleton = skeleton
    .replace(/\b(a|an|the|please|can you|could you)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  
  return { skeleton, slots, verbAnchor, platformAnchor };
}
```

**Example output for "play millionaire by honey singh on youtube":**
```json
{
  "skeleton": "play SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM",
  "slots": {
    "SLOT_ENTITY": "millionaire",
    "SLOT_CREATOR": "honey singh",
    "SLOT_PLATFORM": "youtube"
  },
  "verbAnchor": "play",
  "platformAnchor": "youtube"
}
```

**And for "play besharam rang by deepika":**
```json
{
  "skeleton": "play SLOT_ENTITY by SLOT_CREATOR",
  "slots": {
    "SLOT_ENTITY": "besharam rang",
    "SLOT_CREATOR": "deepika"
  },
  "verbAnchor": "play",
  "platformAnchor": null
}
```

These two are **structurally similar** (skeleton differs only by optional `on SLOT_PLATFORM`).

### 3.3 Skeleton Similarity Scoring (~30 lines)

Replace the Jaccard token similarity in `scoreTrace()` with skeleton-level similarity:

```typescript
/**
 * Compare two skeletons structurally.
 * Skeletons use SLOT_ markers, so this is pure token comparison on the structural level.
 */
function skeletonSimilarity(skelA: string, skelB: string): number {
  const tokA = skelA.split(/\s+/).filter(Boolean);
  const tokB = skelB.split(/\s+/).filter(Boolean);
  
  // Jaccard on skeleton tokens (which are SLOT_X or structural words like "by", "on")
  const setA = new Set(tokA);
  const setB = new Set(tokB);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  const jaccard = union.size === 0 ? 0 : intersection.size / union.size;
  
  // Bonus: same verb anchor (e.g. both "play") 
  const verbMatch = tokA[0] === tokB[0] ? 0.15 : 0;
  
  // Bonus: same number of SLOT_ markers (same arity)
  const aritySlotsA = tokA.filter(t => t.startsWith("SLOT_")).length;
  const aritySlotsB = tokB.filter(t => t.startsWith("SLOT_")).length;
  const arityMatch = aritySlotsA === aritySlotsB ? 0.10 : 0;
  
  return Math.min(1.0, jaccard + verbMatch + arityMatch);
}
```

**Example:**
- `"play SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM"` vs `"play SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM"` → score: **1.0**
- `"play SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM"` vs `"play SLOT_ENTITY by SLOT_CREATOR"` → score: **~0.78** (still high — same verb, same 2-slot structure)
- `"play SLOT_ENTITY by SLOT_CREATOR"` vs `"search SLOT_QUERY on SLOT_PLATFORM"` → score: **~0.15** (different verb, different structure)

### 3.4 Updated `scoreTrace()` in trace.ts (~20 line change)

The new scoring rubric:

```typescript
export function scoreTrace(
  trace: ExecutionTrace,
  service: string,
  intent: string,
  goalTokens: string[],
  answerDomain?: string,
  incomingSkeleton?: string   // ← NEW PARAMETER
): number {
  if (trace.service !== service) return 0;

  let score = 0.35; // service match

  if (trace.intent === intent) score += 0.20;

  // Structural skeleton similarity (replaces raw Jaccard)
  if (incomingSkeleton && trace.skeleton) {
    const structScore = skeletonSimilarity(incomingSkeleton, trace.skeleton);
    score += structScore * 0.35; // structural match is worth MORE than token overlap
  } else {
    // Fallback: old Jaccard on tokens
    const incomingSet = new Set(goalTokens);
    const traceSet = new Set(trace.goalTokens);
    score += jaccardSimilarity(incomingSet, traceSet) * 0.20;
  }

  if (answerDomain && trace.answerDomain === answerDomain) score += 0.05;

  if (trace.replayCount > 0) {
    const failRatio = trace.failCount / trace.replayCount;
    if (failRatio < DEMOTE_FAIL_RATIO) score += Math.min(0.05, (trace.replayCount / 20) * 0.05);
    else score -= 0.10;
  }

  return Math.max(0, Math.min(1, score));
}
```

### 3.5 Updated Slot Substitution via Skeleton-Aware Mapping

The current `computeSubstitutions()` is positional and fragile. With skeletons, we can do it properly:

```typescript
/**
 * Compute slot substitutions using skeleton slot alignment.
 * "play millionaire by honey singh" → "play besharam rang by deepika"
 * Skeleton: "play SLOT_ENTITY by SLOT_CREATOR"
 * Trace slots: { SLOT_ENTITY: "millionaire", SLOT_CREATOR: "honey singh" }
 * Incoming slots: { SLOT_ENTITY: "besharam rang", SLOT_CREATOR: "deepika" }
 * Substitutions: { "millionaire": "besharam rang", "honey singh": "deepika" }
 */
export function computeSkeletonSubstitutions(
  traceSkeleton: StructuralFingerprint,
  incomingSkeleton: StructuralFingerprint
): Record<string, string> {
  const subs: Record<string, string> = {};
  
  for (const slotKey of Object.keys(traceSkeleton.slots)) {
    const traceValue = traceSkeleton.slots[slotKey];
    const incomingValue = incomingSkeleton.slots[slotKey];
    if (traceValue && incomingValue && traceValue !== incomingValue) {
      subs[traceValue.toLowerCase()] = incomingValue;
    }
  }
  
  return subs;
}
```

### 3.6 Pattern Library: Auto-Promoted Templates (~40 lines)

When `N >= MIN_TRACES_TO_PROMOTE` (suggest: 3) traces share the same skeleton, auto-promote to a named template:

```typescript
const MIN_TRACES_TO_PROMOTE = 3;
const KNOWN_PATTERNS: GoalPattern[] = [];

/**
 * After recording a trace, check if its skeleton qualifies for pattern promotion.
 * Called from recordTrace().
 */
export function tryPromotePattern(trace: ExecutionTrace & { skeleton: string }): void {
  const matchingPatterns = KNOWN_PATTERNS.filter(p => 
    skeletonSimilarity(p.skeleton, trace.skeleton) >= 0.85
  );
  
  if (matchingPatterns.length > 0) {
    // Strengthen existing pattern
    matchingPatterns[0].traceIds.push(trace.id);
    if (matchingPatterns[0].traceIds.length >= MIN_TRACES_TO_PROMOTE) {
      matchingPatterns[0].promoted = true;
    }
  } else {
    // Register new candidate pattern
    KNOWN_PATTERNS.push({
      id: `pattern_${Date.now()}`,
      skeleton: trace.skeleton,
      service: trace.service,
      intent: trace.intent,
      traceIds: [trace.id],
      regexPattern: buildRegexFromSkeleton(trace.skeleton),
      promoted: false,
      createdAt: new Date().toISOString(),
      slots: inferSlotsFromSkeleton(trace.skeleton),
    });
  }
}

/**
 * Convert skeleton string to a regex that can match new goals.
 * "play SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM"
 * → /^play (.+?) by (.+?) on (youtube|google|spotify|...)$/i
 */
function buildRegexFromSkeleton(skeleton: string): string {
  const slotRegex = {
    SLOT_ENTITY: "(.+?)",
    SLOT_CREATOR: "(.+?)",
    SLOT_PLATFORM: `(${PLATFORM_WORDS.join("|")})`,
    SLOT_QUERY: "(.+?)",
    SLOT_ORG: "([A-Za-z0-9 ]+)",
  };
  
  let pattern = skeleton;
  for (const [slot, rx] of Object.entries(slotRegex)) {
    pattern = pattern.replace(new RegExp(slot, "g"), rx);
  }
  return "^" + pattern + "$";
}
```

### 3.7 Integration Points (Changes to Existing Files)

#### trace.ts modifications:
1. Add `skeleton?: string` to `ExecutionTrace` interface (backward-compatible optional)
2. In `recordTrace()`: call `extractFingerprint()` and store `skeleton` in the trace
3. In `scoreTrace()`: add `incomingSkeleton?` param, use `skeletonSimilarity()` when present
4. In `findBestTrace()`: compute incoming fingerprint once, pass to `scoreTrace()`
5. In `computeSubstitutions()`: use `computeSkeletonSubstitutions()` when both traces have skeletons

#### compiler.ts modifications:
- None required — the skeleton extractor consumes the already-compiled `ExecutionPlan`

#### New file: `src/pattern.ts`
- `extractFingerprint(rawGoal, plan): StructuralFingerprint`
- `skeletonSimilarity(skelA, skelB): number`
- `computeSkeletonSubstitutions(traceFingerprint, incomingFingerprint): Record<string,string>`
- `tryPromotePattern(trace): void`
- `matchPattern(goal): PatternMatch | null` (direct regex match against promoted patterns)

---

## 4. Full Data Flow Diagram

```
New goal: "play besharam rang by deepika on youtube"
    │
    ▼
compiler.ts:fastCompileGoal()
    → { service: "youtube", intent: "media_play",
        targetName: "besharam rang", creatorOrOrg: "deepika" }
    │
    ▼
pattern.ts:extractFingerprint()
    → skeleton: "play SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM"
      slots: { SLOT_ENTITY: "besharam rang", SLOT_CREATOR: "deepika", SLOT_PLATFORM: "youtube" }
    │
    ├─► matchPattern() — direct regex match against promoted templates
    │     → If match: instant substitution, no trace scan needed
    │
    └─► findBestTrace() — skeleton-aware scoring
          ├── scoreTrace(trace₁, skeleton="play SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM")
          │     → score: 0.35 + 0.20 + 0.35*1.0 = 0.90  ← HIGH MATCH
          ├── scoreTrace(trace₂, skeleton="search SLOT_QUERY on SLOT_PLATFORM")
          │     → score: 0.35 + 0.00 + 0.35*0.15 = 0.40  ← BELOW THRESHOLD
          └── Returns trace₁ with score=0.90
                  │
                  ▼
          computeSkeletonSubstitutions()
            → { "millionaire": "besharam rang", "honey singh": "deepika" }
                  │
                  ▼
          buildReplaySteps() — apply substitutions
            → navigate("youtube.com/search?q=besharam+rang+deepika")
            → act("click 'besharam rang deepika' video result")
            → ...
```

---

## 5. Implementation Estimate

| Component | Lines of TypeScript | Complexity |
|-----------|---------------------|------------|
| `pattern.ts` — full new file | ~120 lines | Medium |
| `trace.ts` modifications | ~30 lines changed | Low |
| `data/patterns.json` — pattern storage | schema only | Trivial |
| Tests | ~50 lines | Low |
| **Total new code** | **~200 lines** | - |

---

## 6. Pitfalls and Edge Cases

### 6.1 Skeleton Collision Risk
Two different intents can produce the same skeleton:
- `"find jobs by google on linkedin"` → skeleton = `"find SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM"`
- `"play songs by dua lipa on spotify"` → same skeleton

**Mitigation**: Always require `service + intent` match first before skeleton comparison (already done in `scoreTrace()`).

### 6.2 Multi-Word Slots
`"play lean on me by bill withers"` — "on" is part of the song title AND a preposition.

**Mitigation**: Compiler already handles this via greedy matching in regex patterns A/B/C. The skeleton extractor inherits the compiler's slot values — it does NOT re-parse from scratch. This is the key architectural advantage of piggybacking on `compiler.ts`.

### 6.3 Missing Slots
`"play millionaire on youtube"` — no `by` clause, no creator slot.
Skeleton: `"play SLOT_ENTITY on SLOT_PLATFORM"` (only 2 slots)

This is a **valid, distinct pattern** from `"play SLOT_ENTITY by SLOT_CREATOR on SLOT_PLATFORM"` (3 slots). The skeleton similarity between them:
- Tokens: `{play, SLOT_ENTITY, on, SLOT_PLATFORM}` vs `{play, SLOT_ENTITY, by, SLOT_CREATOR, on, SLOT_PLATFORM}`
- Jaccard: 4/6 = 0.67 + verb bonus 0.15 = 0.82 → still matches!

This is correct behavior — "play X on youtube" and "play X by Y on youtube" share the same execution path (search → click result). The substitution just has one fewer slot.

### 6.4 Skeleton Drift
When `compiler.ts` is updated (e.g., new regex patterns), existing stored skeletons may differ from what new goals produce.

**Mitigation**: Make skeleton computation **idempotent** from the same compiler output. Since skeleton = f(plan), not f(rawGoal), as long as `compiler.ts` produces the same plan for the same goal class, skeletons remain stable.

### 6.5 Non-English Goals
"youtube par millionaire honey singh ka gaana chalao" — Hindi goal.

Skeleton extraction falls back gracefully: `fastCompileGoal()` may not parse it, falls through to LLM, which returns `targetName`/`creatorOrOrg`. The skeleton extractor then works normally on the compiled plan.

---

## 7. Recommended File Layout

```
src/
  compiler.ts     ← existing (no changes)
  trace.ts        ← add skeleton field + skeleton-aware scoring
  pattern.ts      ← NEW: fingerprinting, skeleton similarity, pattern library
  
data/
  traces.json     ← existing (backward-compatible: skeleton field optional)
  patterns.json   ← NEW: promoted pattern templates
```

---

## 8. Quick Start — The Minimum Viable Change

If you want to ship in one PR without the full pattern library, the highest-ROI change is:

**Add skeleton computation to `recordTrace()` and `findBestTrace()`**:

1. On record: `trace.skeleton = extractFingerprint(goal, plan).skeleton`
2. On find: compute `incomingSkeleton`, pass to `scoreTrace()`, use `skeletonSimilarity()` instead of Jaccard
3. On substitution: use `computeSkeletonSubstitutions()` instead of positional token logic

This alone fixes the broken substitution for "honey singh → 2 tokens when trace stored 1-token artist" bug and enables structural replay for zero-overlap goals.

The pattern library (auto-promotion, regex matching) can be added incrementally.
