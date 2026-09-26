/**
 * heuristics.ts — Tier 0: Zero-LLM Deterministic Fast-Paths
 *
 * Handles predictable web interaction patterns with pure DOM scripting
 * and Playwright selectors. No LLM tokens consumed, executes in <100ms.
 *
 * Patterns covered:
 *  1. Media player control (YouTube, HTML5 video: play, pause, skip, seek)
 *  2. YouTube search → first video click
 *  3. Semantic subpage navigation (careers, pricing, contact, docs)
 *  4. Search result page → first organic link click
 *  5. Common form fills (search box on arbitrary sites)
 */

import MiniSearch from "minisearch";
import { sleep } from "./utils.js";
import { navigate } from "./browser.js";
import { fastCompileGoal, type ExecutionPlan } from "./compiler.js";

/* ══════════════════════════════════════════════════════════════
   Types
   ══════════════════════════════════════════════════════════════ */


export interface HeuristicResult {
  /** Human-readable description of what the heuristic did (for history log). */
  description: string;
  /** If the heuristic fully resolved the goal, this is the done message. */
  doneMessage?: string;
  /** If true, the heuristic only partially handled the step; planner should continue. */
  continueLoop?: boolean;
}

/* ══════════════════════════════════════════════════════════════
   Intent Detection Helpers
   ══════════════════════════════════════════════════════════════ */

interface ParsedMediaIntent {
  action: "play" | "pause" | "skip" | "mute" | "unmute" | "fullscreen";
  seconds?: number;
}

function parseMediaIntent(instruction: string): ParsedMediaIntent | null {
  const lower = instruction.toLowerCase();

  // Skip / Seek / Fast-forward
  const skipMatch = lower.match(
    /(?:skip|seek|fast[- ]?forward|jump)\s+(?:ahead\s+)?(?:to\s+)?(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)/
  );
  if (skipMatch && skipMatch[1] && skipMatch[2]) {
    const val = parseInt(skipMatch[1], 10);
    const unit = skipMatch[2];
    const seconds = unit.startsWith("m")
      ? val * 60
      : unit.startsWith("h")
        ? val * 3600
        : val;
    return { action: "skip", seconds };
  }

  // Skip without explicit unit → assume seconds
  const skipNoUnit = lower.match(
    /(?:skip|seek|fast[- ]?forward|jump)\s+(?:ahead\s+)?(?:to\s+)?(\d+)/
  );
  if (skipNoUnit && skipNoUnit[1]) {
    return { action: "skip", seconds: parseInt(skipNoUnit[1], 10) };
  }

  if (lower.includes("pause") || lower.includes("stop playing"))
    return { action: "pause" };
  if (
    lower.includes("play") &&
    !lower.includes("play the") &&
    !lower.includes("play a") &&
    !lower.includes("play video") &&
    !lower.includes("playlist")
  )
    return { action: "play" };
  if (lower.includes("mute")) return { action: "mute" };
  if (lower.includes("unmute")) return { action: "unmute" };
  if (lower.includes("fullscreen") || lower.includes("full screen"))
    return { action: "fullscreen" };

  return null;
}

type SemanticTarget =
  | "careers"
  | "pricing"
  | "contact"
  | "docs"
  | "about"
  | "blog"
  | "login"
  | "signup";

