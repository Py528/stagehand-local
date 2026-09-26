/**
 * compiler.ts — Goal Compiler ($t=0$ Structured Intent Extraction)
 *
 * Compiles raw natural language goals once at t=0 into an unambiguous
 * ExecutionPlan with structured service, search tokens, entity metadata,
 * and timing offsets. Eliminates greedy heuristic misfires and state errors.
 */

import { z } from "zod";
import { localClient } from "./llm.js";
import { cfg } from "./config.js";
import { cleanJson, withTimeout } from "./utils.js";

export const ExecutionPlanSchema = z.object({
  service: z.enum(["youtube", "google", "careers_ats", "generic"]).default("generic"),
  intent: z.enum(["media_play", "info_extract", "form_fill", "general_navigate"]).default("general_navigate"),
  primaryQuery: z.string().describe("Cleaned search query with stop-words removed, e.g. 'anti hero taylor swift' or 'Roboflow careers'"),
  targetName: z.string().optional().describe("Primary subject, song title, or role name"),
  creatorOrOrg: z.string().optional().describe("Artist, channel, or company name"),
  timeOffsetSeconds: z.number().nullable().optional().describe("Specific timestamp or skip offset in seconds, e.g. 60"),
  isAbsoluteSeek: z.boolean().optional().describe("True if seeking to a specific timestamp ('to 1 min'), false if relative offset"),
});

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

/**
 * Fast deterministic compiler for common patterns.
 * Resolves in 0ms without LLM latency.
 */
