/**
 * interstitial.ts — Universal Interstitial Recovery Protocol
 *
 * Automatically detects and dismantles unexpected blocking overlays, countdown
 * timers, pre-roll video ads, survey wizards, and modal traps across any website
 * without hardcoded domain-specific logic.
 */

import { sleep } from "./utils.js";

export interface BlockerStatus {
  isBlocked: boolean;
  blockerTag?: string;
  blockerText?: string;
  hasTimer?: boolean;
  timerSecondsRemaining?: number;
  isVideoAd?: boolean;
}

/**
 * 1. Viewport Occlusion & Pointer-Event Diagnostics
 * Probes the viewport center to determine if an overlay intercepts user interactions.
 */
export async function detectBlockingElement(page: any): Promise<BlockerStatus> {
  return await page.evaluate(() => {
    // Check for YouTube / HTML5 video ads first
    const isVideoAd = !!document.querySelector(
      ".ad-showing, .ad-interrupting, .ytp-ad-player-overlay, ytd-action-companion-ad-renderer, .video-ads"
    );

    // 1. Check what element sits at the center of the viewport
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const topEl = document.elementFromPoint(centerX, centerY);

    if (isVideoAd) {
      // Find skip countdown if present
      const adText = document.querySelector(".ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-skip-button-text")?.textContent || "";
      const timerMatch = adText.match(/(\d+)/);
      return {
        isBlocked: true,
        isVideoAd: true,
        blockerTag: "video-ad",
        blockerText: adText.slice(0, 200),
        hasTimer: !!timerMatch,
        timerSecondsRemaining: timerMatch && timerMatch[1] ? parseInt(timerMatch[1], 10) : 0,
      };
    }

    if (!topEl || topEl === document.body || topEl === document.documentElement) {
      return { isBlocked: false };
    }

    // 2. Check if top element belongs to an overlay container (fixed/absolute, high z-index, large area)
    let current: HTMLElement | null = topEl as HTMLElement;
    let overlayRoot: HTMLElement | null = null;

    while (current && current !== document.body) {
      const cStyle = window.getComputedStyle(current);
      const isFixedOrAbsolute = cStyle.position === "fixed" || cStyle.position === "absolute";
      const isHighZ = parseInt(cStyle.zIndex || "0", 10) > 30;
      const coversViewport =
        current.clientWidth > window.innerWidth * 0.35 &&
        current.clientHeight > window.innerHeight * 0.35;

      if ((isFixedOrAbsolute && isHighZ) || coversViewport || current.tagName.toLowerCase() === "dialog") {
        overlayRoot = current;
        break;
      }
      current = current.parentElement;
    }

    if (!overlayRoot) return { isBlocked: false };

    // 3. Inspect the blocker for active countdown timers (e.g. "Wait 5s", "Skip in 3...")
    const text = overlayRoot.innerText || "";
    const timerMatch =
      text.match(/(?:wait|skip in|close in|available in|resumes in)\s*(\d+)\s*(?:s|sec|seconds)?/i) ||
      text.match(/(\d+)\s*(?:s|sec)\s*(?:remaining|left)/i);

    const timerSeconds = timerMatch && timerMatch[1] ? parseInt(timerMatch[1], 10) : 0;

    return {
      isBlocked: true,
      blockerTag: overlayRoot.tagName.toLowerCase(),
      blockerText: text.slice(0, 300),
      hasTimer: timerSeconds > 0,
      timerSecondsRemaining: timerSeconds,
    };
  }).catch(() => ({ isBlocked: false }));
}

/**
 * 2. Time-Aware Waiting (Countdown & Dynamic Enablement)
 * Waits out countdown timers (e.g., "Skip in 5s", download delays) before interacting.
 */
