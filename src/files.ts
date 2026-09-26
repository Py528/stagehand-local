import fs from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import * as os from "node:os";
import { spawnSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import type { AttachedFile } from "./types.js";

const require = createRequire(import.meta.url);

export async function readFileContent(filePath: string): Promise<AttachedFile | null> {
  let s = filePath.trim().replace(/^["'\u201c\u201d]|["'\u201c\u201d]$/g, "");
  if (s.startsWith("file://")) s = s.replace(/^file:\/\//, "");
  if (s.startsWith("~")) s = path.join(os.homedir(), s.slice(1));
  const resolved = path.resolve(process.cwd(), s);

  if (!existsSync(resolved)) return null;

  const ext = path.extname(resolved).toLowerCase();
  const filename = path.basename(resolved);

  // PDF support via pdf-parse
  if (ext === ".pdf") {
    try {
      const { PDFParse } = require("pdf-parse");
      const buf = await fs.readFile(resolved);
      const parser = new PDFParse(buf);
      await parser.load();
      const text = (await parser.getText()).trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      return { filename, content: text, wordCount, path: resolved };
    } catch (e: any) {
      console.warn(`⚠️ Could not parse PDF ${filename}: ${e?.message}`);
      return null;
    }
  }

  // Word doc / RTF support on macOS via textutil
  if ((ext === ".docx" || ext === ".rtf") && process.platform === "darwin") {
    try {
      const text = execSync(`textutil -convert txt -stdout "${resolved}"`, { encoding: "utf-8" }).trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      return { filename, content: text, wordCount, path: resolved };
    } catch {}
  }

  // Text, markdown, JSON, CSV, code files
  try {
    const raw = await fs.readFile(resolved, "utf-8");
    const text = raw.trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return { filename, content: text, wordCount, path: resolved };
  } catch (e: any) {
    console.warn(`⚠️ Could not read ${filename}: ${e?.message}`);
    return null;
  }
}

export async function openInEditor(initialContent = ""): Promise<string> {
  const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === "darwin" ? "nano" : "vi");
  const tmpFile = path.join(os.tmpdir(), `stagehand_prompt_${Date.now()}.md`);
  await fs.writeFile(tmpFile, initialContent, "utf-8");

  try {
    spawnSync(editor, [tmpFile], { stdio: "inherit" });
    const content = await fs.readFile(tmpFile, "utf-8").catch(() => "");
    await fs.unlink(tmpFile).catch(() => {});
    return content.trim();
  } catch (e: any) {
    console.error(`❌ Could not open editor: ${e?.message}`);
    return initialContent;
  }
}

export function getWorkspaceFiles(maxDepth = 3): string[] {
  const results: string[] = [];
  const ignores = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".cache",
    ".turbo",
    ".system_generated",
  ]);

  function scan(dir: string, depth: number, prefix: string) {
    if (depth > maxDepth || results.length > 500) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (ignores.has(e.name) || e.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          scan(path.join(dir, e.name), depth + 1, rel);
        } else if (e.isFile()) {
          results.push(rel);
        }
      }
    } catch {}
  }

  scan(process.cwd(), 0, "");
  return results;
}

export function matchFiles(query: string, files: string[]): string[] {
  const q = query.toLowerCase();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    const full = f.toLowerCase();
    if (base.startsWith(q) || full.startsWith(q)) {
      starts.push(f);
    } else if (base.includes(q) || full.includes(q)) {
      contains.push(f);
    }
  }
  return [...starts, ...contains];
}
