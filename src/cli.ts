import type { Stagehand } from "@browserbasehq/stagehand";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { cfg, CONFIG_PATH } from "./config.js";
import { localClient } from "./llm.js";
import {
  session,
  addToConversation,
  pinLatestExtraction,
  attachFileToSession,
  resolvePromptFiles,
  validateAndResolveAttachments,
  isConversational,
  handleConversational,
} from "./conversation.js";
import { activePage, navigate, dismissCookies } from "./browser.js";
import {
  extractText,
  isExtractionValid,
  runAgent,
  detectUrlQuestion,
  fastUrlQuestion,
  detectSearchShortcut,
} from "./planner.js";
import { runScan } from "./scan.js";
import { getWorkspaceFiles, matchFiles, openInEditor } from "./files.js";
import { retry, sleep, ts } from "./utils.js";
import { listTraces, getTraceStats } from "./trace.js";
import { resetSession } from "./conversation.js";
import { listPatterns, getPatternStats } from "./patterns.js";

export function cliCompleter(line: string): [string[], string] {
  // @file autocompletion anywhere in prompt
  const atMatch = line.match(/@([^\s]*)$/);
  if (atMatch) {
    const query = atMatch[1] ?? "";
    const files = getWorkspaceFiles();
    const hits = query ? matchFiles(query, files) : files;
    return [hits.map((f) => "@" + f), atMatch[0]];
  }

  // /command autocompletion
  const slashMatch = line.match(/^\/([^\s]*)$/);
  if (slashMatch) {
    const cmds = ["/attach", "/clear", "/context", "/edit", "/files", "/help", "/history", "/paste", "/reset", "/exit"];
    const prefix = slashMatch[1] ?? "";
    const hits = cmds.filter((c) => c.startsWith("/" + prefix));
    return [hits.length ? hits : cmds, slashMatch[0]];
  }

  // Bare command autocompletion at start of line
  const bareMatch = line.match(/^([a-z]+)$/i);
  if (bareMatch && bareMatch[1]) {
    const cmds = [
      "goto",
      "act",
      "extract",
      "observe",
      "screenshot",
      "think",
      "ask",
      "scan",
      "save",
      "pages",
      "back",
      "url",
      "history",
      "traces",
      "config",
      "help",
      "exit",
      ...Object.keys(cfg.shortcuts),
    ];
    const prefix = bareMatch[1].toLowerCase();
    const hits = cmds.filter((c) => c.startsWith(prefix));
    return [hits, bareMatch[1]];
  }

  return [[], line];
}