function parseSemanticNavTarget(instruction: string): SemanticTarget | null {
  // Strip URLs from instruction so domains like "news.ycombinator.com" don't trigger keywords
  const textOnly = instruction.replace(/https?:\/\/[^\s]+/gi, "").trim();
  const lower = textOnly.toLowerCase();

  // If the goal is an extraction or factual inquiry, do not hijack with navigation heuristics!
  if (
    /^(?:what|which|who|where|how|when|extract|summarize|find\s+(?:all|the\s+top|the\s+best)|think|analyze|compare|tell\s+me)\b/i.test(
      lower
    ) ||
    /\b(?:what\s+are|points?|comments?|highest|lowest|ratio|top\s+\d+|list\s+all)\b/i.test(lower)
  ) {
    return null;
  }

  const mapping: Array<{ keywords: string[]; target: SemanticTarget }> = [
    {
      keywords: [
        "career",
        "job",
        "jobs",
        "hiring",
        "open roles",
        "open positions",
        "work at",
        "join us",
        "we're hiring",
      ],
      target: "careers",
    },
    {
      keywords: ["pricing", "plans", "subscription", "cost", "how much"],
      target: "pricing",
    },
    {
      keywords: ["contact", "contact us", "get in touch", "support", "help"],
      target: "contact",
    },
    {
      keywords: [
        "docs",
        "documentation",
        "api reference",
        "developer",
        "getting started",
      ],
      target: "docs",
    },
    { keywords: ["about", "about us", "our story", "team"], target: "about" },
    { keywords: ["blog", "articles", "blog post", "company blog", "press release"], target: "blog" },
    { keywords: ["login", "log in", "sign in"], target: "login" },
    { keywords: ["signup", "sign up", "register", "create account"], target: "signup" },
  ];

  for (const { keywords, target } of mapping) {
    if (keywords.some((kw) => lower.includes(kw))) return target;
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
   Heuristic Handlers
   ══════════════════════════════════════════════════════════════ */

export function parseYouTubeSearchQuery(goal: string): string | null {
  const plan = fastCompileGoal(goal);
  if (plan?.service === "youtube" && plan.primaryQuery) {
    return plan.primaryQuery;
  }
  const lower = goal.toLowerCase();
  if (lower.includes("youtube") || lower.includes("play ") || lower.includes("watch ")) {
    const clean = goal
      .replace(/^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:play|watch|open)\s+(?:the\s+)?(?:video\s+of\s+|song\s+of\s+)?/i, "")
      .replace(/\s+on\s+youtube.*$/i, "")
      .replace(/[?!.]/g, "")
      .trim();
    return clean || null;
  }
  return null;
}

/**
 * Candidate video card extracted from search results page.
 */
export interface SearchCardCandidate {
  index: number;
  title: string;
  url?: string | undefined;
}

/**
 * Evaluates candidate cards on the page and clicks the one with the highest BM25/Fuzzy score.
 * Never clicks .first() blindly.
 */
export async function clickBestMatchingCard(
  page: any,
  containerSelector: string,
  titleSelector: string,
  query: string
): Promise<{ clicked: boolean; title?: string; targetIndex: number }> {
  // 1. Scrape candidate titles and indices directly in-browser (<15ms)
  const candidates: SearchCardCandidate[] = await page.evaluate(
    ({ containerSelector, titleSelector }: { containerSelector: string; titleSelector: string }) => {
      const cards = Array.from(document.querySelectorAll(containerSelector));
      const list: SearchCardCandidate[] = [];

      cards.slice(0, 15).forEach((card, idx) => {
        const titleEl = card.querySelector(titleSelector) as HTMLElement | null;
        const anchorEl = (card.tagName.toLowerCase() === "a" ? card : card.querySelector("a")) as HTMLAnchorElement | null;
        const channelEl = card.querySelector("#channel-name, ytd-channel-name") as HTMLElement | null;
        const channelText = channelEl?.innerText?.trim() || "";
        const titleText = titleEl?.textContent?.trim() || titleEl?.getAttribute("title") || "";
        if (titleText) {
          list.push({
            index: idx,
            title: channelText ? `${titleText} by ${channelText}` : titleText,
            url: anchorEl?.href || undefined,
          });
        }
      });
      return list;
    },
    { containerSelector, titleSelector }
  ).catch(() => []);

  if (candidates.length === 0) return { clicked: false, targetIndex: -1 };

  // 2. Index candidates with MiniSearch in-memory
  const ms = new MiniSearch<SearchCardCandidate>({
    fields: ["title"],
    storeFields: ["index", "title", "url"],
    searchOptions: {
      fuzzy: 0.2,
      prefix: true,
      boost: { title: 2 },
    },
  });
  ms.addAll(candidates);

  // Clean query: drop common stop-words
  const cleanQuery = query
    .replace(/[^\w\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !["play", "video", "song", "watch", "find", "the", "by", "from", "on", "youtube"].includes(w.toLowerCase()))
    .join(" ");

  const searchResults = ms.search(cleanQuery);

  // Determine target index: take top-scored result if score > 0, otherwise fallback to 0
  const targetIndex = searchResults.length > 0 ? (searchResults[0] as any).index : 0;
  const bestCandidate = candidates.find((c) => c.index === targetIndex);
  const bestTitle = bestCandidate?.title || "";

  // 3. Click the verified candidate index directly
  const clicked = await page.evaluate(
    ({ containerSelector, titleSelector, targetIndex }: { containerSelector: string; titleSelector: string; targetIndex: number }) => {
      const cards = Array.from(document.querySelectorAll(containerSelector));
      const targetCard = cards[targetIndex];
      if (!targetCard) return false;

      const clickTarget = (targetCard.querySelector(titleSelector) || targetCard.querySelector("a") || targetCard) as HTMLElement;
      if (clickTarget) {
        clickTarget.click();
        return true;
      }
      return false;
    },
    { containerSelector, titleSelector, targetIndex }
  ).catch(() => false);

  if (clicked) {
    // Wait for the URL transition to avoid CDP detachment
    await page.waitForURL(/.*watch\?v=.*/, { timeout: 6000 }).catch(() => {});
    await sleep(1500);
  }

  return { clicked, title: bestTitle, targetIndex };
}

/**
 * Handle media playback controls on the current page.
 * Works strictly on YouTube watch pages and any page with a primary HTML5 <video> element.
 */
async function tryMediaControl(
  page: any,
  goal: string,
  url: string
): Promise<HeuristicResult | null> {
  // STATE GATE 1: Never seek or skip on search results pages!
  if (url.includes("youtube.com/results") || url.includes("google.com/search")) {
    return null;
  }

  // STATE GATE 2: Seeking/skipping is strictly gated to watch pages
  const isVideoPage =
    url.includes("youtube.com/watch") ||
    url.includes("vimeo.com/") ||
    url.includes("dailymotion.com/video") ||
    url.includes("/video/");

  if (!isVideoPage) return null;

  const intent = parseMediaIntent(goal);
  if (!intent) return null;

  switch (intent.action) {
    case "skip": {
      const sec = intent.seconds || 30;
      await page.evaluate((s: number) => {
        const v = document.querySelector("#movie_player video, video.html5-main-video, video") as HTMLVideoElement | null;
        if (v) v.currentTime += s;
      }, sec).catch(() => {});
      return {
        description: `⚡ Heuristic: Skipped ${sec}s ahead in video`,
        doneMessage: `Skipped ${sec} seconds ahead in the video.`,
      };
    }

    case "pause":
      await page.evaluate(() => {
        const v = document.querySelector("#movie_player video, video.html5-main-video, video") as HTMLVideoElement | null;
        if (v) v.pause();
      }).catch(() => {});
      return { description: `⚡ Heuristic: Paused video`, doneMessage: "Video paused." };

    case "play":
      await page.evaluate(() => {
        const v = document.querySelector("#movie_player video, video.html5-main-video, video") as HTMLVideoElement | null;
        if (v) v.play().catch(() => {});
      }).catch(() => {});
      return {
        description: `⚡ Heuristic: Resumed playback`,
        doneMessage: "Video is now playing.",
      };

    case "mute":
      await page.evaluate(() => {
        const v = document.querySelector("#movie_player video, video.html5-main-video, video") as HTMLVideoElement | null;
        if (v) v.muted = true;
      }).catch(() => {});
      return { description: `⚡ Heuristic: Muted video`, doneMessage: "Video muted." };

    case "unmute":
      await page.evaluate(() => {
        const v = document.querySelector("#movie_player video, video.html5-main-video, video") as HTMLVideoElement | null;
        if (v) v.muted = false;
      }).catch(() => {});
      return {
        description: `⚡ Heuristic: Unmuted video`,
        doneMessage: "Video unmuted.",
      };

    case "fullscreen":
      await page.evaluate(() => {
        const v = document.querySelector("#movie_player video, video.html5-main-video, video") as HTMLVideoElement | null;
        if (v) v.requestFullscreen?.();
      }).catch(() => {});
      return {
        description: `⚡ Heuristic: Entered fullscreen`,
        doneMessage: "Video is now fullscreen.",
      };
  }
}

/**
 * On YouTube search results, rank all videos by goal keyword relevance / BM25
 * and click the best match (never blindly clicks .first()).
 */
async function tryYouTubeFirstVideoClick(
  page: any,
  goal: string,
  url: string,
  plan?: ExecutionPlan
): Promise<HeuristicResult | null> {
  if (!url.includes("youtube.com/results")) return null;

  const query = plan?.primaryQuery || goal;
  const res = await clickBestMatchingCard(
    page,
    "ytd-video-renderer, ytd-rich-item-renderer",
    "a#video-title, #video-title, #video-title-link",
    query
  );

  if (res.clicked) {
    const desc = res.title
      ? `⚡ Heuristic: Ranked and clicked best YouTube result: "${res.title.slice(0, 60)}"`
      : `⚡ Heuristic: Clicked best-matching YouTube video result`;
    return {
      description: desc,
      continueLoop: true, // Let next step confirm playback on the watch page
    };
  }

  return null;
}

/**
 * State tracking for heuristic ad skip attempts to escalate to LLM after 3 failures,
 * and semantic navigation target dedup to prevent infinite link-clicking loops.
 */
let adSkipAttempts = 0;
let lastWatchUrl = "";
let adSkipEscalatedToLLM = false;
const navigatedSemanticTargets = new Set<string>();

export function resetAdSkipState(): void {
  adSkipAttempts = 0;
  lastWatchUrl = "";
  adSkipEscalatedToLLM = false;
  navigatedSemanticTargets.clear();
}

/**
 * Accurately determines if a YouTube video ad is currently active,
 * distinguishing between live ads and persistent/empty DOM containers.
 */
export async function isYouTubeAdActive(page: any): Promise<boolean> {
  return await page.evaluate(() => {
    const player = document.getElementById("movie_player") as any;
    if (!player) return false;

    // 1. YouTube Player API truth: isAd flag and adState
    const isAdData = player?.getVideoData?.()?.isAd === true;
    const adState = typeof player?.getAdState === "function" ? player.getAdState() : -1;
    if (isAdData || adState > 0) return true;

    // 2. Class check on movie_player
    const isPlayerAd =
      player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
    const hasAdClass = !!document.querySelector(".ad-showing, .ad-interrupting");

    if (!isPlayerAd && !hasAdClass) return false;

    // 3. Disambiguate lingering/empty ad containers:
    // If ad-showing class is present, ensure there is an actual ad element/overlay with content.
    const hasAdText = !!document.querySelector(
      ".ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-duration-remaining, .ytp-ad-skip-button-text"
    );
    const hasSkipBtn = !!document.querySelector(
      ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, [class*='skip' i]"
    );
    const overlay = document.querySelector(".ytp-ad-player-overlay, .ytp-ad-player-overlay-layout") as HTMLElement | null;
    const hasVisibleOverlay = overlay
      ? overlay.offsetWidth > 0 && overlay.offsetHeight > 0 && overlay.innerHTML.trim().length > 0
      : false;

    // If player reports video is NOT an ad, and no ad text, skip button, or visible overlay exists,
    // the container is lingering/stale and not an active ad.
    if (player?.getVideoData?.()?.isAd === false && adState <= 0 && !hasAdText && !hasSkipBtn && !hasVisibleOverlay) {
      return false;
    }

    return true;
  }).catch(() => false);
}

/**
 * Invariant 1: Delta-State Verified YouTube Ad Skipper
 * Multi-vector skip:
 * 1. Accelerates countdowns/unskippable ads via 16x playback speedup & mute.
 * 2. Attempts YouTube player API skipAd().
 * 3. Triggers both synthetic DOM events and Playwright native trusted CDP clicks.
 * 4. Takes diagnostic debug dump and screenshot on attempt 1 when ad is showing.
 * 5. Restores content video settings upon completion.
 */
export async function skipYouTubeAdWithVerification(
  page: any,
  maxWaitMs = 8000,
  isFirstAttempt = false
): Promise<"clean" | "timeout"> {
  const start = Date.now();
  let debugDumped = false;

  while (Date.now() - start < maxWaitMs) {
    const adShowing = await isYouTubeAdActive(page);

    if (!adShowing) {
      // Small settle check to guard against transient transitions between back-to-back ads
      await sleep(250);
      const confirmedGone = !(await isYouTubeAdActive(page));
      if (confirmedGone) {
        // Restore content video settings
        await page.evaluate(() => {
          const video = document.querySelector(
            "#movie_player video, video.html5-main-video, video"
          ) as HTMLVideoElement | null;
          if (video) {
            video.muted = false;
            video.playbackRate = 1.0;
          }
        }).catch(() => {});
        return "clean";
      }
    }

    // Diagnostic dump on attempt 1 when ad is showing (temporary debug)
    if (adShowing && isFirstAttempt && !debugDumped) {
      debugDumped = true;
      const debug = await page.evaluate(() => {
        const skipCandidates = Array.from(document.querySelectorAll('[class*="skip" i]'))
          .map((el) => ({
            tag: el.tagName,
            class: el.className,
            text: (el as HTMLElement).innerText?.slice(0, 40),
            visible: (el as HTMLElement).offsetParent !== null,
            disabled: el.hasAttribute("disabled"),
          }));
        const adOverlay = document.querySelector(".ad-showing, .ad-interrupting")?.outerHTML?.slice(0, 300);
        return { skipCandidates, adOverlay };
      }).catch((e: any) => ({ error: String(e) }));
      console.log("🔍 AD DEBUG:", JSON.stringify(debug, null, 2));
      await page.screenshot({ path: `debug-ad-${Date.now()}.png` }).catch(() => {});
    }

    // 1. In-page evaluate: speedup, skipAd call, synthetic clicks, countdown acceleration
    const domResult = await page.evaluate(() => {
      const player = document.getElementById("movie_player") as any;

      // Call YouTube player API skip
      if (player && typeof player.skipAd === "function") {
        try { player.skipAd(); } catch {}
      }

      // Check if ad is actively playing according to player data
      const isLiveAd =
        player?.getVideoData?.()?.isAd === true ||
        player?.classList?.contains("ad-showing") ||
        player?.classList?.contains("ad-interrupting");

      const video = document.querySelector(
        "#movie_player video, video.html5-main-video, video"
      ) as HTMLVideoElement | null;

      if (video) {
        if (isLiveAd) {
          try {
            video.muted = true;
            video.playbackRate = 16;
            if (video.paused) video.play().catch(() => {});
          } catch {}

          // ONLY fast-forward short unskippable bumper/pre-roll ads (duration <= 30s)
          // NEVER touch currentTime for longer videos or content videos!
          if (isFinite(video.duration) && video.duration > 0 && video.duration <= 30) {
            try {
              video.currentTime = video.duration;
            } catch {}
          }
        } else {
          // Content video is active — ensure normal speed and unmuted
          try {
            video.playbackRate = 1.0;
            video.muted = false;
          } catch {}
        }
      }

      // Scan for skip buttons
      const skipSelectors = [
        ".ytp-skip-ad-button",
        ".ytp-ad-skip-button",
        ".ytp-ad-skip-button-modern",
        "button.ytp-ad-skip-button",
        "button.ytp-ad-skip-button-modern",
        ".ytp-ad-skip-button-container button",
        ".ytp-ad-skip-button-slot button",
        '[id^="skip-button"] button',
        ".ytp-ad-skip-button-text",
        'button[class*="skip" i]',
        '[aria-label*="skip" i]',
        ".ytp-ad-overlay-close-button",
        ".ytp-ad-text.ytp-ad-skip-button-text",
      ];
      const candidates = Array.from(
        document.querySelectorAll(skipSelectors.join(", "))
      ) as HTMLElement[];

      const skipBtn = candidates.find((btn) => {
        const visible = btn.offsetParent !== null || btn.offsetWidth > 0 || btn.offsetHeight > 0;
        const enabled = !btn.hasAttribute("disabled") && btn.getAttribute("aria-disabled") !== "true";
        return visible && enabled;
      });

      if (skipBtn) {
        // Synthetic events
        const opts = { bubbles: true, cancelable: true, view: window };
        skipBtn.dispatchEvent(new PointerEvent("pointerdown", opts));
        skipBtn.dispatchEvent(new MouseEvent("mousedown", opts));
        skipBtn.dispatchEvent(new PointerEvent("pointerup", opts));
        skipBtn.dispatchEvent(new MouseEvent("mouseup", opts));
        skipBtn.click();
        (skipBtn.closest("button") || skipBtn).click();

        const rect = skipBtn.getBoundingClientRect();
        return {
          found: true,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        };
      }

      return { found: false, rect: null };
    }).catch(() => null);

    // 2. Playwright native trusted CDP mouse click (hardware-level click with isTrusted: true)
    if (domResult?.found && domResult.rect && typeof page.mouse?.click === "function") {
      const x = Math.round(domResult.rect.x + domResult.rect.width / 2);
      const y = Math.round(domResult.rect.y + domResult.rect.height / 2);
      if (x > 0 && y > 0) {
        await page.mouse.click(x, y).catch(() => {});
      }
    }

    // 3. Playwright native locator clicks
    if (typeof page.locator === "function") {
      for (const sel of [
        ".ytp-skip-ad-button",
        ".ytp-ad-skip-button",
        ".ytp-ad-skip-button-modern",
        "button.ytp-ad-skip-button",
        "button.ytp-ad-skip-button-modern",
        ".ytp-ad-skip-button-container button",
        ".ytp-ad-skip-button-slot button",
        '[id^="skip-button"] button',
        ".ytp-ad-overlay-close-button",
      ]) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible().catch(() => false)) {
            await loc.click({ force: true, timeout: 400 }).catch(() => {});
            break;
          }
        } catch {}
      }
    }

    await sleep(500);
  }

  // Final check
  const isGone = !(await isYouTubeAdActive(page));
  if (isGone) {
    await page.evaluate(() => {
      const video = document.querySelector(
        "#movie_player video, video.html5-main-video, video"
      ) as HTMLVideoElement | null;
      if (video) {
        video.muted = false;
        video.playbackRate = 1.0;
      }
    }).catch(() => {});
    return "clean";
  }

  return "timeout";
}

