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

/** Pin the latest extraction, unpinning older extractions so only the most recent remains pinned. */
export function pinLatestExtraction(content: string, sourceUrl: string): void {
  for (const entry of session.conversation) {
    if (entry.label === "extraction") {
      entry.pinned = false;
    }
  }
  session.lastExtraction = content;
  addToConversation({
    role: "data",
    content: `Extracted from ${sourceUrl}:\n${content}`,
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

export async function resolvePromptFiles(line: string): Promise<string> {
  const atMatches = line.match(/@([^\s"']+)/g);
  if (!atMatches) return line;

  let updated = line;
  for (const match of atMatches) {
    let rawPath = match.slice(1);
    if (rawPath.includes("@") || /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(match)) continue;

    // Strip trailing punctuation
    const trailingPunct = rawPath.match(/[?!,;:)\u007d\]]+$/)?.[0] || "";
    if (trailingPunct) {
      rawPath = rawPath.slice(0, -trailingPunct.length);
    }

    const file = await readFileContent(rawPath);
    if (file) {
      await attachFileToSession(rawPath);
      updated = updated.replace(`@${rawPath}`, `[Attached File: ${file.filename}]`);
    }
  }
  return updated;
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

  // Navigation/action keywords → definitely web
  const webKeywords = /\b(go to|goto|open|navigate|search|find|click|visit|play|download|check|verify|look up|browse)\b/i;
  if (webKeywords.test(trimmed)) return false;

  // Questions that reference previously extracted data
  const refSignals = /\b(the roles|the jobs|those|that data|the extraction|earlier|previous|above|last)\b/i;
  if (refSignals.test(trimmed)) return true;

  // Narrow this: require an explicit reference to prior data or analysis, not just any pronoun
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

  try {
    const c: any = await withTimeout(
      localClient.chat.completions.create({
        model: cfg.llm.modelId,
        messages: [
          {
            role: "system",
            content: `You are an expert AI assistant with access to the user's browsing and session history.
The user has been browsing websites and extracting data. Below is the conversation context including any data extracted from websites, user-provided documents (resumes, etc.), and prior Q&A.

Session Context:
${context || "(No prior context in this session yet.)"}

Rules:
- Answer the user's question directly, concisely, and accurately based on the session context.
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
