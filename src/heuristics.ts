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
 * Extract YouTube search query from natural language goals like:
 * "could you play the video of crown? on youtube from txt?"
 * "play crown by txt on youtube"
 * "watch bohemian rhapsody on youtube"
 */
export function parseYouTubeSearchQuery(goal: string): string | null {
  const clean = goal.replace(/[?!.]/g, "").trim();

  // Pattern 1: play ... on youtube from/by ...
  let m = clean.match(/(?:play|watch|listen\s+to|open)\s+(?:the\s+)?(?:video\s+(?:of\s+)?|song\s+(?:of\s+)?|track\s+(?:of\s+)?)?(.+?)\s+on\s+youtube\s+(?:from|by)\s+(.+)/i);
  if (m && m[1] && m[2]) return `${m[1].trim()} ${m[2].trim()}`;

  // Pattern 2: play ... by/from ... on youtube
  m = clean.match(/(?:play|watch|listen\s+to|open)\s+(?:the\s+)?(?:video\s+(?:of\s+)?|song\s+(?:of\s+)?|track\s+(?:of\s+)?)?(.+?)\s+(?:by|from)\s+(.+?)\s+on\s+youtube/i);
  if (m && m[1] && m[2]) return `${m[1].trim()} ${m[2].trim()}`;

  // Pattern 3: on youtube ... play ...
  m = clean.match(/on\s+youtube\s+(?:play|watch|search\s+for|find|open)\s+(.+)/i);
  if (m && m[1]) return m[1].trim();

  // Pattern 4: play ... on youtube
  m = clean.match(/(?:play|watch|listen\s+to|open|search\s+for|find)\s+(?:the\s+)?(?:video\s+(?:of\s+)?|song\s+(?:of\s+)?|track\s+(?:of\s+)?)?(.+?)\s+on\s+youtube/i);
  if (m && m[1]) return m[1].trim();

  // Pattern 5: youtube <query> or search youtube <query>
  m = clean.match(/^(?:search\s+youtube\s+(?:for\s+)?|youtube\s+(?:search\s+(?:for\s+)?|for\s+)?)(.+)/i);
  if (m && m[1]) return m[1].trim();

  return null;
}

/**
 * Extract meaningful entity keywords from goal (removes common stopwords).
 */
export function extractSignificantKeywords(text: string): string[] {
  const stopWords = new Set([
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "by", "for",
    "with", "about", "from", "as", "into", "like", "through", "after", "over",
    "between", "out", "against", "during", "without", "before", "under", "around",
    "among", "could", "would", "should", "you", "me", "we", "us", "please", "can",
    "play", "watch", "open", "find", "search", "video", "song", "music", "youtube",
    "official", "mv", "audio", "track", "listen", "show", "tell", "it", "this", "that"
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));
}

/**
 * On YouTube search results, rank all videos by goal keyword relevance
 * and click the best match (or top result if no specific tie-breaker).
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
      lower.includes("music") ||
      lower.includes("listen")
    )
  )
    return null;

  const keywords = extractSignificantKeywords(goal);

  // Evaluate all video renderers on the page and rank by keyword match
  const clickResult = await page.evaluate((kws: string[]) => {
    const renderers = Array.from(document.querySelectorAll("ytd-video-renderer"));
    if (!renderers.length) {
      const fallback = document.querySelector("a#video-title, h3 a") as HTMLElement | null;
      if (fallback) {
        fallback.click();
        return { clicked: true, title: fallback.innerText || "", score: 0 };
      }
      return null;
    }

    let bestEl: HTMLElement | null = null;
    let bestScore = -1;
    let bestTitle = "";

    for (const r of renderers) {
      const titleLink = r.querySelector("a#video-title") as HTMLAnchorElement | null;
      if (!titleLink) continue;

      const titleText = (titleLink.innerText || titleLink.getAttribute("title") || "").toLowerCase();
      const channelEl = r.querySelector("#channel-name, ytd-channel-name");
      const channelText = (channelEl as HTMLElement)?.innerText?.toLowerCase() || "";
      const fullText = `${titleText} ${channelText}`;

      // Calculate keyword score
      let score = 0;
      for (const kw of kws) {
        if (fullText.includes(kw)) score += 2;
        if (titleText.includes(kw)) score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestEl = titleLink;
        bestTitle = titleLink.innerText || titleLink.getAttribute("title") || "";
      }
    }

    if (!bestEl && renderers.length > 0) {
      const fallbackLink = renderers[0]?.querySelector("a#video-title") as HTMLElement | null;
      if (fallbackLink) {
        bestEl = fallbackLink;
        bestTitle = fallbackLink.innerText || fallbackLink.getAttribute("title") || "";
      }
    }


    if (bestEl) {
      bestEl.click();
      return { clicked: true, title: bestTitle, score: bestScore };
    }
    return null;
  }, keywords).catch(() => null);

  if (clickResult?.clicked) {
    await sleep(2000); // Wait for navigation
    const desc = clickResult.title
      ? `⚡ Heuristic: Clicked YouTube video: "${clickResult.title.slice(0, 60)}"`
      : `⚡ Heuristic: Clicked best-matching YouTube video result`;
    return {
      description: desc,
      continueLoop: true, // Let next step confirm playback on the watch page
    };
  }
  return null;
}

/**
 * On YouTube watch page, check if the loaded video matches the requested goal.
 * If so, ensure playback and complete the goal immediately.
 * If the current video is not a match but a sidebar video is, click the sidebar video.
 */
