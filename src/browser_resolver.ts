import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execSync, spawn } from "node:child_process";
import type { BrowserConfig } from "./types.js";

export interface DetectedBrowser {
  name: string;
  binary: string;
  userDataDir: string;
  isDefault?: boolean;
  bundleId?: string;
  appDir?: string;
}

interface BrowserCandidate {
  name: string;
  binary: string;
  userDataDir: string;
  appDir?: string;
  bundleId?: string;
}

const KNOWN_BROWSERS: Record<string, BrowserCandidate[]> = {
  darwin: [
    {
      name: "Arc",
      binary: "/Applications/Arc.app/Contents/MacOS/Arc",
      userDataDir: "~/Library/Application Support/Arc/User Data",
      appDir: "~/Library/Application Support/Arc",
      bundleId: "company.thebrowser.browser",
    },
    {
      name: "Google Chrome",
      binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      userDataDir: "~/Library/Application Support/Google/Chrome",
      bundleId: "com.google.chrome",
    },
    {
      name: "Brave",
      binary: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
      bundleId: "com.brave.browser",
    },
    {
      name: "Microsoft Edge",
      binary: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      userDataDir: "~/Library/Application Support/Microsoft Edge",
      bundleId: "com.microsoft.edgemac",
    },
    {
      name: "Chromium",
      binary: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      userDataDir: "~/Library/Application Support/Chromium",
      bundleId: "org.chromium.Chromium",
    },
  ],
  linux: [
    {
      name: "Google Chrome",
      binary: "/usr/bin/google-chrome",
      userDataDir: "~/.config/google-chrome",
    },
    {
      name: "Google Chrome Stable",
      binary: "/usr/bin/google-chrome-stable",
      userDataDir: "~/.config/google-chrome",
    },
    {
      name: "Chromium",
      binary: "/usr/bin/chromium-browser",
      userDataDir: "~/.config/chromium",
    },
    {
      name: "Brave",
      binary: "/usr/bin/brave-browser",
      userDataDir: "~/.config/BraveSoftware/Brave-Browser",
    },
  ],
  win32: [
    {
      name: "Google Chrome",
      binary: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      userDataDir: "%LOCALAPPDATA%\\Google\\Chrome\\User Data",
    },
    {
      name: "Google Chrome (x86)",
      binary: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      userDataDir: "%LOCALAPPDATA%\\Google\\Chrome\\User Data",
    },
    {
      name: "Microsoft Edge",
      binary: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      userDataDir: "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data",
    },
    {
      name: "Brave",
      binary: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      userDataDir: "%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data",
    },
  ],
};

export function resolvePath(p: string): string {
  if (!p) return "";
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  if (p.includes("%LOCALAPPDATA%") && process.env.LOCALAPPDATA) {
    return p.replace("%LOCALAPPDATA%", process.env.LOCALAPPDATA);
  }
  return p;
}

/**
 * Checks if a TCP port is open and listening (e.g. Chrome remote debugging port 9222).
 */
export function isCdpActive(host = "127.0.0.1", port = 9222): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Fetches browser version metadata from CDP endpoint.
 */
