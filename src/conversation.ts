import path from "node:path";
import { cfg } from "./config.js";
import { isNearDuplicate, withTimeout } from "./utils.js";
import { readFileContent } from "./files.js";
import type { ConversationEntry, SessionState, SessionMetrics } from "./types.js";

export const sessionMetrics: SessionMetrics = {
  tier0: 0,
  tier1: 0,
  tier2: 0,
  tokensSaved: 0,
};

let metricsLogged = false;

export function resetSessionMetrics(): void {
  sessionMetrics.tier0 = 0;
  sessionMetrics.tier1 = 0;
  sessionMetrics.tier2 = 0;
  sessionMetrics.tokensSaved = 0;
  metricsLogged = false;
}

/**
 * Soft-reset session for a new task.
 *
 * HARD reset (full clear): use resetSession().
 * SOFT reset: preserves the last extraction and answer from the previous task
 * so immediate follow-up questions can reference them without re-navigating.
 *
 * Example: user asks "banh house hours?" → agent extracts hours → user asks
 * "can I visit at 4:30?" → soft reset keeps hours in context → LLM answers directly.
 *
 * Rule: carry forward ONLY the single most recent pinned extraction + answer.
 * Everything else (history, metrics, old conversation) is cleared.
 */
export function softResetSession(): void {
  // Carry forward ALL pinned FACTUAL extractions + the last answer from the previous task.
  // EXCLUDE media extractions (song lyrics, video captions) — they're noise for follow-ups.
  // This allows: "check banh house hours" → "can I visit at 4:30?" without re-navigating.
  const isMediaExtraction = (e: ConversationEntry): boolean => {
    const c = e.content;
    // Exclude if contains song lyrics markers (Hindi [संगीत], English [music], or ♪)
    if (/\[संगीत\]|\[music\]|♪|\blyrics?\b/i.test(c)) return true;
    // Exclude if extracted from a YouTube watch page or Spotify
    if (/Extracted from.*youtube\.com\/watch|Extracted from.*spotify\.com/i.test(c)) return true;
    return false;
  };
  const pinnedExtractions = session.conversation.filter(
    (e) => e.label === "extraction" && e.pinned && !isMediaExtraction(e)
  );
  const lastAnswer = session.conversation.findLast(
    (e) => e.label === "answer"
  );

  // Keep the most recent extraction's content in lastExtraction for quick access
  const lastExtraction = pinnedExtractions[pinnedExtractions.length - 1];
  session.lastExtraction = lastExtraction?.content.split("\n").slice(1).join("\n") ?? "";
  session.lastAnswer = "";  // answer is in conversation entries, not needed separately
  session.batchResults = [];
  session.history = [];

  // Rebuild conversation: all pinned extractions + last answer (most recent context only)
  const carried: ConversationEntry[] = [];
  for (const ext of pinnedExtractions) carried.push({ ...ext, pinned: true });
  if (lastAnswer) carried.push({ ...lastAnswer, pinned: false });
  session.conversation = carried;

  // Keep attachedFiles — user may want to keep docs across tasks
  resetSessionMetrics();
}

/**
 * Full clear — wipes everything including carried context.
 * Use for truly unrelated tasks or explicit /reset commands.
 */
export function resetSession(): void {
  session.lastExtraction = "";
  session.lastAnswer = "";
  session.conversation = [];
  session.batchResults = [];
  session.history = [];
  // Intentionally keep attachedFiles — user may want to keep their resume/docs across tasks
  resetSessionMetrics();
}

export function logSessionMetrics(): void {
  if (metricsLogged) return;
  metricsLogged = true;
  const skipped = sessionMetrics.tier0 + sessionMetrics.tier1;
  console.log(
    `📊 [Execution Stats] Tier 0 (Heuristic): ${sessionMetrics.tier0} | Tier 1 (Playbook): ${sessionMetrics.tier1} | Tier 2 (LLM): ${sessionMetrics.tier2} | LLM Calls Skipped: ${skipped}`
  );
}

export const session: SessionState = {
  lastExtraction: "",
  lastAnswer: "",
  conversation: [],
  batchResults: [],
  history: [],
  attachedFiles: [],
  metrics: sessionMetrics,
};

