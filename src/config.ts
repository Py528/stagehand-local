import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./types.js";

export function getCliOption(flags: string[]): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (flags.includes(a) && i + 1 < argv.length) {
      return argv[i + 1];
    }
    for (const f of flags) {
      if (a.startsWith(`${f}=`)) {
        return a.slice(f.length + 1);
      }
    }
  }
  return undefined;
}

export function hasCliFlag(flags: string[]): boolean {
  const argv = process.argv.slice(2);
  return argv.some((a) => flags.includes(a));
}

export const customConfig = getCliOption(["--config", "-c"]);
export const CONFIG_PATH = path.resolve(
  customConfig || process.env.STAGEHAND_CONFIG || path.join(process.cwd(), "config.json")
);

export const DEFAULT_CONFIG: Config = {
  llm: {
    baseURL: "http://127.0.0.1:8080/v1",
    apiKey: "not-needed",
    modelId: "unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ4_XS",
    temperature: 0.1,
    stepTimeoutMs: 120000,
  },
  browser: {
    headless: false,
    defaultTimeout: 30000,
    useOwnBrowser: false,
    keepBrowserOpen: true,
    disableSecurity: false,
    windowWidth: 1280,
    windowHeight: 1100,
    browserBinaryPath: undefined,
    browserUserDataDir: undefined,
    cdpUrl: undefined,
    wssUrl: undefined,
    recordingPath: "./tmp/record_videos",
    tracePath: "./tmp/traces",
    agentHistoryPath: "./tmp/agent_history",
    downloadPath: "./tmp/downloads",
  },
  agent: {
    maxSteps: 10,
    maxRetries: 2,
    domSettleMs: 1500,
    postActionMs: 800,
    synthesize: true,
    contextWindowChars: 24000,
  },
  shortcuts: {
    youtube: "https://www.youtube.com/results?search_query={{query}}",
    google: "https://www.google.com/search?q={{query}}&hl=en",
    github: "https://github.com/search?q={{query}}&type=repositories",
    hn: "https://hn.algolia.com/?q={{query}}",
    npm: "https://www.npmjs.com/search?q={{query}}",
  },
  cookieDismiss: [
    "Accept all",
    "Accept all cookies",
    "Accept cookies",
    "Accept & continue",
    "I agree",
    "Agree",
    "Got it",
    "OK",
    "Dismiss",
    "Allow all",
    "Allow cookies",
    "Continue",
    "Close",
  ],
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return {
      llm: { ...DEFAULT_CONFIG.llm, ...raw.llm },
      browser: { ...DEFAULT_CONFIG.browser, ...raw.browser },
      agent: { ...DEFAULT_CONFIG.agent, ...raw.agent },
      shortcuts: { ...DEFAULT_CONFIG.shortcuts, ...raw.shortcuts },
      cookieDismiss: raw.cookieDismiss ?? DEFAULT_CONFIG.cookieDismiss,
    };
  } catch (e: any) {
    console.warn(`⚠️ Failed to parse ${CONFIG_PATH}: ${e.message}. Using defaults.`);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(newCfg: Partial<Config>): void {
  try {
    const current = loadConfig();
    const merged = {
      ...current,
      ...newCfg,
      llm: { ...current.llm, ...newCfg.llm },
      browser: { ...current.browser, ...newCfg.browser },
      agent: { ...current.agent, ...newCfg.agent },
      shortcuts: { ...current.shortcuts, ...newCfg.shortcuts },
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
  } catch (e: any) {
    console.error(`❌ Failed to save config to ${CONFIG_PATH}:`, e.message);
  }
}

export const cfg = loadConfig();

// Environment variable overrides
if (process.env.LLAMA_BASE_URL) cfg.llm.baseURL = process.env.LLAMA_BASE_URL;
if (process.env.MODEL_ID) cfg.llm.modelId = process.env.MODEL_ID;
if (process.env.HEADLESS) cfg.browser.headless = process.env.HEADLESS === "true";
if (hasCliFlag(["--headless"])) cfg.browser.headless = true;
if (hasCliFlag(["--headed", "--no-headless"])) cfg.browser.headless = false;
if (hasCliFlag(["--use-own-browser", "--my-browser", "--own-browser"])) cfg.browser.useOwnBrowser = true;
if (process.env.USE_OWN_BROWSER) cfg.browser.useOwnBrowser = ["true", "1", "yes"].includes(process.env.USE_OWN_BROWSER.toLowerCase());
if (hasCliFlag(["--keep-browser-open"])) cfg.browser.keepBrowserOpen = true;
if (process.env.KEEP_BROWSER_OPEN) cfg.browser.keepBrowserOpen = ["true", "1", "yes"].includes(process.env.KEEP_BROWSER_OPEN.toLowerCase());
if (hasCliFlag(["--disable-security"])) cfg.browser.disableSecurity = true;
if (process.env.DISABLE_SECURITY) cfg.browser.disableSecurity = ["true", "1", "yes"].includes(process.env.DISABLE_SECURITY.toLowerCase());
if (process.env.BROWSER_PATH) cfg.browser.browserBinaryPath = process.env.BROWSER_PATH;
if (process.env.BROWSER_USER_DATA) cfg.browser.browserUserDataDir = process.env.BROWSER_USER_DATA;
const cdpCli = getCliOption(["--cdp", "--cdp-url"]);
if (cdpCli) cfg.browser.cdpUrl = cdpCli;
if (process.env.BROWSER_CDP) cfg.browser.cdpUrl = process.env.BROWSER_CDP;
const wssCli = getCliOption(["--wss", "--wss-url"]);
if (wssCli) cfg.browser.wssUrl = wssCli;
if (process.env.BROWSER_WSS) cfg.browser.wssUrl = process.env.BROWSER_WSS;
if (process.env.MAX_STEPS) cfg.agent.maxSteps = parseInt(process.env.MAX_STEPS, 10);
