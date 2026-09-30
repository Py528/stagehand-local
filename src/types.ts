export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  modelId: string;
  temperature: number;
  stepTimeoutMs: number;
}

export interface BrowserConfig {
  headless: boolean;
  defaultTimeout: number;
  useOwnBrowser?: boolean | undefined;
  keepBrowserOpen?: boolean | undefined;
  disableSecurity?: boolean | undefined;
  windowWidth?: number | undefined;
  windowHeight?: number | undefined;
  browserBinaryPath?: string | undefined;
  browserUserDataDir?: string | undefined;
  cdpUrl?: string | undefined;
  wssUrl?: string | undefined;
  recordingPath?: string | undefined;
  tracePath?: string | undefined;
  agentHistoryPath?: string | undefined;
  downloadPath?: string | undefined;
}

export interface AgentConfig {
  maxSteps: number;
  maxRetries: number;
  domSettleMs: number;
  postActionMs: number;
  synthesize: boolean;
  contextWindowChars: number;
}

export interface Config {
  llm: LLMConfig;
  browser: BrowserConfig;
  agent: AgentConfig;
  shortcuts: Record<string, string>;
  cookieDismiss: string[];
}

export interface ConversationEntry {
  role: "user" | "assistant" | "data";
  content: string;
  /** Optional label: "extraction", "answer", "user_input", "resume", etc. */
  label?: string;
  /** If true, this entry will never be evicted when context budget is exceeded */
  pinned?: boolean;
}

export interface AttachedFile {
  filename: string;
  path: string;
  wordCount: number;
  content: string;
}

export interface BatchResult {
  url: string;
  company: string;
  data: string;
  error: string;
}

export interface HistoryEntry {
  ts: string;
  url: string;
  goal: string;
  result: string;
}

export interface SessionMetrics {
  tier0: number;
  tier1: number;
  tier2: number;
  tokensSaved: number;
}

/** Where the answer came from — used for source badge in the UI */
export type AnswerSource =
  | "google_serp"      // Google SERP snippet / AI overview (unverified)
  | "direct_site"      // Agent navigated to the actual site and extracted
  | "playbook_api"     // ATS API (Ashby / Greenhouse / Lever) — structured data
  | "pattern_replay"   // Tier 0.4 pattern replay
  | "trace_replay"     // Tier 0.5 trace replay
  | "conversational"   // handleConversational — answered from session memory
  | "heuristic"        // Tier 0 heuristic (e.g. YouTube watch page check)
  | "generic";         // Default / unknown

export interface SessionState {
  lastExtraction: string;
  lastAnswer: string;
  lastSource: AnswerSource;    // source of the last answer, for UI badge
  conversation: ConversationEntry[];
  batchResults: BatchResult[];
  history: HistoryEntry[];
  attachedFiles: AttachedFile[];
  metrics?: SessionMetrics;
}

export type PlanAction =
  | { action: "navigate"; url: string }
  | { action: "act"; instruction: string }
  | { action: "extract"; instruction: string }
  | { action: "wait"; ms?: number }
  | { action: "done"; message: string };