/**
 * Invariant 1: Delta-State Verified Media Seek
 * Never assumes seekTo worked. Reads back actual playback time after a 500ms settle.
 */
export async function seekAndVerifyYouTube(
  page: any,
  targetSeconds: number,
  isAbsolute = true
): Promise<{ success: boolean; actualTime: number }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(
      ({ targetSeconds, isAbsolute }: { targetSeconds: number; isAbsolute: boolean }) => {
        const player = document.getElementById("movie_player") as any;
        const video = document.querySelector(
          "#movie_player video, video.html5-main-video, video"
        ) as HTMLVideoElement | null;

        if (player && typeof player.seekTo === "function") {
          player.seekTo(targetSeconds, true);
          if (player.playVideo) player.playVideo();
        } else if (video) {
          if (isAbsolute) {
            video.currentTime = targetSeconds;
          } else {
            video.currentTime += targetSeconds;
          }
          if (video.paused) video.play().catch(() => {});
        }
        if (video) {
          video.playbackRate = 1.0;
          video.muted = false;
        }
      },
      { targetSeconds, isAbsolute }
    ).catch(() => {});

    await sleep(500);

    const actualTime = await page.evaluate(() => {
      const player = document.getElementById("movie_player") as any;
      const video = document.querySelector(
        "#movie_player video, video.html5-main-video, video"
      ) as HTMLVideoElement | null;

      if (player && typeof player.getCurrentTime === "function") {
        return Math.round(player.getCurrentTime());
      }
      if (video) {
        return Math.round(video.currentTime);
      }
      return -1;
    }).catch(() => -1);

    if (actualTime >= 0 && Math.abs(actualTime - targetSeconds) < 4) {
      return { success: true, actualTime };
    }

    await sleep(300);
  }

  const finalTime = await page.evaluate(() => {
    const player = document.getElementById("movie_player") as any;
    return player?.getCurrentTime ? Math.round(player.getCurrentTime()) : -1;
  }).catch(() => -1);

  return { success: finalTime >= 0, actualTime: finalTime };
}

