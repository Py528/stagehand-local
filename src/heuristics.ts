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

import { sleep } from "./utils.js";

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
  const lower = instruction.toLowerCase();

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
    { keywords: ["blog", "articles", "news", "updates"], target: "blog" },
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

/**
 * Handle media playback controls on the current page.
 * Works on YouTube watch pages and any page with an HTML5 <video> element.
 */
async function tryMediaControl(
  page: any,
  goal: string,
  url: string
): Promise<HeuristicResult | null> {
  const intent = parseMediaIntent(goal);
  if (!intent) return null;

  const isVideoPage =
    url.includes("youtube.com/watch") ||
    url.includes("vimeo.com/") ||
    url.includes("dailymotion.com/video");

  // Only try media controls if we're on a video page or there's a <video> tag
  if (!isVideoPage) {
    const hasVideo = await page
      .evaluate(() => !!document.querySelector("video"))
      .catch(() => false);
    if (!hasVideo) return null;
  }

  switch (intent.action) {
    case "skip": {
      const sec = intent.seconds || 30;
      if (url.includes("youtube.com/watch")) {
        // YouTube-specific: use keyboard shortcut or direct currentTime
        await page.evaluate((s: number) => {
          const v = document.querySelector("video") as HTMLVideoElement | null;
          if (v) v.currentTime += s;
        }, sec);
      } else {
        await page.evaluate((s: number) => {
          const v = document.querySelector("video") as HTMLVideoElement | null;
          if (v) v.currentTime += s;
        }, sec);
      }
      return {
        description: `⚡ Heuristic: Skipped ${sec}s ahead in video`,
        doneMessage: `Skipped ${sec} seconds ahead in the video.`,
      };
    }

    case "pause":
      await page.evaluate(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (v) v.pause();
      });
      return { description: `⚡ Heuristic: Paused video`, doneMessage: "Video paused." };

    case "play":
      await page.evaluate(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (v) v.play();
      });
      return {
        description: `⚡ Heuristic: Resumed playback`,
        doneMessage: "Video is now playing.",
      };

    case "mute":
      await page.evaluate(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (v) v.muted = true;
      });
      return { description: `⚡ Heuristic: Muted video`, doneMessage: "Video muted." };

    case "unmute":
      await page.evaluate(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (v) v.muted = false;
      });
      return {
        description: `⚡ Heuristic: Unmuted video`,
        doneMessage: "Video unmuted.",
      };

    case "fullscreen":
      await page.evaluate(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (v) v.requestFullscreen?.();
      });
      return {
        description: `⚡ Heuristic: Entered fullscreen`,
        doneMessage: "Video is now fullscreen.",
      };
  }
}

/**
 * On YouTube search results, click the first video.
 */
async function tryYouTubeFirstVideoClick(
  page: any,
  goal: string,
  url: string
): Promise<HeuristicResult | null> {
  if (!url.includes("youtube.com/results")) return null;

  const lower = goal.toLowerCase();
  if (
    !(
      lower.includes("play") ||
      lower.includes("click") ||
      lower.includes("watch") ||
      lower.includes("open") ||
      lower.includes("video") ||
      lower.includes("song") ||
      lower.includes("music")
    )
  )
    return null;

  // Try clicking the first video title link
  const clicked = await page.evaluate(() => {
    // Primary selector: video renderer title link
    const selectors = [
      "ytd-video-renderer a#video-title",
      "ytd-video-renderer h3 a",
      "#contents ytd-video-renderer a#thumbnail",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);

  if (clicked) {
    await sleep(1500); // Wait for navigation
    return {
      description: "⚡ Heuristic: Clicked first YouTube video result",
      continueLoop: true, // Let planner confirm it's playing and report "done"
    };
  }
  return null;
}

/**
 * On Google search results, click the first organic result.
 * Only triggers when the goal implies navigating INTO a result (not just reading snippets).
 */
async function tryGoogleFirstResultClick(
  page: any,
  goal: string,
  url: string
): Promise<HeuristicResult | null> {
  if (!url.includes("google.com/search")) return null;

  // Only click through if goal implies we need to visit the actual site
  const lower = goal.toLowerCase();
  const deepNavKeywords = [
    "career",
    "job",
    "hiring",
    "pricing",
    "contact",
    "documentation",
    "docs",
    "open roles",
    "remote",
    "apply",
    "features",
    "download",
  ];
  if (!deepNavKeywords.some((kw) => lower.includes(kw))) return null;

  const clicked = await page.evaluate(() => {
    // Google organic result links
    const selectors = [
      "#search a[data-ved][href]:not([href*='google.com'])",
      "#rso a[href]:not([href*='google.com'])",
      ".g a[href]:not([href*='google.com'])",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel) as HTMLAnchorElement | null;
      if (el && el.href && !el.href.includes("google.com")) {
        el.click();
        return el.href;
      }
    }
    return null;
  }).catch(() => null);

  if (clicked) {
    await sleep(2000); // Wait for navigation
    return {
      description: `⚡ Heuristic: Clicked first Google result → ${clicked}`,
      continueLoop: true,
    };
  }
  return null;
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

  const selectorMap: Record<SemanticTarget, string> = {
    careers:
      'a[href*="career" i], a[href*="jobs" i], a[href*="job-openings" i], a[href*="join" i], a[href*="hiring" i], a[href*="lever.co" i], a[href*="greenhouse.io" i], a[href*="ashbyhq.com" i]',
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

  const clicked = await page.evaluate((sel: string) => {
    const links = document.querySelectorAll(sel);
    for (const link of links) {
      const el = link as HTMLElement;
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
      } catch {
        continue;
      }
      el.click();
      return (el as HTMLAnchorElement).href || true;
    }
    return null;
  }, selector).catch(() => null);

  if (clicked) {
    await sleep(2000);
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
  _history: string[]
): Promise<HeuristicResult | null> {
  try {
    // 1. Media player control (highest priority — zero ambiguity)
    const media = await tryMediaControl(page, goal, url);
    if (media) return media;

    // 2. YouTube search results → first video click
    const ytClick = await tryYouTubeFirstVideoClick(page, goal, url);
    if (ytClick) return ytClick;

    // 3. Google search results → first organic click (for deep-nav goals)
    const googleClick = await tryGoogleFirstResultClick(page, goal, url);
    if (googleClick) return googleClick;

    // 4. Semantic subpage navigation (careers, pricing, etc.)
    const semantic = await trySemanticNavigation(page, goal, url);
    if (semantic) return semantic;
  } catch {
    // Heuristics should never crash the agent
  }

  return null;
}
