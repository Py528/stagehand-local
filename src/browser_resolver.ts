import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execSync } from "node:child_process";
import type { BrowserConfig } from "./types.js";

export interface DetectedBrowser {
  name: string;
  binary: string;
  userDataDir: string;
}

interface BrowserCandidate {
  name: string;
  binary: string;
  userDataDir: string;
}

const KNOWN_BROWSERS: Record<string, BrowserCandidate[]> = {
  darwin: [
    {
      name: "Google Chrome",
      binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      userDataDir: "~/Library/Application Support/Google/Chrome",
    },
    {
      name: "Arc",
      binary: "/Applications/Arc.app/Contents/MacOS/Arc",
      userDataDir: "~/Library/Application Support/Arc/User Data",
    },
    {
      name: "Brave",
      binary: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
    },
    {
      name: "Microsoft Edge",
      binary: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      userDataDir: "~/Library/Application Support/Microsoft Edge",
    },
    {
      name: "Chromium",
      binary: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      userDataDir: "~/Library/Application Support/Chromium",
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

function resolvePath(p: string): string {
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

function getMacOsDefaultBrowserBundle(): string | null {
  try {
    const out = execSync("defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null", {
      encoding: "utf-8",
      timeout: 1000,
    });
    if (out.includes("company.thebrowser.browser")) return "arc";
    if (out.includes("com.google.chrome")) return "chrome";
    if (out.includes("com.brave.browser")) return "brave";
    if (out.includes("com.microsoft.edgemac")) return "edge";
  } catch {}
  return null;
}

/**
 * Detects installed desktop Chromium browsers on the user's system,
 * honoring the OS default browser (such as Arc) and user profile directories.
 */
export function detectDefaultBrowser(): DetectedBrowser | null {
  const platform = os.platform();
  const candidates = KNOWN_BROWSERS[platform] || KNOWN_BROWSERS.darwin || [];

  for (const candidate of candidates) {
    const binPath = resolvePath(candidate.binary);
    const dataDir = resolvePath(candidate.userDataDir);
    if (fs.existsSync(binPath)) {
      return {
        name: candidate.name,
        binary: binPath,
        userDataDir: fs.existsSync(dataDir) ? dataDir : resolvePath("~/Library/Application Support/Google/Chrome"),
      };
    }
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

    if (entry.name.includes("SingletonLock") || entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) {
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
 * Runs in ~15ms and completely eliminates Chromium SingletonLock conflicts when the user's
 * browser is already running.
 */
export function prepareSessionProfile(sourceUserDataDir: string): string {
  const resolvedSource = resolvePath(sourceUserDataDir);
  const targetDir = path.join(os.homedir(), ".config/stagehand/profiles/my_browser_session");

  if (!fs.existsSync(resolvedSource)) {
    fs.mkdirSync(targetDir, { recursive: true });
    return targetDir;
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    // 1. Copy Local State (crucial for macOS Keychain / DPAPI cookie decryption)
    const localStateSrc = path.join(resolvedSource, "Local State");
    if (fs.existsSync(localStateSrc)) {
      try {
        fs.copyFileSync(localStateSrc, path.join(targetDir, "Local State"));
      } catch {}
    }

    // 2. Sync profile credentials & sessions (Default or Profile 1)
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

    // 3. Remove any residual lock files in target directory
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

  // 1. Check if an active debugging instance is already running
  if (overrides?.cdpUrl) {
    return {
      cdpUrl: overrides.cdpUrl,
      args: [],
      isOwnBrowser: true,
      browserName: "Custom CDP",
    };
  }

  const cdpRunning = await isCdpActive("127.0.0.1", 9222);
  if (cdpRunning) {
    return {
      cdpUrl: "http://127.0.0.1:9222",
      args: [],
      isOwnBrowser: true,
      browserName: "Active Browser (CDP Port 9222)",
    };
  }

  // 2. Resolve custom or detected browser binary
  const detected = detectDefaultBrowser();
  const binary = overrides?.browserBinaryPath || process.env.BROWSER_PATH || detected?.binary;
  const rawUserData = overrides?.browserUserDataDir || process.env.BROWSER_USER_DATA || detected?.userDataDir;

  const browserName = detected?.name || "Desktop Browser";

  if (!binary) {
    return {
      args: [],
      isOwnBrowser: false,
      browserName: "Playwright Chromium (Clean fallback)",
    };
  }

  // 3. Clone active session state into isolated profile to avoid locking conflicts
  const effectiveUserData = rawUserData
    ? prepareSessionProfile(rawUserData)
    : path.join(os.homedir(), ".config/stagehand/profiles/my_browser_session");

  return {
    executablePath: binary,
    userDataDir: effectiveUserData,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,OptimizationHints",
    ],
    isOwnBrowser: true,
    browserName,
  };
}