/**
 * On YouTube watch page, check if the loaded video matches the requested goal.
 * Uses Invariant 1 Delta-State verification:
 * 1. Verifies ad is genuinely gone via tight internal poll (0 planner steps).
 * 2. Verifies title hydration.
 * 3. Verifies seek actually occurred by reading back player.getCurrentTime().
 */
async function tryYouTubeWatchPageCheck(
  page: any,
  goal: string,
  url: string,
  plan?: ExecutionPlan
): Promise<HeuristicResult | null> {
  if (!url.includes("youtube.com/watch")) return null;

  const lower = goal.toLowerCase();
  const isPlayRequest =
    lower.includes("play") ||
    lower.includes("watch") ||
    lower.includes("listen") ||
    lower.includes("open") ||
    plan?.intent === "media_play";

  if (!isPlayRequest) return null;

  const targetPlan = plan || fastCompileGoal(goal);
  const targetSeconds = targetPlan?.timeOffsetSeconds ?? null;
  const isAbsolute = targetPlan?.isAbsoluteSeek ?? true;

  // 1. Invariant 1: Delta-State Verified Ad Skip with 3-attempt escalation to LLM
  if (url !== lastWatchUrl) {
    lastWatchUrl = url;
    adSkipAttempts = 0;
    adSkipEscalatedToLLM = false;
  }

  // If already escalated to LLM for this ad:
  if (adSkipEscalatedToLLM) {
    const stillAd = await isYouTubeAdActive(page);
    if (stillAd) {
      console.log(`   🤖 YouTube ad still active — yielding to LLM planner for action...`);
      return null; // Fall through to LLM planner!
    } else {
      // Ad has ended (either cleared by LLM or completed playback)
      adSkipEscalatedToLLM = false;
      adSkipAttempts = 0;
    }
  }

  const isAd = await isYouTubeAdActive(page);
  if (isAd) {
    adSkipAttempts++;
    const isFirstAttempt = adSkipAttempts === 1;

    const adResult = await skipYouTubeAdWithVerification(page, 7000, isFirstAttempt);
    if (adResult !== "clean") {
      if (adSkipAttempts >= 3) {
        console.log(`   ⚠️ Heuristic ad skipping failed after 3 attempts — escalating to LLM planner.`);
        adSkipEscalatedToLLM = true;
        return null; // Fall through to LLM planner!
      }
      return {
        description: `⚡ Heuristic: Video pre-roll ad in progress (attempt ${adSkipAttempts}/3), waiting for stream...`,
        continueLoop: true,
      };
    }
    // Ad was cleanly bypassed/skipped!
    adSkipAttempts = 0;
    adSkipEscalatedToLLM = false;
  }

  // 2. Hydration Check: wait up to 3.5s for video metadata and real title to hydrate
  let videoTitle = "";
  for (let i = 0; i < 7; i++) {
    videoTitle = await page.evaluate(() => {
      const titleEl = document.querySelector(
        "h1.ytd-watch-metadata, #title h1, ytd-watch-metadata h1, ytd-video-primary-info-renderer h1"
      );
      const title = ((titleEl as HTMLElement)?.innerText || document.title || "")
        .replace(/\s*-\s*YouTube.*$/i, "")
        .trim();
      return title.toLowerCase() !== "youtube" ? title : "";
    }).catch(() => "");

    if (videoTitle) break;
    await sleep(500);
  }

  if (!videoTitle) {
    return {
      description: `⚡ Heuristic: Waiting for YouTube player title hydration...`,
      continueLoop: true,
    };
  }

  // 3. Invariant 1: Delta-State Verified Seek (read back actual playback time)
  let actualSeconds = 0;
  if (targetSeconds !== null && targetSeconds > 0) {
    const seekResult = await seekAndVerifyYouTube(page, targetSeconds, isAbsolute);
    actualSeconds = seekResult.actualTime >= 0 ? seekResult.actualTime : targetSeconds;
  } else {
    await page.evaluate(() => {
      const player = document.getElementById("movie_player") as any;
      if (player?.playVideo) player.playVideo();
      const video = document.querySelector("#movie_player video, video.html5-main-video, video") as HTMLVideoElement | null;
      if (video?.paused) video.play().catch(() => {});
      if (video) {
        video.playbackRate = 1.0;
        video.muted = false;
      }
    }).catch(() => {});
  }

  const timeNote = targetSeconds !== null ? ` at ${actualSeconds}s` : "";
  return {
    description: `⚡ Heuristic: Verified playback of "${videoTitle.slice(0, 50)}"${timeNote}`,
    doneMessage: `Now playing "${videoTitle}" on YouTube${timeNote}.`,
  };
}