export async function waitOutCountdown(page: any, maxWaitMs = 8000): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const status = await detectBlockingElement(page);

    if (!status.isBlocked) return true;

    // Check if an enabled dismiss/skip action has appeared
    const hasEnabledAction = await page.evaluate(() => {
      // 1. YouTube skip button
      const ytSkip = document.querySelector(
        ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button.ytp-ad-skip-button"
      ) as HTMLElement | null;
      if (ytSkip && ytSkip.offsetParent !== null) {
        ytSkip.click();
        return true;
      }

      // 2. Generic action buttons
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
      for (const el of candidates) {
        const text = (el.textContent || "").toLowerCase();
        const isActionWord = /skip|continue|close|proceed|dismiss|got it|next|start|no thanks/i.test(text);
        const isNotDisabled = !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";
        const isVisible = (el as HTMLElement).offsetParent !== null;
        if (isActionWord && isNotDisabled && isVisible) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (hasEnabledAction) {
      await sleep(1000);
      return true;
    }

    if (!status.hasTimer) break;
    await sleep(600);
  }

  return false;
}

/**
 * Tier 0 Media Ad Handler: Specifically bypasses or skips video ads
 */
export async function trySkipVideoAd(page: any): Promise<boolean> {
  return await page.evaluate(() => {
    // Check if on video ad
    const adShowing = !!document.querySelector(
      ".ad-showing, .ad-interrupting, .ytp-ad-player-overlay, .video-ads"
    );
    if (!adShowing) return false;

    // Try YouTube skip button
    const skipBtn = document.querySelector(
      ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button.ytp-ad-skip-button, .ytp-ad-overlay-close-button"
    ) as HTMLElement | null;

    if (skipBtn) {
      skipBtn.click();
      return true;
    }

    // Try player API skip or mute
    const player = document.getElementById("movie_player") as any;
    if (player?.skipAd) {
      try {
        player.skipAd();
        return true;
      } catch {}
    }

    // Fast-forward unskippable ad
    const adVideo = document.querySelector(".ad-showing video, video.html5-main-video") as HTMLVideoElement | null;
    if (adVideo && isFinite(adVideo.duration) && adVideo.duration > 0) {
      try {
        adVideo.currentTime = adVideo.duration;
        return true;
      } catch {}
    }

    return false;
  }).catch(() => false);
}

/**
 * Tier 2: Geometric Coordinate Hunting (Top-Right / Top-Left Targets)
 * Clicks the top-right corner zone of the topmost modal overlay.
 */
export async function clickModalCornerTarget(page: any): Promise<boolean> {
  return await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));
    let topModal: HTMLElement | null = null;
    let maxZ = 30;

    for (const el of all) {
      const z = parseInt(window.getComputedStyle(el).zIndex || "0", 10);
      if (z > maxZ && el.clientHeight > 150 && el.clientWidth > 150) {
        maxZ = z;
        topModal = el as HTMLElement;
      }
    }

    if (!topModal) return false;

    const rect = topModal.getBoundingClientRect();
    // Scan top-right corner zone (rightmost 40px, topmost 40px)
    const scanX = rect.right - 25;
    const scanY = rect.top + 25;

    const target = document.elementFromPoint(scanX, scanY) as HTMLElement | null;
    if (target && target !== document.body && target !== topModal) {
      target.click();
      return true;
    }

    // Check top-left corner zone
    const leftTarget = document.elementFromPoint(rect.left + 25, rect.top + 25) as HTMLElement | null;
    if (leftTarget && leftTarget !== document.body && leftTarget !== topModal) {
      leftTarget.click();
      return true;
    }

    return false;
  }).catch(() => false);
}

/**
 * Tier 3: Scan for standard escape/skip buttons in surveys and wizard modals
 */