/** Add an entry to the conversation buffer, trimming unpinned entries to stay under contextWindowChars. */
export function addToConversation(entry: ConversationEntry): void {
  // Deduplicate user-provided data / pastes
  if (entry.role === "user" && entry.label === "user_provided_data") {
    const dupIdx = session.conversation.findIndex(
      (e) => e.label === "user_provided_data" && isNearDuplicate(e.content, entry.content)
    );
    if (dupIdx !== -1) {
      session.conversation[dupIdx] = entry; // replace, don't duplicate
      return;
    }
  }

  // Deduplicate file attachments
  if (entry.label?.startsWith("file:")) {
    const dupIdx = session.conversation.findIndex((e) => e.label === entry.label);
    if (dupIdx !== -1) {
      session.conversation[dupIdx] = entry;
      return;
    }
  }

  session.conversation.push(entry);

  let totalChars = session.conversation.reduce((s, e) => s + e.content.length, 0);
  while (totalChars > cfg.agent.contextWindowChars) {
    const idx = session.conversation.findIndex((e) => !e.pinned);
    if (idx === -1) break; // everything is pinned, nothing left to evict
    const [removed] = session.conversation.splice(idx, 1);
    if (removed) {
      totalChars -= removed.content.length;
      console.warn(`   ⚠️ Context budget exceeded — dropped [${removed.label || removed.role}] (${removed.content.length} chars)`);
    }
  }
}

/** Pin a new extraction, keeping all previous pinned extractions too.
 *  Deduplicates: if the same URL (normalized, no query params) was already pinned, replace in-place.
 *  All extractions stay pinned so softResetSession can carry ALL of them to the next task. */
export function pinLatestExtraction(content: string, sourceUrl: string): void {
  session.lastExtraction = content;

  // Normalize URL for dedup: strip query params and fragments, keep only scheme+host+path
  const normalizeUrl = (u: string): string => {
    try {
      const parsed = new URL(u);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return u.split("?")[0] ?? u;
    }
  };
  const normalizedSource = normalizeUrl(sourceUrl);

  // Deduplicate: if an extraction from this normalized URL already exists, replace it
  const newContent = `Extracted from ${sourceUrl}:\n${content}`;
  const existingIdx = session.conversation.findIndex(
    (e) => e.label === "extraction" && normalizeUrl(
      e.content.match(/^Extracted from ([^\n]+):/)?.[1] ?? ""
    ) === normalizedSource
  );
  if (existingIdx !== -1) {
    session.conversation[existingIdx] = {
      role: "data",
      content: newContent,
      label: "extraction",
      pinned: true,
    };
    return;
  }

  addToConversation({
    role: "data",
    content: newContent,
    label: "extraction",
    pinned: true,
  });
}

/** Build a context summary from the conversation buffer for the LLM. */
export function getConversationContext(): string {
  if (session.conversation.length === 0) return "";
  const lines = session.conversation.map((e) => {
    const tag = e.label ? `[${e.label}]` : `[${e.role}]`;
    // Truncate individual entries to keep context manageable
    const content = e.content.length > 1500 ? e.content.slice(0, 1500) + "..." : e.content;
    return `${tag} ${content}`;
  });
  return lines.join("\n\n");
}

export async function attachFileToSession(filePath: string): Promise<boolean> {
  const file = await readFileContent(filePath);
  if (!file) {
    console.error(`❌ File not found or unreadable: ${filePath}\n`);
    return false;
  }

  const existingIdx = session.attachedFiles.findIndex((f) => f.path === file.path);
  if (existingIdx !== -1) {
    session.attachedFiles[existingIdx] = file;
  } else {
    session.attachedFiles.push(file);
  }

  addToConversation({
    role: "data",
    content: `[Attached File: ${file.filename}]\n${file.content}`,
    label: `file:${file.filename}`,
    pinned: true,
  });

  const sizeKb = (file.content.length / 1024).toFixed(1);
  console.log(`\n📎 Attached "${file.filename}" (${file.wordCount.toLocaleString()} words / ${sizeKb} KB) to session context.\n`);
  return true;
}

export interface AttachmentValidationResult {
  ok: boolean;
  resolvedInput: string;
  error?: string | undefined;
  missingFile?: string | undefined;
}