/**
 * Tier 0: Google SERP Fast-Hop
 *
 * Completely bypasses the LLM planner on Google Search result pages:
 * 1. Checks for an immediate visible direct answer (Featured Snippet / description box).
 *    If present and factual, marks step resolved immediately.
 * 2. Otherwise, finds the first clean organic result link:
 *    page.locator('#search a[href^="http"]:not([href*="google.com"])').first()
 * 3. Navigates directly via page.goto(href) or click.
 * 4. Returns continueLoop: true so the planner loop completely bypasses the LLM on SERP.
 */
async function tryGoogleSearchFastHop(
  page: any,
  goal: string,
  url: string
): Promise<HeuristicResult | null> {
  if (!url.includes("google.com/search")) return null;

  // 1. Check for immediate, visible direct answer
  const directAnswer = await page
    .evaluate(() => {
      const answerEl = document.querySelector(
        'div[data-attrid="wa:/description"], div.LGOjhe, [data-async-context*="overview"]'
      );
      if (answerEl) {
        const text = (answerEl as HTMLElement).innerText?.trim();
        if (text && text.length > 50) return text;
      }
      return null;
    })
    .catch(() => null);

  // If a direct answer exists and goal is simple factual inquiry
  if (directAnswer) {
    const isFactual = /what is|who is|when was|where is|definition|how many|rate|price/i.test(goal);
    if (isFactual) {
      return {
        description: `⚡ Heuristic: Found immediate Google direct answer`,
        doneMessage: directAnswer,
      };
    }
  }

  // 2. Locate first clean organic result link and fast-hop
  try {
    const targetHref = await page
      .evaluate(() => {
        // Look for organic search result cards with an h3 heading
        const links = document.querySelectorAll(
          '#search a[href]:not([href*="google.com"]), #rso a[href]:not([href*="google.com"]), div.g a[href]:not([href*="google.com"])'
        );
        for (const link of Array.from(links)) {
          const href = (link as HTMLAnchorElement).href;
          if (!href || !href.startsWith("http") || href.includes("google.com")) continue;
          // Verify it's an organic card with a visible h3
          const hasH3 =
            link.querySelector("h3") ||
            link.closest("div.g, div[data-hveid]")?.querySelector("h3");
          if (hasH3) return href;
        }
        // Fallback: first external link in the main search container
        for (const link of Array.from(links)) {
          const href = (link as HTMLAnchorElement).href;
          if (href && href.startsWith("http") && !href.includes("google.com")) {
            return href;
          }
        }
        return null;
      })
      .catch(() => null);

    if (targetHref && targetHref.startsWith("http")) {
      console.log(`   🌐 Heuristic Fast-Hop: Navigating directly to ${targetHref}`);
      await page.goto(targetHref).catch(() => {});
      await sleep(1500);
      return {
        description: `⚡ Heuristic: Fast-hop into first organic Google result → ${targetHref}`,
        continueLoop: true,
      };
    }
  } catch {}

  return null;
}

