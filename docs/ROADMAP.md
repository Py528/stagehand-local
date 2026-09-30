# Stagehand Local — Roadmap & Known Issues

> Last updated: 2026-09-30
> Status legend: ✅ Done | 🔨 In Progress | 📋 Planned | 💡 Future Idea

---

## 🔨 Sprint: UI Fixes + Source Transparency (Current)

### Bug 1 — UI not showing agent responses  
**Root cause (confirmed):**  
The `agent_done` SSE event carries `result: result || "Done"` where `result` is the return value of `runAgent()`. For heuristic/pattern completions that return early (Tier 0, 0.4, 0.5), `runAgent()` returns the answer string correctly. The UI listener at `agent_done` calls `addAnswerMsg(d.result)` only if `d.result` is truthy — **but** for the conversational branch (line 277–283 in server.ts), the broadcast sends `result: session.lastAnswer || "Done"` where `session.lastAnswer` was just cleared by `softResetSession()` inside `handleConversational`. So for any task that goes through the conversational path the result is the string `"Done"` and `addAnswerMsg` renders "Done" — which the user doesn't see as a real answer.  

**For the non-conversational path:** `agent_step` events with `plan.action === "done"` carry `result` on the step event but the UI only looks at `agent_done`. The thinking bubble stays visible until `agent_done` fires.

**Actual fix needed:**
1. `agent_done.result` must be the real answer in all branches — check `session.lastAnswer` is populated before every `broadcast("agent_done", ...)`.
2. The `agent_step` event with `plan.action === "done"` should pre-populate the answer bubble in the UI so it appears the moment the agent finishes (not after the final screenshot is taken).
3. The UI `agent_done` handler must fall back to `session.lastAnswer` if `d.result === "Done"` (sentinel value).

**Files:** `src/server.ts` (broadcast calls), `src/webui.ts` (SSE handlers), `src/conversation.ts` (softResetSession ordering).

---

### Bug 2 — Source transparency: Google answer shown without attribution  
**Problem:**  
When the agent answers from a Google SERP fast-extract (no navigation to the actual career/restaurant page), the UI shows the answer as if it came from first-party data. There is no indication it came from a Google snippet, and no prompt to verify at the source.

**Required behaviour:**
- If answer came from Google SERP directly → append a source badge: `📍 From Google (unverified)`
- If the goal was a job/career check → append a prompt: `"Want me to visit the actual careers page to verify?"`
- If the answer came from a direct site visit → badge: `📍 Verified from <domain>`

**Implementation plan:**
1. Add `source` field to `runAgent()` return (or to `session`): enum `"google_serp" | "direct_site" | "playbook_api" | "pattern_replay" | "trace_replay" | "conversational"`.
2. Set `session.lastSource` alongside `session.lastAnswer` at every completion point in `planner.ts`.
3. Include `source` in `agent_done` broadcast payload.
4. UI: render a `<div class="source-badge">` below the answer bubble based on source value.
5. UI: if `source === "google_serp"` and goal looks like a job/business check → render `<button class="verify-btn">Verify at source →</button>` that sends a follow-up goal `"visit the actual [domain] page and verify: [original goal]"`.

**Files:** `src/planner.ts` (set lastSource), `src/conversation.ts` (session.lastSource field), `src/server.ts` (include source in broadcast), `src/webui.ts` (source badge + verify button).

---

### Bug 3 — Answer bubble formatting: plain text box is hard to read  
**Problem:**  
Answers are rendered in a plain `.bubble` div. Multi-line answers, bullet lists, bold text from the LLM markdown are not rendered. The visual difference between a user message and an agent answer is minimal.

**Required improvements:**
- Render `**bold**`, `- bullet`, `## heading`, ` ```code``` ` inside answer bubbles
- Add a subtle left-border accent for agent answers (not just background difference)
- Add a small "Copy" button (clipboard icon) on hover for any answer bubble
- Source badge rendered as a pill below the bubble (not inside it)

**Files:** `src/webui.ts` — `formatAnswer()` function (currently only handles `**bold**` and inline code), CSS for `.answer-bubble`.

---

## 📋 Planned (Next Sprint)