export async function validateAndResolveAttachments(
  input: string
): Promise<AttachmentValidationResult> {
  let updated = input;

  // 1. Check for @file references (e.g. @spec.txt, @"my doc.pdf", etc.)
  // Must be preceded by start-of-line, whitespace, or bracket/punctuation to avoid matching emails (e.g. support@stripe.com)
  const atRegex = /(?:^|[\s(\[{,;:])@(?:["']([^"']+)["']|([^\s"']+))/g;
  let atMatch: RegExpExecArray | null;
  while ((atMatch = atRegex.exec(input)) !== null) {
    let rawPath = atMatch[1] || atMatch[2] || "";
    const fullMatched = atMatch[0];
    const atToken = fullMatched.slice(fullMatched.indexOf("@"));

    // Skip if it looks like an email or part of an email address
    if (rawPath.includes("@") || /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(rawPath)) {
      continue;
    }

    // Strip trailing punctuation from unquoted matches
    if (!atMatch[1]) {
      const trailingPunct = rawPath.match(/[?!,;:)\}\]]+$/)?.[0] || "";
      if (trailingPunct) {
        rawPath = rawPath.slice(0, -trailingPunct.length);
      }
    }

    if (!rawPath.trim()) continue;

    // Check if already attached in session
    const existing = session.attachedFiles.find(
      (f) =>
        f.filename.toLowerCase() === path.basename(rawPath).toLowerCase() ||
        f.path.toLowerCase() === path.resolve(rawPath).toLowerCase()
    );

    if (existing) {
      updated = updated.replace(atToken, `[Attached File: ${existing.filename}]`);
      continue;
    }

    // Try reading from disk
    const file = await readFileContent(rawPath);
    if (file) {
      await attachFileToSession(rawPath);
      updated = updated.replace(atToken, `[Attached File: ${file.filename}]`);
    } else {
      return {
        ok: false,
        resolvedInput: input,
        missingFile: rawPath,
        error: `You referenced "${rawPath}" via @${rawPath}, but no matching attachment exists in session context and it was not found on disk. Please attach it first using '/attach <path>' or place the file in the workspace.`,
      };
    }
  }

  // 2. Check for explicit natural language references to named files
  // e.g. "attached spec.txt", "the attached spec.txt", "based on the attached spec.txt", "spec.txt attached"
  const namedFileRegexes = [
    /\b(?:the\s+)?attached\s+(?:file\s+)?([a-zA-Z0-9_\-.]+\.[a-zA-Z0-9]{1,10})\b/gi,
    /\battachment\s+([a-zA-Z0-9_\-.]+\.[a-zA-Z0-9]{1,10})\b/gi,
    /\b([a-zA-Z0-9_\-.]+\.[a-zA-Z0-9]{1,10})\s+is\s+attached\b/gi,
  ];

  for (const regex of namedFileRegexes) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(input)) !== null) {
      const referencedName = m[1];
      if (!referencedName) continue;
      // Skip URLs / domains (e.g. news.ycombinator.com, stripe.com)
      if (
        /^(?:https?:\/\/|[a-z0-9-]+\.[a-z]{2,})/i.test(referencedName) &&
        /\b(?:com|org|net|io|dev|ai|html?|php)\b/i.test(referencedName)
      ) {
        continue;
      }

      const existing = session.attachedFiles.find(
        (f) => f.filename.toLowerCase() === referencedName.toLowerCase()
      );

      if (!existing) {
        // Try auto-attaching from disk
        const file = await readFileContent(referencedName);
        if (file) {
          await attachFileToSession(referencedName);
        } else {
          return {
            ok: false,
            resolvedInput: input,
            missingFile: referencedName,
            error: `You referenced "${referencedName}" as an attached file, but no matching attachment exists in session context. Please attach it first using '@${referencedName}' or '/attach <path>'.`,
          };
        }
      }
    }
  }

  // 3. Check for general references to an attached file when session has none
  const generalAttachmentRegex =
    /\b(?:based\s+on\s+)?(?:the\s+)?attached\s+(?:file|document|spec|resume|cv|requirements|spreadsheet|data)\b|\b(?:the\s+)?attachment\b/i;
  if (generalAttachmentRegex.test(input) && session.attachedFiles.length === 0) {
    return {
      ok: false,
      resolvedInput: input,
      error: `You referenced an attached file/document, but no files are currently attached to this session. Please attach the required file using '@filename' or '/attach <path>' before running this task.`,
    };
  }

  return {
    ok: true,
    resolvedInput: updated,
  };
}

export async function resolvePromptFiles(line: string): Promise<string> {
  const res = await validateAndResolveAttachments(line);
  if (!res.ok) {
    throw new Error(res.error);
  }
  return res.resolvedInput;
}