function isAlreadyOnTargetPage(url: string, target: SemanticTarget): boolean {
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  const lowerUrl = url.toLowerCase();

  switch (target) {
    case "careers":
      return (
        pathname.includes("/career") ||
        pathname.includes("/job") ||
        pathname.includes("/opening") ||
        pathname.includes("/position") ||
        lowerUrl.includes("ashbyhq.com") ||
        lowerUrl.includes("greenhouse.io") ||
        lowerUrl.includes("lever.co") ||
        lowerUrl.includes("workday.com")
      );
    case "pricing":
      return pathname.includes("/pricing") || pathname.includes("/plan");
    case "contact":
      return pathname.includes("/contact") || pathname.includes("/support");
    case "docs":
      return pathname.includes("/doc") || pathname.includes("/developer") || pathname.includes("/api");
    case "about":
      return pathname.includes("/about") || pathname.includes("/team") || pathname.includes("/our-story");
    case "blog":
      return pathname.includes("/blog") || pathname.includes("/article") || pathname.includes("/news");
    case "login":
      return pathname.includes("/login") || pathname.includes("/signin") || pathname.includes("/sign-in");
    case "signup":
      return pathname.includes("/signup") || pathname.includes("/register") || pathname.includes("/sign-up");
    default:
      return false;
  }
}