### Feature: Verify-at-source flow  
When agent answers from SERP and user clicks "Verify at source →":
1. Auto-inject follow-up goal: `"go to [extracted URL from SERP result] and confirm: [original goal]"`
2. Highlight the verify button as pending/loading during the follow-up run
3. On completion: replace the source badge with `✅ Verified from [domain]` or `⚠️ Could not confirm`

**Files:** `src/webui.ts` (button handler), `src/planner.ts` (pass original SERP result URL in session context so follow-up can use it).

---

### Feature: Answer cards instead of plain bubbles  
For structured answers (job listings, restaurant hours, weather), render a card component:

```
┌─────────────────────────────────────┐
│ 🕐 Basuri Pure Veg                  │
│ Open daily 11:00 AM – 11:00 PM      │
│ 📍 Tilak Road, Pune                 │
│ 📍 From Google  [Verify at source →]│
└─────────────────────────────────────┘
```

The planner would tag answers with a type: `"hours" | "job_listing" | "weather" | "media_playing" | "generic"`. The UI renders different card layouts per type.

**Files:** New `src/answer-types.ts`, updates to `planner.ts`, `webui.ts`.

---

### Feature: Context memory visible in UI  
Add a collapsible "Session Memory" panel in the sidebar showing:
- Currently pinned extractions (URLs + snippet)
- Last answer carried into this session
- Attached files

Allows user to understand why the agent answered a follow-up the way it did.

**Files:** `src/webui.ts` (new panel), `src/server.ts` (`/api/context` endpoint already needed), `src/conversation.ts` (expose pinned entries).

---

### Feature: Step detail expansion in activity log  
Currently activity log shows one line per step. Make each step expandable:
- Click a log line → expands inline to show full distilled snapshot (truncated), full plan JSON, token counts
- Useful for debugging wrong answers

**Files:** `src/webui.ts` (expandable log lines), `src/server.ts` (include full plan + snapshot in `agent_step` SSE).

---

## 💡 Future Ideas (No implementation date)

### Idea: Multi-turn job search workflow  
Goal: "Find CV engineer roles under 5 years exp at US remote companies"  
Agent visits 10 career pages sequentially, collecting structured records.  
Shows results in a table inside the chat panel.  
User can ask follow-ups: "which of these are in the EU?" / "filter by Ashby ATS".

---

### Idea: Background monitoring  
User registers a goal with a schedule: "check if Fictiv posts a CV role, notify me".  
Agent runs every 6h, compares results to last known state.  
On change: sends a desktop notification (macOS `osascript`) or writes to a file.

---

### Idea: Trace sharing  
Export `data/traces.json` + `data/patterns.json` as a bundle.  
Other users can import it — bootstrapping pattern library from community runs.  
Especially useful for YouTube/restaurant patterns that are universal.

---

### Idea: Answer confidence score  
Every answer gets a confidence band:
- 🟢 High: came from direct site navigation to an official page
- 🟡 Medium: came from Google SERP snippet  
- 🔴 Low: came from LLM synthesis with no source

Displayed as a small coloured dot next to the source badge.

---

### Idea: Inline browser navigation  
Replace the screenshot-based browser preview with a live `<iframe>` or embedded Chromium view.  
Requires a proxy layer (Playwright's CDP → WebSocket → iframe bridge).  
High complexity, low priority.

---

## Known Limitations (Not bugs, by design)

1. **YouTube requires a playing video to identify "which song is playing"** — if the browser was navigated away, the agent has no memory of what was playing. The session context only tracks text extractions, not media state.

2. **Pattern replay fails when playlist/autoplay changes the video** — stored `act` instructions reference the originally clicked video title. If YouTube autoplayed to a different video, the SelectorChain will not find the original title. Fix: record the page URL after click, not just the act instruction.

3. **Google SERP answers are unverified** — Google's AI overview or knowledge panel can be wrong (especially for job openings or business hours). Always verify job status at the actual company career page.

4. **Session memory doesn't survive `Ctrl+C` restart** — `data/session.json` is cleared on clean exit. Conversation history is in-memory only. After restart, the agent has no memory of previous tasks in the same session.

5. **Pattern slots are positional, not semantic** — "play millioner by honey singh" works because the compiler extracts `SONG=millioner, ARTIST=honey singh`. A goal like "honey singh millioner play" would not match the stored `youtube::media_play::SONG+ARTIST` pattern (different slot order). Fix: normalize goal word order in the compiler before pattern extraction.