export async function fetchCdpVersion(url = "http://127.0.0.1:9222"): Promise<any | null> {
  try {
    const normalized = url.endsWith("/") ? url.slice(0, -1) : url;
    const res = await fetch(`${normalized}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (res.ok) {
      return await res.json();
    }
  } catch {}
  return null;
}

/**
 * Checks CDP target list for an existing Stagehand extension instance to avoid reloading loops.
 */
export async function findInstalledStagehandExtensionId(cdpUrl = "http://127.0.0.1:9222"): Promise<string | undefined> {
  try {
    const normalized = cdpUrl.endsWith("/") ? cdpUrl.slice(0, -1) : cdpUrl;
    const res = await fetch(`${normalized}/json/list`, { signal: AbortSignal.timeout(1200) });
    if (res.ok) {
      const targets = await res.json();
      for (const t of targets) {
        const m = t.url?.match(/chrome-extension:\/\/([a-z0-9]+)\//i);
        if (m && (t.title?.includes("Stagehand") || t.url?.includes("service-worker.js") || t.url?.includes("heartbeat"))) {
          return m[1];
        }
      }
    }
  } catch {}
  return undefined;
}

/**
 * Detects the OS default browser bundle on macOS.
 */
export function getMacOsDefaultBrowserBundle(): string | null {
  if (os.platform() !== "darwin") return null;
  try {
    const out = execSync("defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null", {
      encoding: "utf-8",
      timeout: 1000,
    });
    if (out.includes("company.thebrowser.browser")) return "arc";
    if (out.includes("com.google.chrome")) return "chrome";
    if (out.includes("com.brave.browser")) return "brave";
    if (out.includes("com.microsoft.edgemac")) return "edge";
    if (out.includes("org.chromium.chromium")) return "chromium";
  } catch {}
  return null;
}

/**
 * Detects whether a browser process is currently active on the host OS.
 */
export function isBrowserProcessRunning(browserNameOrBinary: string): boolean {
  try {
    const target = browserNameOrBinary.toLowerCase();
    if (os.platform() === "win32") {
      const out = execSync("tasklist /FI \"STATUS eq RUNNING\" 2>nul", { encoding: "utf-8", timeout: 1500 });
      return out.toLowerCase().includes(target);
    }
    const out = execSync("ps -ax -o command 2>/dev/null", { encoding: "utf-8", timeout: 1500 });
    const lower = out.toLowerCase();
    if (target.includes("arc")) {
      return lower.includes("arc.app/contents/macos/arc");
    }
    if (target.includes("chrome")) {
      return lower.includes("google chrome.app/contents/macos/google chrome") || lower.includes("google-chrome");
    }
    if (target.includes("brave")) {
      return lower.includes("brave browser.app") || lower.includes("brave-browser");
    }
    if (target.includes("edge")) {
      return lower.includes("microsoft edge.app") || lower.includes("msedge");
    }
    return lower.includes(target);
  } catch {
    return false;
  }
}

/**
 * Lists all installed Chromium browsers found on the host machine.
 */
export function detectAllInstalledBrowsers(): DetectedBrowser[] {
  const platform = os.platform();
  const candidates = KNOWN_BROWSERS[platform] || KNOWN_BROWSERS.darwin || [];
  const defaultBundle = getMacOsDefaultBrowserBundle();

  const results: DetectedBrowser[] = [];
  for (const candidate of candidates) {
    const binPath = resolvePath(candidate.binary);
    const dataDir = resolvePath(candidate.userDataDir);
    if (fs.existsSync(binPath)) {
      const isDefault = defaultBundle ? candidate.name.toLowerCase().includes(defaultBundle) : false;
      results.push({
        name: candidate.name,
        binary: binPath,
        userDataDir: fs.existsSync(dataDir) ? dataDir : resolvePath("~/Library/Application Support/Google/Chrome"),
        appDir: candidate.appDir ? resolvePath(candidate.appDir) : undefined,
        bundleId: candidate.bundleId,
        isDefault,
      });
    }
  }

  // Sort default browser to top if found
  results.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  return results;
}

/**
 * Detects installed desktop Chromium browsers on the user's system,
 * prioritizing the OS default browser (such as Arc).
 */
export function detectDefaultBrowser(): DetectedBrowser | null {
  const all = detectAllInstalledBrowsers();
  if (all.length > 0) {
    // If the OS default is detected and installed, return it first!
    const defaultBrowser = all.find((b) => b.isDefault);
    return defaultBrowser || all[0];
  }
  return null;
}

/**
 * Recursively copies a directory, ignoring locks and temporary files.
 */
function copyDirFiltered(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (
      entry.name.includes("SingletonLock") ||
      entry.name.endsWith(".lock") ||
      entry.name.endsWith(".tmp") ||
      entry.name.endsWith("-journal")
    ) {
      continue;
    }

    try {
      if (entry.isDirectory()) {
        copyDirFiltered(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
    } catch {}
  }
}

/**
 * Prepares an isolated session profile cloned from the user's active browser profile.
 * Copies authentication cookies, local storage, login data, sessions, and Keychain/Local State keys.
 * For Arc, also replicates Arc metadata so spaces, tabs, and login state work smoothly.
 */
export function prepareSessionProfile(sourceUserDataDir: string, browserName?: string): string {
  const resolvedSource = resolvePath(sourceUserDataDir);
  const targetDir = path.join(os.homedir(), ".config/stagehand/profiles/my_browser_session");

  if (!fs.existsSync(resolvedSource)) {
    fs.mkdirSync(targetDir, { recursive: true });
    return targetDir;
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    // 1. Copy Local State (crucial for macOS Keychain / DPAPI cookie and password decryption)
    const localStateSrc = path.join(resolvedSource, "Local State");
    if (fs.existsSync(localStateSrc)) {
      try {
        fs.copyFileSync(localStateSrc, path.join(targetDir, "Local State"));
      } catch {}
    }

    // 2. Arc-specific metadata synchronization (Spaces, Windows, Membership)
    const isArc = (browserName && browserName.toLowerCase().includes("arc")) || resolvedSource.includes("Arc");
    if (isArc) {
      const arcAppDir = path.dirname(resolvedSource); // ~/Library/Application Support/Arc
      if (fs.existsSync(arcAppDir)) {
        const arcMetadataFiles = [
          "StorableSidebar.json",
          "StorableWindows.json",
          "StorableMembershipCard.json",
          "StorableSessionRestorationData.json",
        ];
        for (const meta of arcMetadataFiles) {
          const srcMeta = path.join(arcAppDir, meta);
          if (fs.existsSync(srcMeta)) {
            try {
              // Copy to parent of target profile so Arc reads it
              const targetParent = path.dirname(targetDir);
              fs.mkdirSync(targetParent, { recursive: true });
              fs.copyFileSync(srcMeta, path.join(targetParent, meta));
              // Also place in targetDir for fallback
              fs.copyFileSync(srcMeta, path.join(targetDir, meta));
            } catch {}
          }
        }
      }
    }

    // 3. Sync profile credentials & sessions (Default or Profile 1)
    const profileNames = ["Default", "Profile 1"];
    for (const pName of profileNames) {
      let pSrc = path.join(resolvedSource, pName);
      if (!fs.existsSync(pSrc) && pName === "Default") {
        pSrc = resolvedSource;
      }
      if (!fs.existsSync(pSrc)) continue;

      const pDest = path.join(targetDir, pName);
      fs.mkdirSync(pDest, { recursive: true });

      const files = [
        "Cookies",
        "Login Data",
        "Login Data For Account",
        "Web Data",
        "Preferences",
        "Secure Preferences",
        "Network Persistent State",
      ];
      for (const file of files) {
        const sf = path.join(pSrc, file);
        if (fs.existsSync(sf)) {
          try {
            fs.copyFileSync(sf, path.join(pDest, file));
          } catch {}
        }
      }

      const dirs = ["Network", "Local Storage", "Sessions", "Session Storage"];
      for (const dir of dirs) {
        const sd = path.join(pSrc, dir);
        if (fs.existsSync(sd)) {
          try {
            copyDirFiltered(sd, path.join(pDest, dir));
          } catch {}
        }
      }
    }

    // 4. Remove any residual lock files in target directory
    try {
      const topFiles = fs.readdirSync(targetDir);
      for (const tf of topFiles) {
        if (tf.startsWith("Singleton")) {
          try { fs.unlinkSync(path.join(targetDir, tf)); } catch {}
        }
      }
    } catch {}
  } catch (err: any) {
    console.warn(`⚠️ Note on session profile clone: ${err?.message || err}`);
  }

  return targetDir;
}

export interface BrowserPrecheckTest {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fixHint?: string;
}

export interface BrowserPrecheckResult {
  ok: boolean;
  browserName: string;
  binaryPath: string;
  userDataDir: string;
  isOsDefault: boolean;
  isRunning: boolean;
  cdpActive: boolean;
  cdpUrl: string;
  cdpVersion?: any;
  credentialsDetected: {
    cookiesFound: boolean;
    loginDataFound: boolean;
    accountLoginDataFound: boolean;
    localStateFound: boolean;
    profilePath: string;
  };
  tests: BrowserPrecheckTest[];
  recommendations: string[];
}

/**
 * Runs a comprehensive pre-check validation of the browser setup,
 * testing binary existence, CDP port status, running processes, credentials, and Keychain access.
 */
export async function runBrowserPrecheck(options?: Partial<BrowserConfig>): Promise<BrowserPrecheckResult> {
  const tests: BrowserPrecheckTest[] = [];
  const recommendations: string[] = [];

  const detected = detectDefaultBrowser();
  const binary = options?.browserBinaryPath || process.env.BROWSER_PATH || detected?.binary || "";
  const rawUserData = options?.browserUserDataDir || process.env.BROWSER_USER_DATA || detected?.userDataDir || "";
  const browserName = detected?.name || "Desktop Browser";

  // Test 1: Browser Binary
  const binExists = Boolean(binary && fs.existsSync(binary));
  if (binExists) {
    tests.push({
      id: "binary_exists",
      name: "Browser Executable",
      status: "pass",
      message: `Found ${browserName} at: ${binary}`,
    });
  } else {
    tests.push({
      id: "binary_exists",
      name: "Browser Executable",
      status: "fail",
      message: `Binary not found at: ${binary || "(empty)"}`,
      fixHint: "Specify the exact path in Browser Settings (e.g. /Applications/Arc.app/Contents/MacOS/Arc)",
    });
    recommendations.push("Set a valid browser binary path in Browser Settings.");
  }

  // Test 2: OS Default Alignment
  const defaultBundle = getMacOsDefaultBrowserBundle();
  const isDefault = defaultBundle ? browserName.toLowerCase().includes(defaultBundle) : false;
  if (isDefault) {
    tests.push({
      id: "os_default",
      name: "Default OS Browser Alignment",
      status: "pass",
      message: `Aligned with macOS default browser (${browserName})`,
    });
  } else {
    tests.push({
      id: "os_default",
      name: "Default OS Browser Alignment",
      status: "warn",
      message: `Current browser (${browserName}) differs from macOS default (${defaultBundle || "unknown"})`,
      fixHint: "Select your primary default browser in Browser Settings to access your active logins.",
    });
  }

  // Test 3: Process Status
  const isRunning = isBrowserProcessRunning(browserName);
  tests.push({
    id: "process_running",
    name: "Browser Process Status",
    status: isRunning ? "pass" : "warn",
    message: isRunning ? `${browserName} is currently running on your system.` : `${browserName} is not currently running.`,
    fixHint: isRunning ? undefined : "Launch your browser if you want to connect to an active window.",
  });

  // Test 4: CDP Port 9222
  const cdpPort = 9222;
  const cdpActive = await isCdpActive("127.0.0.1", cdpPort);
  let cdpVersion: any = null;
  if (cdpActive) {
    cdpVersion = await fetchCdpVersion(`http://127.0.0.1:${cdpPort}`);
    tests.push({
      id: "cdp_port",
      name: "Remote Debugging (CDP Port 9222)",
      status: "pass",
      message: `CDP is active! Connected to: ${cdpVersion?.Browser || "Chromium/Arc"}`,
    });
  } else {
    tests.push({
      id: "cdp_port",
      name: "Remote Debugging (CDP Port 9222)",
      status: "warn",
      message: `CDP port ${cdpPort} is not open.`,
      fixHint: isRunning
        ? `To use your already-running ${browserName} directly without opening a new window, start it with: open -a Arc --args --remote-debugging-port=9222`
        : `Start ${browserName} with: /Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=9222`,
    });
    if (isRunning) {
      recommendations.push(
        `Your ${browserName} is running without remote debugging. To access your live Google login directly, click 'Launch / Attach Arc on Port 9222'.`
      );
    }
  }

  // Test 5: Credentials & Profile Access
  const resolvedDataDir = resolvePath(rawUserData);
  const dataExists = Boolean(resolvedDataDir && fs.existsSync(resolvedDataDir));
  let cookiesFound = false;
  let loginDataFound = false;
  let accountLoginDataFound = false;
  let localStateFound = false;

  if (dataExists) {
    localStateFound = fs.existsSync(path.join(resolvedDataDir, "Local State"));
    const defaultDir = path.join(resolvedDataDir, "Default");
    if (fs.existsSync(defaultDir)) {
      cookiesFound =
        fs.existsSync(path.join(defaultDir, "Cookies")) ||
        fs.existsSync(path.join(defaultDir, "Network", "Cookies"));
      loginDataFound = fs.existsSync(path.join(defaultDir, "Login Data"));
      accountLoginDataFound = fs.existsSync(path.join(defaultDir, "Login Data For Account"));
    }
  }

  const hasCredentials = cookiesFound || loginDataFound;
  tests.push({
    id: "profile_credentials",
    name: "Profile & Authentication Storage",
    status: hasCredentials ? "pass" : "warn",
    message: hasCredentials
      ? `Found active profile with cookies (${cookiesFound ? "✓" : "✗"}), saved logins (${loginDataFound ? "✓" : "✗"}), and account data (${accountLoginDataFound ? "✓" : "✗"}).`
      : `No existing credentials detected in: ${resolvedDataDir || "(empty)"}`,
    fixHint: hasCredentials
      ? undefined
      : "Verify your browser user data directory in Browser Settings.",
  });

  const ok = binExists && (cdpActive || dataExists);

  return {
    ok,
    browserName,
    binaryPath: binary,
    userDataDir: resolvedDataDir,
    isOsDefault: isDefault,
    isRunning,
    cdpActive,
    cdpUrl: cdpActive ? `http://127.0.0.1:${cdpPort}` : "",
    cdpVersion,
    credentialsDetected: {
      cookiesFound,
      loginDataFound,
      accountLoginDataFound,
      localStateFound,
      profilePath: resolvedDataDir,
    },
    tests,
    recommendations,
  };
}

/**
 * Helper to launch Arc or Chrome with --remote-debugging-port=9222
 */
export async function launchBrowserWithDebugPort(
  binaryPath?: string,
  port = 9222
): Promise<{ success: boolean; message: string; cdpUrl?: string }> {
  const detected = detectDefaultBrowser();
  const binary = binaryPath || detected?.binary;
  if (!binary || !fs.existsSync(binary)) {
    return { success: false, message: `Browser binary not found at: ${binary}` };
  }

  try {
    const isArc = binary.includes("Arc");
    if (os.platform() === "darwin") {
      const appName = isArc ? "Arc" : (binary.includes("Chrome") ? "Google Chrome" : "Brave Browser");
      if (isBrowserProcessRunning(appName) && !(await isCdpActive("127.0.0.1", port))) {
        try {
          execSync(`osascript -e 'quit app "${appName}"' 2>/dev/null`, { timeout: 2500 });
          await new Promise((r) => setTimeout(r, 1200));
        } catch {}
      }
      try {
        execSync(`open -a "${appName}" --args --remote-debugging-port=${port} '--remote-allow-origins=*'`, {
          timeout: 4000,
        });
      } catch {
        spawn(binary, [`--remote-debugging-port=${port}`, "--remote-allow-origins=*", "--no-first-run"], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }
    } else {
      spawn(binary, [`--remote-debugging-port=${port}`, "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check"], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }

    // Wait up to 8 seconds for CDP port to open
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isCdpActive("127.0.0.1", port)) {
        return {
          success: true,
          message: `Browser launched successfully on CDP port ${port}`,
          cdpUrl: `http://127.0.0.1:${port}`,
        };
      }
    }

    return {
      success: false,
      message: `Browser launched, but port ${port} did not respond in time. If ${isArc ? "Arc" : "the browser"} was already running, quit it and try again.`,
    };
  } catch (err: any) {
    return { success: false, message: `Failed to launch browser: ${err?.message || err}` };
  }
}

export interface ResolvedLaunchConfig {
  executablePath?: string;
  userDataDir?: string;
  cdpUrl?: string;
  args: string[];
  isOwnBrowser: boolean;
  browserName: string;
}

/**
 * Resolves full browser launch arguments based on user preference ("clean" vs "own").
 * Follows the browser-use reference architecture: auto-launches native browser with CDP debugging
 * and connects directly over CDP to avoid mock keychain and profile isolation pitfalls.
 */
export async function resolveBrowserLaunchConfig(
  useOwnBrowser: boolean,
  overrides?: Partial<BrowserConfig>
): Promise<ResolvedLaunchConfig> {
  if (!useOwnBrowser) {
    return {
      args: [],
      isOwnBrowser: false,
      browserName: "Playwright Chromium (Clean)",
    };
  }

  // 1. Check if configured or default CDP endpoint is already active and listening
  const targetCdp = overrides?.cdpUrl || "http://127.0.0.1:9222";
  try {
    const u = new URL(targetCdp);
    const port = parseInt(u.port || "9222", 10);
    const host = u.hostname || "127.0.0.1";
    if (await isCdpActive(host, port)) {
      const version = await fetchCdpVersion(targetCdp);
      const label = version?.Browser ? `Active Browser (${version.Browser})` : `Active Browser (${targetCdp})`;
      return {
        cdpUrl: targetCdp,
        args: [],
        isOwnBrowser: true,
        browserName: label,
      };
    }
  } catch {}

  // 2. Resolve browser binary
  const detected = detectDefaultBrowser();
  const binary = overrides?.browserBinaryPath || process.env.BROWSER_PATH || detected?.binary;
  const browserName = detected?.name || "Desktop Browser";

  if (!binary || !fs.existsSync(binary)) {
    return {
      args: [],
      isOwnBrowser: false,
      browserName: "Playwright Chromium (Clean fallback)",
    };
  }

  // 3. Auto-launch native browser with remote debugging port (browser-use pattern)
  console.log(`🚀 Launching ${browserName} with remote debugging enabled...`);
  const launchRes = await launchBrowserWithDebugPort(binary, 9222);
  if (launchRes.success && launchRes.cdpUrl) {
    const version = await fetchCdpVersion(launchRes.cdpUrl);
    const label = version?.Browser ? `${browserName} (${version.Browser})` : browserName;
    return {
      cdpUrl: launchRes.cdpUrl,
      args: [],
      isOwnBrowser: true,
      browserName: label,
    };
  }

  // 4. Fallback if CDP auto-launch could not bind
  console.warn(`⚠️ Could not attach CDP to ${browserName}: ${launchRes.message}`);
  const rawUserData = overrides?.browserUserDataDir || process.env.BROWSER_USER_DATA || detected?.userDataDir;
  const effectiveUserData = rawUserData
    ? prepareSessionProfile(rawUserData, browserName)
    : path.join(os.homedir(), ".config/stagehand/profiles/my_browser_session");

  return {
    executablePath: binary,
    userDataDir: effectiveUserData,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-allow-origins=*",
    ],
    isOwnBrowser: true,
    browserName,
  };
}