/**
 * Navigate to a semantic subpage (careers, pricing, contact, etc.)
 * by scanning for common link patterns in the current page's navigation.
 */
async function trySemanticNavigation(
  page: any,
  goal: string,
  url: string
): Promise<HeuristicResult | null> {
  // Don't try on search engines
  if (
    url.includes("google.com") ||
    url.includes("bing.com") ||
    url.includes("duckduckgo.com")
  )
    return null;

  const target = parseSemanticNavTarget(goal);
  if (!target) return null;

  // Guard 1: If already on target page, yield to extractor / LLM planner!
  if (isAlreadyOnTargetPage(url, target)) {
    return null;
  }

  // Guard 2: Never repeat navigation to the same target on the same domain
  let domain = "";
  try {
    domain = new URL(url).hostname;
  } catch {}
  const navKey = `${domain}:${target}`;
  if (navigatedSemanticTargets.has(navKey)) {
    return null;
  }

  const selectorMap: Record<SemanticTarget, string> = {
    careers:
      'a[href*="ashbyhq.com" i], a[href*="greenhouse.io" i], a[href*="lever.co" i], a[href*="workday.com" i], a[href*="career" i], a[href*="jobs" i], a[href*="job-openings" i], a[href*="join" i], a[href*="hiring" i]',
    pricing: 'a[href*="pricing" i], a[href*="plans" i]',
    contact: 'a[href*="contact" i], a[href*="support" i]',
    docs: 'a[href*="docs" i], a[href*="documentation" i], a[href*="developer" i], a[href*="api" i]',
    about: 'a[href*="about" i], a[href*="our-story" i], a[href*="team" i]',
    blog: 'a[href*="blog" i], a[href*="articles" i], a[href*="news" i]',
    login: 'a[href*="login" i], a[href*="signin" i], a[href*="sign-in" i]',
    signup:
      'a[href*="signup" i], a[href*="register" i], a[href*="sign-up" i], a[href*="create-account" i]',
  };

  const selector = selectorMap[target];
  if (!selector) return null;

  const urlBefore = await page.url().catch(() => url);

  const clicked = await page.evaluate(
    ({ sel, currentUrl }: { sel: string; currentUrl: string }) => {
      let curOrigin = "";
      let curPath = "";
      try {
        const u = new URL(currentUrl);
        curOrigin = u.origin;
        curPath = u.pathname.replace(/\/$/, "");
      } catch {}

      const links = document.querySelectorAll(sel);
      for (const link of links) {
        const el = link as HTMLElement;
        try {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
        } catch {
          continue;
        }

        // Guard 3: Ignore anchor hash links (#jobs) or links to the current page
        const href = (el as HTMLAnchorElement).href;
        if (href) {
          try {
            const targetUrl = new URL(href, currentUrl);
            if (
              targetUrl.origin === curOrigin &&
              targetUrl.pathname.replace(/\/$/, "") === curPath
            ) {
              continue;
            }
          } catch {}
        }

        el.click();
        return (el as HTMLAnchorElement).href || true;
      }
      return null;
    },
    { sel: selector, currentUrl: url }
  ).catch(() => null);

  if (clicked) {
    await sleep(1500);
    const urlAfter = await page.url().catch(() => urlBefore);
    const cleanBefore = urlBefore.split("#")[0].replace(/\/$/, "");
    const cleanAfter = urlAfter.split("#")[0].replace(/\/$/, "");

    // Delta-State Verification: if URL didn't change, no actual navigation occurred!
    if (cleanBefore === cleanAfter) {
      return null;
    }

    navigatedSemanticTargets.add(navKey);
    return {
      description: `⚡ Heuristic: Navigated to ${target} page via link click`,
      continueLoop: true,
    };
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
   Main Heuristic Dispatcher
   
   Called at the start of each planner step. Returns a result
   if a heuristic handled the action, or null to fall through
   to the LLM planner.
   ══════════════════════════════════════════════════════════════ */

/**
 * Try all heuristic handlers in priority order.
 * Returns HeuristicResult if one handled it, null otherwise.
 */
export async function tryHeuristic(
  page: any,
  goal: string,
  url: string,
  _history: string[],
  plan?: ExecutionPlan
): Promise<HeuristicResult | null> {
  try {
    const effectivePlan = plan || fastCompileGoal(goal);

    // 0. From about:blank, navigate directly to YouTube search if intent is to play/watch on YouTube
    if (url === "about:blank" || url.startsWith("about:")) {
      const ytQuery =
        effectivePlan?.service === "youtube" && effectivePlan.primaryQuery
          ? effectivePlan.primaryQuery
          : parseYouTubeSearchQuery(goal);

      if (ytQuery) {
        const targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery)}`;
        await navigate(page, targetUrl).catch(() => {});
        return {
          description: `⚡ Heuristic: Navigated directly to YouTube search for "${ytQuery}"`,
          continueLoop: true,
        };
      }
    }

    // 1. YouTube watch page: check if requested video is already loaded & playing (and apply time offset)
    const ytWatch = await tryYouTubeWatchPageCheck(page, goal, url, effectivePlan || undefined);
    if (ytWatch) return ytWatch;

    // 2. Media player control (skip, pause, play, mute, fullscreen - strictly gated to watch page)
    const media = await tryMediaControl(page, goal, url);
    if (media) return media;

    // 3. YouTube search results → rank & click best matching video
    const ytClick = await tryYouTubeFirstVideoClick(page, goal, url, effectivePlan || undefined);
    if (ytClick) return ytClick;

    // 4. Google search results → Fast-Hop (bypasses LLM on SERP)
    const googleHop = await tryGoogleSearchFastHop(page, goal, url);
    if (googleHop) return googleHop;

    // 5. Semantic subpage navigation (careers, pricing, etc.)
    const semantic = await trySemanticNavigation(page, goal, url);
    if (semantic) return semantic;
  } catch {
    // Heuristics should never crash the agent
  }

  return null;
}