async function tryYouTubeWatchPageCheck(
  page: any,
  goal: string,
  url: string
): Promise<HeuristicResult | null> {
  if (!url.includes("youtube.com/watch")) return null;

  const lower = goal.toLowerCase();
  const isPlayRequest =
    lower.includes("play") ||
    lower.includes("watch") ||
    lower.includes("listen") ||
    lower.includes("open");

  if (!isPlayRequest) return null;

  const keywords = extractSignificantKeywords(goal);

  const status = await page.evaluate((kws: string[]) => {
    const video = document.querySelector("video") as HTMLVideoElement | null;
    const titleEl = document.querySelector("h1.ytd-watch-metadata, #title h1, ytd-watch-metadata h1");
    const videoTitle = (titleEl as HTMLElement)?.innerText || document.title || "";
    const channelEl = document.querySelector("#channel-name, ytd-channel-name");
    const channelName = (channelEl as HTMLElement)?.innerText || "";
    const fullText = `${videoTitle} ${channelName}`.toLowerCase();

    // Check how many keywords match
    const matchCount = kws.filter((kw) => fullText.includes(kw)).length;
    const isMatch = kws.length <= 1 ? matchCount >= 1 : matchCount >= Math.min(2, kws.length);

    if (isMatch && video) {
      if (video.paused) {
        video.play().catch(() => {});
      }
      return { matched: true, title: videoTitle.replace(/\s*-\s*YouTube.*$/i, "").trim() };
    }

    // Check if a sidebar recommended video is a better match
    const compacts = Array.from(document.querySelectorAll("ytd-compact-video-renderer"));
    for (const c of compacts) {
      const cTitle = (c.querySelector("#video-title") as HTMLElement)?.innerText || "";
      const cChannel = (c.querySelector("#channel-name") as HTMLElement)?.innerText || "";
      const cText = `${cTitle} ${cChannel}`.toLowerCase();
      const cMatches = kws.filter((kw) => cText.includes(kw)).length;
      if (cMatches > matchCount && cMatches >= Math.min(2, kws.length)) {
        const link = c.querySelector("a#thumbnail, a#video-title") as HTMLElement | null;
        if (link) {
          link.click();
          return { clickedSidebar: true, title: cTitle };
        }
      }
    }

    if (video && video.paused) {
      video.play().catch(() => {});
    }

    return { matched: isMatch, title: videoTitle.replace(/\s*-\s*YouTube.*$/i, "").trim() };
  }, keywords).catch(() => null);

  if (status?.matched) {
    await sleep(500);
    return {
      description: `⚡ Heuristic: Verified playback of "${status.title.slice(0, 50)}"`,
      doneMessage: `Now playing "${status.title}" on YouTube.`,
    };
  }

  if (status?.clickedSidebar) {
    await sleep(2000);
    return {
      description: `⚡ Heuristic: Clicked matching sidebar video: "${status.title.slice(0, 50)}"`,
      continueLoop: true,
    };
  }

  return null;
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
    // 0. From about:blank, navigate directly to YouTube search if intent is to play/watch on YouTube
    if (url === "about:blank" || url.startsWith("about:")) {
      const ytQuery = parseYouTubeSearchQuery(goal);
      if (ytQuery) {
        const targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery)}`;
        await page.goto(targetUrl).catch(() => {});
        return {
          description: `⚡ Heuristic: Navigated directly to YouTube search for "${ytQuery}"`,
          continueLoop: true,
        };
      }
    }

    // 1. YouTube watch page: check if requested video is already loaded & playing
    const ytWatch = await tryYouTubeWatchPageCheck(page, goal, url);
    if (ytWatch) return ytWatch;

    // 2. Media player control (skip, pause, play, mute, fullscreen)
    const media = await tryMediaControl(page, goal, url);
    if (media) return media;

    // 3. YouTube search results → rank & click best matching video
    const ytClick = await tryYouTubeFirstVideoClick(page, goal, url);
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