export function isConversational(input: string): boolean {
  const trimmed = input.trim();

  // Large paste (>300 chars, no URL) → user is providing context (resume, data, etc.)
  if (trimmed.length > 300 && !/https?:\/\//i.test(trimmed)) return true;

  // Explicit think/ask prefix
  if (/^(think|ask|analyze|compare|summarize|review)\s+/i.test(trimmed)) return true;

  // Questions about self, opinions, analysis of prior data (no URL, no domain)
  const hasUrl = /https?:\/\//i.test(trimmed) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(trimmed);
  if (hasUrl) return false;

  // Context-referencing follow-up signals — override webKeywords when prior context exists
  const contextFollowUpSignals = /\b(given|based on|using|with|those|that info|the hours|the timing|the data|the result|i extracted|you found|from earlier|from above|can i|could i|should i|would i|is it|will it|am i|does it|did it)\b/i;
  if (contextFollowUpSignals.test(trimmed) && session.conversation.length > 0) return true;

  // Time/reasoning about extracted data with no navigation intent
  const reasoningSignals = /\b(at \d+:\d+|at \d+ (am|pm)|is it open|can i (go|visit|make it)|timing|timings|hours|opening|closing|am i late|will i|by the time|current time|what time)\b/i;
  if (reasoningSignals.test(trimmed) && session.conversation.length > 0) return true;

  // Navigation/action keywords → definitely web
  // Remove "check" from this list when session has prior context (e.g. "check if banh house is open"
  // should go to web, but "check the timing" with prior context should be conversational)
  const hasContextualCheck =
    /\b(check|verify)\b/i.test(trimmed) &&
    session.conversation.length > 0 &&
    reasoningSignals.test(trimmed); // only bypass "check" when combined with reasoning signals
  const hasContextualVisit = /\bvisit\b.*\d+/i.test(trimmed);
  const relaxedWebKeywords = hasContextualVisit || hasContextualCheck;
  const webKeywords = relaxedWebKeywords
    ? /\b(go to|goto|open|navigate|search|find|click|play|download|look up|browse)\b/i
    : /\b(go to|goto|open|navigate|search|find|click|visit|play|download|check|verify|look up|browse)\b/i;
  if (webKeywords.test(trimmed)) return false;

  // Questions that reference previously extracted data
  const refSignals = /\b(the roles|the jobs|those|that data|the extraction|earlier|previous|above|last)\b/i;
  if (refSignals.test(trimmed)) return true;

  // Explicit reference to prior data or analysis
  const talkSignals = /\b(my resume|my cv|does (it|this|that)|which of (these|those)|compare (this|these|it)|summarize (this|that)|based on (my|the))\b/i;
  if (talkSignals.test(trimmed) && session.conversation.length > 0) return true;

  return false;
}

export async function handleConversational(input: string, localClient: any): Promise<boolean> {
  const isLargePaste = input.length > 300;

  if (isLargePaste) {
    addToConversation({
      role: "user",
      content: input,
      label: "user_provided_data",
      pinned: true,
    });
    console.log(`\n📎 Stored ${input.length} chars of context (resume/data). You can now ask questions about it.\n`);
    if (/\b(experience|education|skills|engineer|developer|intern)\b/i.test(input)) {
      console.log(`   Looks like a resume/CV — pinned in memory for future questions.\n`);
    }
    return true;
  }

  addToConversation({
    role: "user",
    content: input,
    label: "user_question",
  });

  const context = getConversationContext();
  console.log(`\n💭 Thinking...\n`);

  // Always inject current time so the LLM can reason about opening hours, visit times, etc.
  const now = new Date();
  const currentTimeIST = now.toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata"
  });
  const currentDateIST = now.toLocaleDateString("en-IN", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Kolkata"
  });
  const currentTimeInfo = `\nCurrent time (IST): ${currentTimeIST} on ${currentDateIST}`;

  try {
    const c: any = await withTimeout(
      localClient.chat.completions.create({
        model: cfg.llm.modelId,
        messages: [
          {
            role: "system",
            content: `You are an expert AI assistant with access to the user's browsing and session history.
The user has been browsing websites and extracting data. Below is the conversation context including any data extracted from websites, user-provided documents (resumes, etc.), and prior Q&A.
${currentTimeInfo}

Session Context:
${context || "(No prior context in this session yet.)"}

Rules:
- Answer the user's question directly, concisely, and accurately based on the session context.
- The current date and time (IST) is provided above — use it for any questions about "now", "today", "current time", whether somewhere is "currently open", or "can I visit at X time".
- If the session context contains business hours or opening times, use them together with the current time to answer visit/timing questions.
- If the user asks you to compare a resume/profile against job postings or extracted requirements, do a thorough line-by-line comparison and highlight strengths and gaps.
- If the session context does not contain the specific data needed to answer (e.g. job listings, page content), say so explicitly and tell the user what to attach or extract — do not guess, assume, or use general knowledge as if it were the extracted data.
- Format cleanly with bullet points or tables where appropriate.`,
          },
          { role: "user", content: input },
        ],
        temperature: 0.2,
      }),
      cfg.llm.stepTimeoutMs,
      "Conversational"
    );

    const reply = c?.choices?.[0]?.message?.content?.trim();
    if (reply) {
      session.lastAnswer = reply;
      addToConversation({ role: "assistant", content: reply, label: "answer" });
      console.log(`📢 ${reply}\n`);
      return true;
    }
  } catch (e: any) {
    console.error(`❌ Thinking failed: ${e?.message}`);
  }
  return false;
}