export async function clickActionWordDismiss(page: any): Promise<boolean> {
  return await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], a, span[onclick], div[onclick]')
    );
    const keywords = [
      "skip",
      "dismiss",
      "later",
      "close",
      "not now",
      "no thanks",
      "prefer not to say",
      "continue to site",
      "accept",
      "got it",
    ];

    for (const el of candidates) {
      const text = (el.textContent || "").trim().toLowerCase();
      if (text.length > 0 && text.length < 35 && keywords.some((kw) => text === kw || text.startsWith(kw))) {
        const isNotDisabled = !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";
        const isVisible = (el as HTMLElement).offsetParent !== null;
        if (isNotDisabled && isVisible) {
          (el as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  }).catch(() => false);
}

/**
 * Tier 4: The Surgical Guillotine (DOM Neutralization)
 * Force-removes obstructive fixed/absolute high-z overlays and restores scrolling.
 */
export async function surgicallyRemoveBlocker(page: any): Promise<boolean> {
  return await page.evaluate(() => {
    let removed = false;

    // 1. Remove backdrop overlays, dialogs, and intrusive interstitial containers
    const blockers = document.querySelectorAll(
      'dialog, [class*="overlay" i], [class*="backdrop" i], [class*="modal" i], [role="dialog"], [aria-modal="true"], ytd-popup-container'
    );

    blockers.forEach((el) => {
      // Keep main app wrappers intact
      if (el.id === "content" || el.id === "app" || el.id === "root" || el.tagName.toLowerCase() === "ytd-app") return;
      const style = window.getComputedStyle(el);
      const isBlocking =
        (style.position === "fixed" || style.position === "absolute") &&
        parseInt(style.zIndex || "0", 10) > 30;

      if (isBlocking || el.tagName.toLowerCase() === "dialog") {
        el.remove();
        removed = true;
      }
    });

    // 2. Clear overflow locks that prevent scrolling once modal is removed
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";
    document.body.style.position = "static";

    return removed;
  }).catch(() => false);
}

/**
 * Main Autonomous Interstitial Recovery Middleware
 * Executes the 4-tier escalation ladder whenever an occlusion is detected.
 */
export async function handleInterstitials(page: any): Promise<{ handled: boolean; action?: string }> {
  try {
    const currentUrl = await page.url().catch(() => "");
    // YouTube watch page has its own dedicated, verified player heuristic (tryYouTubeWatchPageCheck).
    // Avoid running generic modal dismissal or Escape presses that can pause or dismiss the YouTube player.
    if (currentUrl.includes("youtube.com/watch")) {
      return { handled: false };
    }

    const status = await detectBlockingElement(page);
    if (!status.isBlocked) return { handled: false };

    // Case A: Pre-roll video ad
    if (status.isVideoAd) {
      if (status.hasTimer) {
        await waitOutCountdown(page, 7000);
      }
      const skipped = await trySkipVideoAd(page);
      if (skipped) {
        await sleep(1000);
        return { handled: true, action: "Skipped video pre-roll ad" };
      }
    }

    // Case B: General timer countdown
    if (status.hasTimer && (status.timerSecondsRemaining || 0) <= 6) {
      await waitOutCountdown(page, ((status.timerSecondsRemaining || 5) + 1) * 1000);
    }

    // Tier 1: Semantic Escape key broadcast
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(400);
    let check = await detectBlockingElement(page);
    if (!check.isBlocked) return { handled: true, action: "Dismissed modal with Escape key" };

    // Tier 2: Scan for Action Word ("Skip", "Close", "Dismiss", "No thanks")
    const actionClicked = await clickActionWordDismiss(page);
    if (actionClicked) {
      await sleep(500);
      check = await detectBlockingElement(page);
      if (!check.isBlocked) return { handled: true, action: "Clicked dismiss button" };
    }

    // Tier 3: Geometric Coordinate Hunting (Top-Right dismiss X)
    const cornerClicked = await clickModalCornerTarget(page);
    if (cornerClicked) {
      await sleep(500);
      check = await detectBlockingElement(page);
      if (!check.isBlocked) return { handled: true, action: "Clicked corner dismissal element" };
    }

    // Tier 4: Surgical Guillotine (Remove element & unlock scroll)
    const excised = await surgicallyRemoveBlocker(page);
    if (excised) {
      await sleep(300);
      return { handled: true, action: "Surgically excised blocking overlay" };
    }
  } catch {
    // Non-fatal
  }

  return { handled: false };
}
