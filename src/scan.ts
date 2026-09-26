import type { Stagehand } from "@browserbasehq/stagehand";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { session } from "./conversation.js";
import { navigate } from "./browser.js";
import { extractText, isExtractionValid } from "./planner.js";
import { csvEsc, retry, sleep } from "./utils.js";
import type { BatchResult } from "./types.js";

export function parseCsvRow(row: string): string[] {
  const r: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of row) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      r.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  r.push(cur.trim());
  return r;
}

export interface ScanProgressCallback {
  (info: { index: number; total: number; url: string; company: string; status: "success" | "warning" | "error"; message: string }): void;
}

export async function runScan(
  inputFile: string,
  urlCol: string,
  instruction: string,
  outputFile: string,
  sh: Stagehand,
  page: any,
  onProgress?: ScanProgressCallback
): Promise<boolean> {
  const resolved = path.resolve(process.cwd(), inputFile);
  if (!existsSync(resolved)) {
    console.error(`❌ Not found: ${resolved}`);
    return false;
  }

  const raw = await fs.readFile(resolved, "utf-8");
  const lines = raw.trim().split("\n");
  if (lines.length < 2) {
    console.error("❌ Need header + data rows.");
    return false;
  }

  const firstLine = lines[0];
  if (!firstLine) {
    console.error("❌ Empty CSV file.");
    return false;
  }
  const headers = firstLine.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const colIdx = headers.findIndex((h) => h.toLowerCase() === urlCol.toLowerCase());
  if (colIdx === -1) {
    console.error(`❌ Column "${urlCol}" not found. Have: ${headers.join(", ")}`);
    return false;
  }

  const rows = lines.slice(1).map(parseCsvRow).filter((r) => r[colIdx]?.trim());
  console.log(`\n📋 Scanning ${rows.length} URLs (col: ${urlCol})`);
  console.log(`   Instruction: "${instruction}"\n`);

  const results: BatchResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    let url = (row[colIdx] ?? "").replace(/^"|"$/g, "").trim();
    if (!url || url === "N/A" || url === "-") {
      results.push({ url, company: row[1] || "", data: "", error: "skipped" });
      continue;
    }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const company = row.find((_, idx) => idx !== colIdx && (row[idx]?.trim() ?? "")) || "";
    const tag = `[${i + 1}/${rows.length}]`;

    process.stdout.write(`${tag} 🌐 ${company || url}...\r`);

    try {
      await navigate(page, url);
      const text = await retry(() => extractText(sh, instruction, page), `${tag} Extract`);

      if (!isExtractionValid(text)) {
        results.push({ url, company, data: "", error: "empty extraction" });
        console.log(`${tag} ⚠️ ${company || url} — empty extraction`);
        if (onProgress) onProgress({ index: i + 1, total: rows.length, url, company, status: "warning", message: "Empty extraction" });
      } else {
        results.push({ url, company, data: text, error: "" });
        console.log(`${tag} ✅ ${company || url} — ${text.length} chars`);
        if (onProgress) onProgress({ index: i + 1, total: rows.length, url, company, status: "success", message: `${text.length} chars extracted` });
      }
    } catch (e: any) {
      results.push({ url, company, data: "", error: e?.message || String(e) });
      console.log(`${tag} ❌ ${company || url} — ${e?.message}`);
      if (onProgress) onProgress({ index: i + 1, total: rows.length, url, company, status: "error", message: e?.message || "Failed" });
    }
    await sleep(300);
  }

  const out = path.resolve(process.cwd(), outputFile);
  const csv = [
    "url,company,extraction,error",
    ...results.map((r) => `${csvEsc(r.url)},${csvEsc(r.company)},${csvEsc(r.data)},${csvEsc(r.error)}`),
  ];
  await fs.writeFile(out, csv.join("\n"), "utf-8");
  const ok = results.filter((r) => !r.error).length;
  console.log(`\n✅ Done! ${ok}/${rows.length} succeeded → ${out}\n`);
  session.batchResults = results;
  return ok > 0 || rows.length === 0;
}