export function printHelp(): void {
  const shortcuts = Object.keys(cfg.shortcuts).join(", ");
  console.log(`
╭────────────────────────────────── CLI Usage ─────────────────────────────────╮
│  npx tsx index.ts [options] ["instruction"]                                  │
│                                                                              │
│  Options:                                                                    │
│    -i, --interactive         Start interactive REPL mode                     │
│    --ui, --web               Start the Web UI Dashboard                      │
│    --port <number>           Web UI port (default: 7788)                     │
│    --headless                Run browser in headless mode                    │
│    --headed, --no-headless   Run browser in headed mode (visible window)      │
│    --use-own-browser         Run with default desktop browser & real sessions │
│    --cdp <url>               Connect over CDP (e.g. http://127.0.0.1:9222)   │
│    --keep-browser-open       Keep browser open between tasks                 │
│    --disable-security        Disable web security & CORS checks              │
│    -c, --config <path>       Specify custom config.json path                 │
│    -h, --help                Show command help                               │
│    "<instruction>"           Execute one-shot prompt and exit                │
╰──────────────────────────────────────────────────────────────────────────────╯

╭────────────────────────────────── Commands ──────────────────────────────────╮
│ Navigation                                                                   │
│   goto <url>                Navigate to URL                                  │
│   back                      Browser back                                     │
│   pages                     List open tabs                                   │
│   url                       Current page info                                │
│                                                                              │
│ Actions                                                                      │
│   act <instruction>         Browser action (click, type, keypress)           │
│   extract <instruction>     Extract data from current page                   │
│   observe [instruction]     List interactive elements                        │
│   screenshot [file]         Save screenshot                                  │
│                                                                              │
│ Files & Context                                                              │
│   @filename                 Attach file inline (e.g. 'think does @resume.pdf fit?')  │
│   attach <file>             Attach file to session context (pdf, txt, md, etc.)     │
│   files                     List attached files                                      │
│   think <question>          Ask about extracted data, resume, prior context          │
│   context                   Show what the agent currently remembers                  │
│                                                                              │
│ Input & Multi-line (OpenCode-style)                                          │
│   /edit  or  /e             Open $EDITOR (nano/vim/code) to draft or edit prompt     │
│   /paste or  """            Enter multi-line paste mode                              │
│   line \\                   End line with backslash to continue on next line         │
│   /clear                    Clear terminal screen                                    │
│                                                                              │
│ Batch                                                                        │
│   scan <csv> <col> "instr" [out.csv]                                         │
│                             Visit URLs from CSV, extract, save results       │
│                                                                              │
│ Data                                                                         │
│   save [file]               Save last extraction/answer                      │
│   history                   Session history                                  │
│   traces                    Show self-learned execution trace memory         │
│   config                    Show current config                              │
│   reset, /reset             Clear session memory (keep files attached)       │
│                                                                              │
│ Chaining                                                                     │
│   cmd1 ; cmd2 ; cmd3        Sequential execution                             │
│                                                                              │
│ Search Shortcuts: ${shortcuts.padEnd(57)}│
│                                                                              │
│ Smart Routing (automatic)                                                    │
│   "<url> <question>"        Fast path: navigate + extract + answer           │
│   "<shortcut> <query>"      Direct search URL                                │
│   Large text paste          Stored as context (resume, data)                 │
│   Conversational question   Answered from context (no browsing)              │
│   Complex goal              Full agent planner                               │
│                                                                              │
│ Session: exit / quit / q    │  help / ?                                      │
╰──────────────────────────────────────────────────────────────────────────────╯
`);
}

