import type { Stagehand } from "@browserbasehq/stagehand";
import { cfg } from "./config.js";
import { sleep } from "./utils.js";
import { setupApiInterceptor, clearCapturedApi } from "./distill.js";

const CONSENT_SDK_PATTERN = /.*(onetrust|cookiebot|usercentrics|klaro|termly).*\.js.*/i;

/**
 * Block common third-party cookie & consent SDKs at network level.
 * Prevents banners from mounting into the DOM or polluting accessibility trees.
 */
export async function setupRouteBlocking(target: any): Promise<void> {
  if (!target) return;
  try {
    const ctx = typeof target.context === "function" ? target.context() : target;
    if (ctx && typeof ctx.route === "function" && !(ctx as any)._consentBlockingAttached) {
      (ctx as any)._consentBlockingAttached = true;
      await ctx.route(CONSENT_SDK_PATTERN, (route: any) => route.abort()).catch(() => {});
    } else if (typeof target.route === "function" && !(target as any)._consentBlockingAttached) {
      (target as any)._consentBlockingAttached = true;
      await target.route(CONSENT_SDK_PATTERN, (route: any) => route.abort()).catch(() => {});
    }
  } catch {}
}

export async function activePage(sh: Stagehand, fallback: any): Promise<any> {
  try {
    let ctx: any = null;
    try { ctx = sh.browser?.context; } catch {}
    if (ctx) {
      await setupRouteBlocking(ctx);
    }
    const a = await ctx?.activePage?.().catch(() => null);
    if (a) {
      setupApiInterceptor(a);
      await setupRouteBlocking(a);
      return a;
    }
    const ps = await ctx?.pages?.().catch(() => null);
    if (ps?.length) {
      const p = ps[ps.length - 1];
      setupApiInterceptor(p);
      await setupRouteBlocking(p);
      return p;
    }
  } catch {}
  setupApiInterceptor(fallback);
  await setupRouteBlocking(fallback);
  return fallback;
}


/** Navigate and settle (with domcontentloaded, networkidle, and iframe settle). */
export async function navigate(page: any, url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  clearCapturedApi();
  await setupRouteBlocking(page);
  setupApiInterceptor(page);
  await page.goto(url);

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  // Try networkidle with short timeout — catches SPAs that load data async
  await page.waitForLoadState("networkidle").catch(() => {});
  // Extra settle for iframe-heavy pages
  try {
    const frameCount = await page.evaluate(() => document.querySelectorAll("iframe").length).catch(() => 0);
    const settleMs = frameCount > 3 ? cfg.agent.domSettleMs * 2 : cfg.agent.domSettleMs;
    await sleep(settleMs);
  } catch {
    await sleep(cfg.agent.domSettleMs);
  }
}

/** Try to dismiss cookie/consent overlays — DOM-based, zero LLM calls. */
export async function dismissCookies(sh: Stagehand, page: any): Promise<void> {
  if (!cfg.cookieDismiss.length) return;
  try {
    const labels = cfg.cookieDismiss;
    const dismissed = await page.evaluate((btnLabels: string[]) => {
      const lower = btnLabels.map((l: string) => l.toLowerCase());
      const buttons = document.querySelectorAll(
        'button, a[role="button"], [class*="cookie"] button, [class*="consent"] button, [id*="cookie"] button'
      );
      for (const btn of buttons) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (text && lower.some((l: string) => text.includes(l))) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, labels).catch(() => false);
    if (dismissed) console.log(`   🍪 Cookie banner dismissed.`);
  } catch {}
}

export async function captureScreenshotBase64(page: any): Promise<string> {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 75 });
    return buf.toString("base64");
  } catch {
    return "";
  }
}
