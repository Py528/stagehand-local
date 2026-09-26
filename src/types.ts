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

export interface SessionState {
  lastExtraction: string;
  lastAnswer: string;
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