export async function runCommand(raw: string, sh: Stagehand, page: any): Promise<boolean> {
  let line = raw.trim();
  if (!line) return true;

  const pg = await activePage(sh, page);

  // ── /attach <path> or attach <path> ──
  if (/^(\/)?attach\s+/i.test(line)) {
    const fp = line.replace(/^(\/)?attach\s+/i, "").trim();
    return await attachFileToSession(fp);
  }

  // ── bare @file attachment ──
  if (/^@([^\s"']+)$/.test(line)) {
    return await attachFileToSession(line.slice(1));
  }

  // ── /files — list attached files ──
  if (/^(\/)?files$/i.test(line)) {
    if (session.attachedFiles.length === 0) {
      console.log("\n📎 No files attached yet. Attach files with '@filename' or '/attach <path>'.\n");
    } else {
      console.log(`\n📎 ${session.attachedFiles.length} attached file(s):`);
      for (const f of session.attachedFiles) {
        console.log(`  • ${f.filename} (${f.wordCount.toLocaleString()} words / ${(f.content.length / 1024).toFixed(1)} KB) — ${f.path}`);
      }
      console.log();
    }
    return true;
  }

  // ── /clear (terminal) ──
  if (/^(\/)?(clear)$/i.test(line)) {
    console.clear();
    return true;
  }

  // ── /reset — clear session memory ──
  if (/^(\/)?(reset|clear.?memory|clearmem)$/i.test(line)) {
    resetSession();
    console.log("\n🧹 Session memory cleared. Attached files kept.\n");
    return true;
  }

  // ── Validate & resolve inline @file references and attachments at parse time ──
  const attachCheck = await validateAndResolveAttachments(line);
  if (!attachCheck.ok) {
    console.error(`\n❌ Precondition Failed: ${attachCheck.error}\n`);
    addToConversation({ role: "assistant", content: attachCheck.error!, label: "error" });
    return false;
  }
  line = attachCheck.resolvedInput.replace(/\s+/g, " ").trim();

  // ── chain with ; ──
  if (line.includes(";") && !/^scan\s/i.test(line)) {
    let allOk = true;
    for (const cmd of line.split(";").map((c) => c.trim()).filter(Boolean)) {
      try {
        const ok = await runCommand(cmd, sh, pg);
        if (ok === false) allOk = false;
      } catch (e: any) {
        console.error(`❌ ${e?.message}`);
        allOk = false;
      }
    }
    return allOk;
  }

  // ── goto / open ──
  if (/^(goto|open)\s+/i.test(line)) {
    let url = line.replace(/^(goto|open)\s+/i, "").trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    console.log(`\n🌐 ${url}...`);
    await navigate(pg, url);
    await dismissCookies(sh, pg);
    const title = await pg.title().catch(() => "");
    console.log(`✅ "${title}" loaded.\n`);
    addToConversation({ role: "data", content: `Navigated to ${url} ("${title}")`, label: "navigation" });
    return true;
  }

  // ── act ──
  if (/^act\s+/i.test(line)) {
    const instr = line.replace(/^act\s+/i, "").trim();
    console.log(`\n⚡ "${instr}"...`);
    const r = await retry(() => sh.act(instr, { page: pg }), "Act");
    console.log(`✅ ${r.data?.message || "Done"}\n`);
    return true;
  }

  // ── extract ──
  if (/^extract\s+/i.test(line)) {
    const instr = line.replace(/^extract\s+/i, "").trim();
    console.log(`\n🔍 "${instr}"...`);
    const text = await extractText(sh, instr, pg);
    if (!isExtractionValid(text)) {
      console.log(`\n⚠️ Extraction returned empty. Page may use heavy JS/iframes.\n`);
      return false;
    } else {
      console.log(`\n📄 Extracted:\n${text}\n`);
      const url = await pg.url().catch(() => "");
      pinLatestExtraction(text, url);
      return true;
    }
  }

  // ── observe ──
  if (/^observe(\s+.*)?$/i.test(line)) {
    const arg = line.replace(/^observe\s*/i, "").trim();
    const r: any = await retry(() => sh.observe(arg || undefined, { page: pg }), "Observe");
    const elements: any[] = Array.isArray(r) ? r : r?.data ?? r?.elements ?? [];
    console.log(`\n👀 ${elements.length} elements:`);
    for (const e of elements.slice(0, 15)) console.log(`  - [${e.method || "?"}] ${e.description || JSON.stringify(e)}`);
    if (elements.length > 15) console.log(`  ... +${elements.length - 15} more`);
    console.log();
    return true;
  }

  // ── screenshot ──
  if (/^screenshot(\s+.*)?$/i.test(line)) {
    const name = line.replace(/^screenshot\s*/i, "").trim() || `screenshot-${Date.now()}.png`;
    const fp = path.resolve(process.cwd(), name);
    await fs.writeFile(fp, await pg.screenshot());
    console.log(`📸 ${fp}\n`);
    return true;
  }

  // ── url / info ──
  if (/^(url|info|where)$/i.test(line)) {
    console.log(`\n📍 "${await pg.title().catch(() => "?")}" — ${await pg.url().catch(() => "?")}\n`);
    return true;
  }

  // ── back ──
  if (/^back$/i.test(line)) {
    await pg.goBack().catch(() => {});
    await pg.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(cfg.agent.domSettleMs);
    console.log(`⬅️ "${await pg.title().catch(() => "?")}"\n`);
    return true;
  }

  // ── pages ──
  if (/^pages$/i.test(line)) {
    try {
      const ps = await sh.browser.context.pages();
      console.log(`\n📑 ${ps.length} tabs:`);
      for (const [i, p] of ps.entries())
        console.log(`  ${i + 1}. "${await p.title().catch(() => "?")}" — ${await p.url().catch(() => "?")}`);
      console.log();
    } catch {
      console.log("Could not list.\n");
    }
    return true;
  }

  // ── save ──
  if (/^save(\s+.*)?$/i.test(line)) {
    const name = line.replace(/^save\s*/i, "").trim() || `extraction-${Date.now()}.txt`;
    const content = session.lastAnswer || session.lastExtraction;
    if (!content) {
      console.log("⚠️ Nothing to save.\n");
      return false;
    }
    const fp = path.resolve(process.cwd(), name);
    await fs.writeFile(fp, content, "utf-8");
    console.log(`💾 ${fp}\n`);
    return true;
  }

  // ── scan ──
  const scanM = line.match(/^scan\s+(\S+)\s+(\S+)\s+["']([^"']+)["'](?:\s+(\S+))?$/i);
  if (scanM && scanM[1] && scanM[2] && scanM[3]) {
    return await runScan(scanM[1], scanM[2], scanM[3], scanM[4] || `scan-${Date.now()}.csv`, sh, pg);
  }

  // ── history ──
  if (/^history$/i.test(line)) {
    if (!session.history.length) {
      console.log("\n📜 Empty.\n");
      return true;
    }
    console.log(`\n📜 ${session.history.length} entries:`);
    for (const h of session.history) console.log(`  [${h.ts}] ${h.url}\n    ${h.goal}\n    ${h.result.slice(0, 100)}...\n`);
    return true;
  }

  // ── context ──
  if (/^context$/i.test(line)) {
    if (session.conversation.length === 0) {
      console.log("\n🧠 No context stored yet.\n");
    } else {
      console.log(
        `\n🧠 Session context (${session.conversation.length} entries, ${session.conversation.reduce(
          (s, e) => s + e.content.length,
          0
        )} chars):\n`
      );
      for (const e of session.conversation) {
        const tag = e.label || e.role;
        const preview = e.content.length > 200 ? e.content.slice(0, 200) + "..." : e.content;
        console.log(`  [${tag}] ${preview}\n`);
      }
    }
    return true;
  }

  // ── think / ask ──
  if (/^(think|ask)\s+/i.test(line)) {
    const question = line.replace(/^(think|ask)\s+/i, "").trim();
    return await handleConversational(question, localClient);
  }

  // ── config ──
  if (/^config$/i.test(line)) {
    console.log(`\n⚙️  Config (${CONFIG_PATH}):`);
    console.log(JSON.stringify(cfg, null, 2), "\n");
    return true;
  }

  // ── patterns ──
  if (/^patterns?$/i.test(line)) {
    const stats = getPatternStats();
    if (stats.total === 0) {
      console.log("\n🧩 No patterns learned yet. Complete a few tasks and they'll be stored automatically.\n");
      return true;
    }
    const byService = Object.entries(stats.byService).map(([k, v]) => `${k}: ${v}`).join(", ");
    console.log(`\n🧩 Pattern Library (${stats.total} patterns, ${stats.totalReplays} total replays)`);
    console.log(`   Services: ${byService}\n`);
    const all = listPatterns().slice(0, 10);
    for (const p of all) {
      const rel = p.failCount > 0 ? ` / ❌ ${p.failCount} fails` : "";
      const slots = p.slotNames.join(", ");
      console.log(`  📐 [${p.patternKey}]`);
      console.log(`     Slots: ${slots} | ✅ ${p.successCount} replays${rel} | ~${p.avgMs}ms`);
      console.log(`     Example: "${p.exampleGoals[0] ?? "—"}"`);
    }
    console.log();
    return true;
  }

  // ── traces ──
  if (/^traces?$/i.test(line)) {
    const stats = getTraceStats();
    if (stats.total === 0) {
      console.log("\n🧠 No traces recorded yet. Run some goals and they'll be stored automatically.\n");
      return true;
    }
    const byService = Object.entries(stats.byService).map(([k, v]) => `${k}: ${v}`).join(", ");
    const byIntent = Object.entries(stats.byIntent).map(([k, v]) => `${k}: ${v}`).join(", ");
    console.log(`\n🧠 Trace Memory (${stats.total} traces, ${stats.totalReplays} replays)`);
    console.log(`   Services: ${byService}`);
    console.log(`   Intents:  ${byIntent}\n`);
    const top = listTraces(10);
    for (const t of top) {
      const reliability = t.replayCount > 0
        ? ` | ✅ ${t.replayCount} replays${t.failCount > 0 ? ` / ❌ ${t.failCount} fails` : ""}`
        : "";
      console.log(`  🔹 [${t.service}/${t.intent}] "${t.goal.slice(0, 60)}" — ${t.steps.length} steps${reliability}`);
    }
    console.log();
    return true;
  }

  // ── precheck / doctor ──
  if (/^(precheck|doctor|diagnostics)$/i.test(line)) {
    const { runBrowserPrecheck } = await import("./browser_resolver.js");
    console.log("\n🔍 Running browser pre-check...");
    const res = await runBrowserPrecheck(cfg.browser);
    console.log(`Browser: ${res.browserName} (${res.isOsDefault ? "OS Default" : "Custom"})`);
    console.log(`Binary:  ${res.binaryPath}`);
    console.log(`Profile: ${res.userDataDir}`);
    console.log(`Status:  ${res.ok ? "✅ READY" : "⚠️ NEEDS ATTENTION"}\n`);
    for (const t of res.tests) {
      const icon = t.status === "pass" ? "✅" : t.status === "warn" ? "⚠️" : "❌";
      console.log(`  ${icon} ${t.name}: ${t.message}`);
      if (t.fixHint) console.log(`     💡 ${t.fixHint}`);
    }
    console.log("");
    return true;
  }

  // ── help ──
  if (/^(help|\?)$/i.test(line)) {
    printHelp();
    return true;
  }

  // ── bare URL ──
  if (/^(https?:\/\/|[a-z0-9-]+\.[a-z]{2,})/i.test(line) && !line.includes(" ")) {
    let url = line;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    console.log(`\n🌐 ${url}...`);
    await navigate(pg, url);
    await dismissCookies(sh, pg);
    const title = await pg.title().catch(() => "");
    console.log(`✅ "${title}" loaded.\n`);
    addToConversation({ role: "data", content: `Navigated to ${url} ("${title}")`, label: "navigation" });
    return true;
  }

  // ── Conversational routing ──
  if (isConversational(line)) {
    return await handleConversational(line, localClient);
  }

  // ── Fast path URL + question ──
  const uq = detectUrlQuestion(line);
  if (uq) {
    addToConversation({ role: "user", content: line, label: "user_goal" });
    return await fastUrlQuestion(uq.url, uq.question, sh, pg);
  }

  // ── Fast path search shortcut ──
  const searchUrl = detectSearchShortcut(line);
  if (searchUrl) {
    const shortcutKey = Object.keys(cfg.shortcuts).find((k) => new RegExp(`^${k}\\s`, "i").test(line));
    const query = shortcutKey ? line.replace(new RegExp(`^${shortcutKey}\\s+`, "i"), "").trim() : line;
    const andParts = query.split(/\s+and\s+/i);
    const searchQuery = andParts[0]?.trim() || query;
    const extraGoals = andParts.slice(1).join(" and ").trim();
    const template = shortcutKey ? cfg.shortcuts[shortcutKey] : undefined;
    const directUrl = template ? template.replace("{{query}}", encodeURIComponent(searchQuery)) : searchUrl;
    console.log(`\n🔎 Shortcut → ${directUrl}`);
    await navigate(pg, directUrl);
    await dismissCookies(sh, pg);
    if (extraGoals) {
      const res = await runAgent(extraGoals, sh, pg);
      return !!res;
    } else {
      console.log(`✅ "${await pg.title().catch(() => "")}" loaded.\n`);
      return true;
    }
  }

  // ── Autonomous Agent ──
  addToConversation({ role: "user", content: line, label: "user_goal" });
  const answer = await runAgent(line, sh, pg);
  if (answer) {
    session.history.push({
      ts: ts(),
      url: await pg.url().catch(() => ""),
      goal: line,
      result: answer.slice(0, 2000),
    });
    return true;
  }
  return false;
}

export async function startInteractiveCli(sh: Stagehand, page: any, initialPrompt?: string): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              Stagehand CLI — Local Web Agent                  ║
╠═══════════════════════════════════════════════════════════════╣
║  Type any goal, or 'help'.  'exit' to quit.                   ║
║  @file autocomplete: Type '@' and press [Tab] to pick files   ║
║  Newlines: Shift+Enter or Alt+Enter  Submit: Enter            ║
║  Edit prompt: /edit        Multi-line: /paste or \\            ║
╚═══════════════════════════════════════════════════════════════╝
`);

  if (initialPrompt) {
    try {
      await runCommand(initialPrompt, sh, page);
    } catch (e: any) {
      console.error("❌", e?.message);
    }
  }

  const LINE_SEP = "\u2028";
  let inPaste = false;
  let pending = "";

  const pasteFilter = new Transform({
    transform(chunk, _encoding, callback) {
      let str = pending + chunk.toString();
      pending = "";

      if (!inPaste) {
        str = str.replace(/\x1b\r|\x1b\n|\x1b\[13;2u|\x1b\[27;2;13~/g, LINE_SEP);
      }

      const partialMatch = str.match(/\x1b(\[([0-9]{0,3}(~?))?)?$/);
      if (partialMatch && partialMatch[0].length < 6 && !str.includes("\x1b[200~") && !str.includes("\x1b[201~")) {
        pending = partialMatch[0];
        str = str.slice(0, -pending.length);
      }

      while (str.length > 0) {
        if (!inPaste) {
          const startIdx = str.indexOf("\x1b[200~");
          if (startIdx === -1) {
            this.push(str);
            break;
          }
          this.push(str.slice(0, startIdx));
          inPaste = true;
          str = str.slice(startIdx + 6);
        } else {
          const endIdx = str.indexOf("\x1b[201~");
          if (endIdx === -1) {
            this.push(str.replace(/\r?\n/g, LINE_SEP));
            break;
          }
          this.push(str.slice(0, endIdx).replace(/\r?\n/g, LINE_SEP));
          inPaste = false;
          str = str.slice(endIdx + 6);
        }
      }
      callback();
    },
    flush(callback) {
      if (pending) this.push(pending);
      callback();
    },
  });

  input.pipe(pasteFilter);

  const rl = readline.createInterface({
    input: pasteFilter,
    output,
    prompt: "\n🤖 > ",
    completer: cliCompleter,
    tabSize: 2,
  });

  try {
    output.write("\x1b[?2004h");
  } catch {}

  let multiLineBuffer: string[] = [];

  const readLinePrompt = () => {
    rl.prompt();
  };

  readLinePrompt();

  for await (let rawLine of rl) {
    if (rawLine.includes(LINE_SEP)) {
      rawLine = rawLine.split(LINE_SEP).join("\n");
    }

    if (multiLineBuffer.length > 0) {
      if (rawLine.trim() === '"""' || rawLine.trim() === "/paste") {
        const fullPrompt = multiLineBuffer.join("\n").trim();
        multiLineBuffer = [];
        rl.setPrompt("\n🤖 > ");
        if (fullPrompt) {
          try {
            await runCommand(fullPrompt, sh, page);
          } catch (e: any) {
            console.error("❌", e?.message || e);
          }
        }
      } else {
        multiLineBuffer.push(rawLine);
      }
      readLinePrompt();
      continue;
    }

    const trimmed = rawLine.trim();

    if (trimmed.toLowerCase() === "/paste" || trimmed === '"""') {
      multiLineBuffer.push("");
      rl.setPrompt("... ");
      console.log('   (Multi-line mode active. Paste your text, then type """ or /paste on a new line to submit)\n');
      readLinePrompt();
      continue;
    }

    if (trimmed.toLowerCase() === "/edit" || trimmed.toLowerCase() === "/e") {
      const edited = await openInEditor();
      if (edited) {
        console.log(`\n📝 Submitting from editor:\n${edited}\n`);
        try {
          await runCommand(edited, sh, page);
        } catch (e: any) {
          console.error("❌", e?.message || e);
        }
      } else {
        console.log("   (Empty editor buffer — canceled)\n");
      }
      readLinePrompt();
      continue;
    }

    if (trimmed.endsWith("\\")) {
      multiLineBuffer.push(rawLine.slice(0, -1));
      rl.setPrompt("... ");
      readLinePrompt();
      continue;
    }

    if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit" || trimmed.toLowerCase() === "q") {
      break;
    }

    if (trimmed) {
      try {
        await runCommand(trimmed, sh, page);
      } catch (e: any) {
        console.error("❌", e?.message || e);
      }
    }

    readLinePrompt();
  }

  try {
    output.write("\x1b[?2004l");
  } catch {}
  rl.close();
}