export function fastCompileGoal(goal: string): ExecutionPlan | null {
  const clean = goal.replace(/[?!.]/g, "").trim();
  const lower = clean.toLowerCase();

  // 1. YouTube playback and seeking: "play <song> by/from <artist> on youtube and skip to 1 min"
  if (lower.includes("youtube") || lower.includes("play ") || lower.includes("watch ")) {
    // Check for skip / seek offset
    let timeOffsetSeconds: number | null = null;
    let isAbsoluteSeek = false;

    const skipMatch = lower.match(/(?:skip|seek|jump)\s+(?:ahead\s+)?(?:to\s+)?(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)/i);
    if (skipMatch && skipMatch[1] && skipMatch[2]) {
      const val = parseInt(skipMatch[1], 10);
      const unit = skipMatch[2].toLowerCase();
      timeOffsetSeconds = unit.startsWith("m") ? val * 60 : unit.startsWith("h") ? val * 3600 : val;
      isAbsoluteSeek = lower.includes("to " + skipMatch[1]) || lower.includes("to " + skipMatch[0]);
    } else {
      const skipNoUnit = lower.match(/(?:skip|seek|jump)\s+(?:ahead\s+)?to\s+(\d+)/i);
      if (skipNoUnit && skipNoUnit[1]) {
        timeOffsetSeconds = parseInt(skipNoUnit[1], 10);
        isAbsoluteSeek = true;
      }
    }

    // Strip out the skip instruction to isolate the search query
    const baseQuery = clean
      .replace(/\s+and\s+(?:skip|seek|jump).*/i, "")
      .replace(/(?:skip|seek|jump)\s+(?:ahead\s+)?(?:to\s+)?\d+\s*\w*/i, "")
      .trim();

    // Extract target & creator
    let targetName: string | undefined;
    let creatorOrOrg: string | undefined;
    let primaryQuery: string | undefined;

    // Pattern A: play ... on youtube from/by ...
    let m = baseQuery.match(/(?:play|watch|listen\s+to|open)\s+(?:the\s+)?(?:video\s+(?:of\s+)?|song\s+(?:of\s+)?|track\s+(?:of\s+)?)?(.+?)\s+on\s+youtube\s+(?:from|by)\s+(.+)/i);
    if (m && m[1] && m[2]) {
      targetName = m[1].trim();
      creatorOrOrg = m[2].trim();
      primaryQuery = `${targetName} ${creatorOrOrg}`;
    }

    // Pattern B: play ... by/from ... on youtube
    if (!primaryQuery) {
      m = baseQuery.match(/(?:play|watch|listen\s+to|open)\s+(?:the\s+)?(?:video\s+(?:of\s+)?|song\s+(?:of\s+)?|track\s+(?:of\s+)?)?(.+?)\s+(?:by|from)\s+(.+?)\s+on\s+youtube/i);
      if (m && m[1] && m[2]) {
        targetName = m[1].trim();
        creatorOrOrg = m[2].trim();
        primaryQuery = `${targetName} ${creatorOrOrg}`;
      }
    }

    // Pattern C: play ... by/from ...
    if (!primaryQuery) {
      m = baseQuery.match(/(?:play|watch|listen\s+to|open)\s+(?:the\s+)?(?:video\s+(?:of\s+)?|song\s+(?:of\s+)?|track\s+(?:of\s+)?)?(.+?)\s+(?:by|from)\s+(.+)/i);
      if (m && m[1] && m[2]) {
        targetName = m[1].trim();
        creatorOrOrg = m[2].trim();
        primaryQuery = `${targetName} ${creatorOrOrg}`;
      }
    }

    // Pattern D: on youtube play ...
    if (!primaryQuery) {
      m = baseQuery.match(/on\s+youtube\s+(?:play|watch|search\s+for|find|open)\s+(.+)/i);
      if (m && m[1]) {
        primaryQuery = m[1].trim();
      }
    }

    // Pattern E: play ... on youtube
    if (!primaryQuery) {
      m = baseQuery.match(/(?:play|watch|listen\s+to|open|search\s+for|find)\s+(?:the\s+)?(?:video\s+(?:of\s+)?|song\s+(?:of\s+)?|track\s+(?:of\s+)?)?(.+?)\s+on\s+youtube/i);
      if (m && m[1]) {
        primaryQuery = m[1].trim();
      }
    }

    if (primaryQuery) {
      return {
        service: "youtube",
        intent: "media_play",
        primaryQuery,
        targetName,
        creatorOrOrg,
        timeOffsetSeconds,
        isAbsoluteSeek,
      };
    }
  }

  // 2. Careers / Job board searches
  if (lower.includes("career") || lower.includes("job") || lower.includes("hiring") || lower.includes("roles")) {
    const orgMatch = clean.match(/(?:at|for|company)\s+([a-zA-Z0-9_\-]+)/i);
    const org = orgMatch?.[1];
    return {
      service: "careers_ats",
      intent: "info_extract",
      primaryQuery: org ? `${org} careers` : clean,
      creatorOrOrg: org,
    };
  }

  return null;
}

/**
 * Compile goal into an ExecutionPlan.
 * Tries fast compiler first (0ms), falls back to local LLM with schema (<300ms).
 */
export async function compileGoal(goal: string): Promise<ExecutionPlan> {
  const fast = fastCompileGoal(goal);
  if (fast) return fast;

  try {
    const response: any = await withTimeout(
      localClient.chat.completions.create({
        model: cfg.llm.modelId,
        messages: [
          {
            role: "system",
            content: `You decompose user browser automation goals into a structured ExecutionPlan JSON.
Schema:
{
  "service": "youtube" | "google" | "careers_ats" | "generic",
  "intent": "media_play" | "info_extract" | "form_fill" | "general_navigate",
  "primaryQuery": string (cleaned search terms with all entity names preserved),
  "targetName": string | null,
  "creatorOrOrg": string | null,
  "timeOffsetSeconds": number | null (e.g. 60 for 1 minute),
  "isAbsoluteSeek": boolean | null
}`,
          },
          { role: "user", content: `Decompose this goal:\n"${goal}"` },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      4000,
      "GoalCompiler"
    );

    const raw = JSON.parse(cleanJson(response?.choices?.[0]?.message?.content ?? "{}"));
    return ExecutionPlanSchema.parse(raw);
  } catch {
    // Graceful fallback to raw goal query
    return {
      service: "generic",
      intent: "general_navigate",
      primaryQuery: goal,
    };
  }
}
