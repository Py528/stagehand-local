/**
 * session.ts — Persistent session management
 *
 * Allows the agent to survive terminal close and be reconnected:
 *   1. On startup with --ui: write session info to data/session.json
 *   2. Ignore SIGHUP (terminal close) so the process keeps running
 *   3. On startup with --status or --reconnect: read session.json,
 *      check if the process is still alive, open browser or print URL
 *
 * Session file format (data/session.json):
 *   { pid, port, startedAt, lastActiveAt, url, cdpPort }
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SESSION_FILE = path.resolve(__dirname, "..", "data", "session.json");

export interface SessionInfo {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  lastActiveAt: string;
}

function ensureDataDir(): void {
  const dir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Write session info ──────────────────────────────────────────────────────

export function writeSessionInfo(port: number): void {
  ensureDataDir();
  const info: SessionInfo = {
    pid: process.pid,
    port,
    url: `http://127.0.0.1:${port}`,
    startedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(info, null, 2), "utf-8");
}

export function touchSessionInfo(): void {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const info = readSessionInfo();
    if (!info) return;
    info.lastActiveAt = new Date().toISOString();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(info, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

export function clearSessionInfo(): void {
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch {}
}

// ── Read + validate session ─────────────────────────────────────────────────

export function readSessionInfo(): SessionInfo | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")) as SessionInfo;
  } catch { return null; }
}

/** Check if a PID is still running on this OS */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/** HTTP health-check the running server */
async function isServerAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/status`, { timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/** Returns the active session if one is running, null otherwise */
export async function getActiveSession(): Promise<SessionInfo | null> {
  const info = readSessionInfo();
  if (!info) return null;
  if (!isPidAlive(info.pid)) { clearSessionInfo(); return null; }
  const alive = await isServerAlive(info.port);
  if (!alive) { clearSessionInfo(); return null; }
  return info;
}

// ── SIGHUP handling ─────────────────────────────────────────────────────────
//
// When a terminal window closes, the OS sends SIGHUP to its foreground process.
// By default Node.js exits on SIGHUP. We ignore it so the process keeps running
// as a background daemon — the UI stays accessible at http://127.0.0.1:PORT.

export function ignoreSighup(): void {
  process.on("SIGHUP", () => {
    // Terminal closed — keep running as background daemon
    console.log("\n[Session] Terminal detached. Agent continues at " + readSessionInfo()?.url);
    touchSessionInfo();
  });
}

// Clean up session file and close browser on normal exit
export function registerCleanup(onShutdown?: () => Promise<void>): void {
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    console.log("\n[Session] Shutting down — closing browser...");
    try { if (onShutdown) await onShutdown(); } catch {}
    clearSessionInfo();
    process.exit(0);
  };
  process.on("SIGINT",  () => { void cleanup(); });   // Ctrl+C
  process.on("SIGTERM", () => { void cleanup(); });   // kill / system shutdown
  // NOT SIGHUP — that's the terminal-close signal we want to survive
}
