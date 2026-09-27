import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { cfg } from "./config.js";
import { createStagehandModelHandler } from "./llm.js";
import { setupRouteBlocking } from "./browser.js";
import { resolveBrowserLaunchConfig, detectDefaultBrowser } from "./browser_resolver.js";

export type BrowserMode = "clean" | "own";

export interface BrowserSessionState {
  browser: any;
  sh: Stagehand;
  page: any;
  mode: BrowserMode;
  browserName: string;
}

let activeSession: BrowserSessionState | null = null;
let isSwitching = false;

export function getCurrentBrowserMode(): BrowserMode {
  return activeSession?.mode || (cfg.browser.useOwnBrowser ? "own" : "clean");
}

export function getActiveSessionState(): BrowserSessionState | null {
  return activeSession;
}

/**
 * Initializes or switches the browser session between clean Playwright Chromium
 * and the user's default browser (Google Chrome / Arc / Brave) with full sessions.
 */
export async function getOrSwitchBrowser(
  targetMode?: BrowserMode,
  options?: { headless?: boolean }
): Promise<BrowserSessionState> {
  const desiredMode: BrowserMode = targetMode || (cfg.browser.useOwnBrowser ? "own" : "clean");

  if (activeSession && activeSession.mode === desiredMode && !isSwitching) {
    try {
      const pages = await activeSession.browser.context.pages();
      if (pages.length > 0) {
        return activeSession;
      }
    } catch {
      // Browser was closed or disconnected, recreate
      activeSession = null;
    }
  }

  isSwitching = true;
  try {
    // Gracefully close previous session if mode changed
    if (activeSession) {
      console.log(`🔄 Switching browser mode from [${activeSession.mode}] to [${desiredMode}]...`);
      try { await activeSession.sh.close().catch(() => {}); } catch {}
      try { await activeSession.browser.close().catch(() => {}); } catch {}
      activeSession = null;
    }

    const isOwn = desiredMode === "own";
    const launchConfig = await resolveBrowserLaunchConfig(isOwn, {
      headless: options?.headless ?? cfg.browser.headless,
      browserBinaryPath: cfg.browser.browserBinaryPath,
      browserUserDataDir: cfg.browser.browserUserDataDir,
      cdpUrl: cfg.browser.cdpUrl,
    });

    console.log(`🚀 Launching browser: ${launchConfig.browserName} (${desiredMode.toUpperCase()} mode)...`);

    let browser: any;
    if (launchConfig.cdpUrl) {
      console.log(`🔌 Connecting over CDP to ${launchConfig.cdpUrl}...`);
      browser = await localBrowser.connect({ cdpUrl: launchConfig.cdpUrl });
    } else {
      const launchOptions: any = {
        headless: options?.headless ?? cfg.browser.headless,
        args: launchConfig.args,
      };
      if (launchConfig.executablePath) {
        launchOptions.executablePath = launchConfig.executablePath;
      }
      if (launchConfig.userDataDir) {
        launchOptions.userDataDir = launchConfig.userDataDir;
        launchOptions.preserveUserDataDir = true;
      }
      if (isOwn) {
        // Prevent Stagehand from blocking Keychain access so all cookies & logins decrypt
        launchOptions.ignoreDefaultArgs = ["--use-mock-keychain", "--password-store=basic"];
      }
      browser = await localBrowser.launch(launchOptions);
    }

    const sh = await Stagehand.create({
      browser,
      model: createStagehandModelHandler(),
      logging: { level: "warn" },
    });

    if (browser.context) {
      await setupRouteBlocking(browser.context);
    }

    const pages = await browser.context.pages();
    const page = pages.length > 0 ? pages[0] : await browser.context.newPage();

    activeSession = {
      browser,
      sh,
      page,
      mode: desiredMode,
      browserName: launchConfig.browserName,
    };

    return activeSession;
  } finally {
    isSwitching = false;
  }
}

/**
 * Closes the active session on process termination.
 */
export async function closeActiveBrowserSession(): Promise<void> {
  if (activeSession) {
    try { await activeSession.sh.close().catch(() => {}); } catch {}
    try { await activeSession.browser.close().catch(() => {}); } catch {}
    activeSession = null;
  }
}
