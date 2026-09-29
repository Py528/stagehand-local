import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { cfg } from "./config.js";
import { createStagehandModelHandler } from "./llm.js";
import { setupRouteBlocking, isDashboardUrl } from "./browser.js";
import {
  resolveBrowserLaunchConfig,
  detectDefaultBrowser,
  findInstalledStagehandExtensionId,
} from "./browser_resolver.js";

export type BrowserMode = "clean" | "own";

export interface BrowserSessionState {
  browser: any;
  sh: Stagehand;
  page: any;
  mode: BrowserMode;
  browserName: string;
}

let activeSession: BrowserSessionState | null = null;
let switchPromise: Promise<BrowserSessionState> | null = null;

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
  options?: { headless?: boolean; forceRestart?: boolean }
): Promise<BrowserSessionState> {
  // If a switch is already in flight, wait for it
  if (switchPromise && !options?.forceRestart) {
    return await switchPromise;
  }

  const desiredMode: BrowserMode = targetMode || (cfg.browser.useOwnBrowser ? "own" : "clean");

  if (activeSession && activeSession.mode === desiredMode && !options?.forceRestart) {
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

  switchPromise = (async () => {
    try {
      // Gracefully close previous session if mode changed or forceRestart
      if (activeSession) {
        console.log(`🔄 Switching browser mode from [${activeSession.mode}] to [${desiredMode}]...`);
        try { await activeSession.sh.close().catch(() => {}); } catch {}
        try { await activeSession.browser.close().catch(() => {}); } catch {}
        activeSession = null;
      }

      const isOwn = desiredMode === "own";
      const launchConfig = await resolveBrowserLaunchConfig(isOwn, {
        headless: options?.headless ?? cfg.browser.headless,
        disableSecurity: cfg.browser.disableSecurity,
        windowWidth: cfg.browser.windowWidth,
        windowHeight: cfg.browser.windowHeight,
        browserBinaryPath: cfg.browser.browserBinaryPath,
        browserUserDataDir: cfg.browser.browserUserDataDir,
        cdpUrl: cfg.browser.cdpUrl,
      });

      console.log(`🚀 Launching browser: ${launchConfig.browserName} (${desiredMode.toUpperCase()} mode)...`);

      let browser: any;
      if (launchConfig.cdpUrl) {
        console.log(`🔌 Connecting over CDP to ${launchConfig.cdpUrl}...`);
        const extId = await findInstalledStagehandExtensionId(launchConfig.cdpUrl);
        const connectOpts: any = { cdpUrl: launchConfig.cdpUrl };
        if (extId) {
          connectOpts.extensionId = extId;
        }
        browser = await localBrowser.connect(connectOpts);
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
        if (cfg.browser.windowWidth && cfg.browser.windowHeight) {
          launchOptions.viewport = {
            width: cfg.browser.windowWidth,
            height: cfg.browser.windowHeight,
          };
        }
        if (isOwn) {
          // Allow macOS Keychain access so cookies, logins, and passwords decrypt properly
          launchOptions.ignoreDefaultArgs = [
            "--use-mock-keychain",
            "--password-store=basic",
            "--disable-sync",
            "--disable-component-extensions-with-background-pages",
            "--disable-background-networking",
          ];
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
      let page: any = null;

      // Select an existing non-dashboard page, or create a new tab
      for (const p of pages) {
        const u = await p.url().catch(() => "");
        if (!isDashboardUrl(u)) {
          page = p;
          break;
        }
      }

      if (!page) {
        page = await browser.context.newPage();
      }

      activeSession = {
        browser,
        sh,
        page,
        mode: desiredMode,
        browserName: launchConfig.browserName,
      };

      return activeSession;
    } finally {
      switchPromise = null;
    }
  })();

  return await switchPromise;
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
