/**
 * playbook.ts — Tier 1: Hermes Site Memory & Archetype Detection
 *
 * An auto-learning system that remembers API endpoints, selectors,
 * and navigation shortcuts for previously visited websites.
 *
 * Three-tier ontology:
 *  1. Fingerprint Layer    — Detects what kind of site this is before doing anything
 *  2. Instance Playbook    — Per-domain observations, verified endpoints, success rates
 *  3. Master Archetype     — Generalized templates (Lever ATS, Shopify, YouTube SPA)
 *                           that new sites inherit when matching fingerprints
 *
 * Storage: JSON file at <cwd>/data/playbooks.json with schema versioning.
 * Selector confidence decays on failure, self-heals on success.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/* ══════════════════════════════════════════════════════════════
   Data Types
   ══════════════════════════════════════════════════════════════ */

export type SiteCategory =
  | "video_streaming"
  | "ats_careers"
  | "e_commerce"
  | "docs_developer"
  | "search_portal"
  | "social_media"
  | "generic_spa"
  | "static_content"
  | "unknown";

export interface EndpointRecord {
  /** URL pattern or exact URL that was intercepted */
  urlPattern: string;
  /** Purpose tag for quick matching */
  purpose: string;
  /** Last known truncated payload sample (~200 chars) */
  sampleSnippet?: string | undefined;
  /** Successful uses count */
  successCount: number;
  /** Failed fetch attempts */
  failureCount: number;
  /** Last verified ISO timestamp */
  lastVerified: string;
}

export interface SelectorRecord {
  /** What this selector is for: "search_input", "job_list", "video_play", etc. */
  purpose: string;
  /** CSS selector or XPath */
  selector: string;
  /** 0.0 to 1.0 — decays on failure, grows on success */
  confidence: number;
  /** Last verified ISO timestamp */
  lastVerified: string;
}

export interface SitePlaybook {
  /** Schema version for future migrations */
  schemaVersion: number;
  /** Primary domain (e.g. "roboflow.com") */
  domain: string;
  /** Detected site category */
  category: SiteCategory;
  /** Pointer to master archetype ID if matched */
  archetypeId?: string;
  /** Tech stack hints detected (e.g. ["next.js", "lever_api", "algolia"]) */
  techHints: string[];

  /** Direct navigation URL shortcuts */
  shortcuts: {
    searchUrl?: string;
    careersUrl?: string;
    contactUrl?: string;
    pricingUrl?: string;
    docsUrl?: string;
  };

  /** Discovered API endpoints */
  endpoints: EndpointRecord[];
  /** Verified UI selectors */
  selectors: SelectorRecord[];

  /** Visit metadata */
  meta: {
    firstSeen: string;
    lastSeen: string;
    visitCount: number;
    /** Successful goal completions / total visits */
    successRate: number;
    successCount: number;
  };
}

/* ══════════════════════════════════════════════════════════════
   Master Archetype Templates (Built-In)

   These are generalized templates for common site architectures.
   When a new site matches ≥2 fingerprint signals from an archetype,
   it inherits the archetype's default endpoints and selectors.
   ══════════════════════════════════════════════════════════════ */

export interface MasterArchetype {
  id: string;
  name: string;
  category: SiteCategory;
  /** If ≥2 signals match, this archetype applies */
  fingerprints: {
    urlPatterns: string[];
    scriptSignatures: string[];
    domSignatures: string[];
    windowGlobals: string[];
  };
  /** Inherited default endpoints */
  defaultEndpoints: Array<{ urlPattern: string; purpose: string }>;
  /** Inherited default selectors */
  defaultSelectors: Array<{ purpose: string; selector: string }>;
}

const BUILT_IN_ARCHETYPES: MasterArchetype[] = [
  {
    id: "archetype_lever_ats",
    name: "Lever ATS Careers Board",
    category: "ats_careers",
    fingerprints: {
      urlPatterns: ["lever.co", "jobs.lever.co"],
      scriptSignatures: ["lever.co"],
      domSignatures: [".posting", ".postings-group", "[data-qa]"],
      windowGlobals: [],
    },
    defaultEndpoints: [
      {
        urlPattern: "api.lever.co/v0/postings/",
        purpose: "job_listings",
      },
    ],
    defaultSelectors: [
      { purpose: "job_list", selector: ".postings-group .posting" },
      { purpose: "job_title", selector: ".posting-title h5" },
      { purpose: "job_location", selector: ".posting-categories .sort-by-location" },
    ],
  },
  {
    id: "archetype_greenhouse_ats",
    name: "Greenhouse ATS Careers Board",
    category: "ats_careers",
    fingerprints: {
      urlPatterns: ["greenhouse.io", "boards.greenhouse.io"],
      scriptSignatures: ["grnh.se", "greenhouse.io"],
      domSignatures: ["#grnh_board", "div.opening", ".departments"],
      windowGlobals: [],
    },
    defaultEndpoints: [
      {
        urlPattern: "boards-api.greenhouse.io/v1/boards/",
        purpose: "job_listings",
      },
    ],
    defaultSelectors: [
      { purpose: "job_list", selector: ".opening" },
      { purpose: "job_title", selector: ".opening a" },
      { purpose: "job_location", selector: ".location" },
    ],
  },
  {
    id: "archetype_ashby_ats",
    name: "Ashby ATS Careers Board",
    category: "ats_careers",
    fingerprints: {
      urlPatterns: ["ashbyhq.com", "jobs.ashbyhq.com"],
      scriptSignatures: ["ashbyhq.com"],
      domSignatures: ["[data-ashby]", ".ashby-job-posting"],
      windowGlobals: [],
    },
    defaultEndpoints: [
      {
        urlPattern: "api.ashbyhq.com/posting-api/",
        purpose: "job_listings",
      },
    ],
    defaultSelectors: [],
  },
  {
    id: "archetype_youtube_spa",
    name: "YouTube SPA",
    category: "video_streaming",
    fingerprints: {
      urlPatterns: ["youtube.com", "youtu.be"],
      scriptSignatures: ["ytInitialData", "ytInitialPlayerResponse"],
      domSignatures: ["ytd-app", "ytd-video-renderer", "ytd-watch-metadata"],
      windowGlobals: ["ytInitialData", "ytInitialPlayerResponse"],
    },
    defaultEndpoints: [
      { urlPattern: "/youtubei/v1/", purpose: "media_metadata" },
    ],
    defaultSelectors: [
      { purpose: "search_input", selector: "input#search" },
      { purpose: "search_submit", selector: "button#search-icon-legacy" },
      { purpose: "first_video", selector: "ytd-video-renderer a#video-title" },
      { purpose: "video_player", selector: "video.html5-main-video" },
    ],
  },
  {
    id: "archetype_shopify_ecom",
    name: "Shopify E-Commerce Store",
    category: "e_commerce",
    fingerprints: {
      urlPatterns: ["myshopify.com"],
      scriptSignatures: ["Shopify.theme", "cdn.shopify.com"],
      domSignatures: ["[data-shopify]", ".shopify-section"],
      windowGlobals: ["Shopify"],
    },
    defaultEndpoints: [
      { urlPattern: "/products.json", purpose: "catalog_search" },
      { urlPattern: "/collections/", purpose: "catalog_search" },
    ],
    defaultSelectors: [
      { purpose: "product_list", selector: ".product-card, .product-item" },
      { purpose: "search_input", selector: 'input[name="q"], .search-input' },
    ],
  },
  {
    id: "archetype_nextjs_spa",
    name: "Next.js SPA",
    category: "generic_spa",
    fingerprints: {
      urlPatterns: [],
      scriptSignatures: ["_next/static", "__next"],
      domSignatures: ["#__next"],
      windowGlobals: ["__NEXT_DATA__"],
    },
    defaultEndpoints: [
      { urlPattern: "/_next/data/", purpose: "page_data" },
    ],
    defaultSelectors: [],
  },
];

/* ══════════════════════════════════════════════════════════════
   Playbook Store
   ══════════════════════════════════════════════════════════════ */

const CURRENT_SCHEMA_VERSION = 1;
const DATA_DIR = path.resolve(process.cwd(), "data");
const PLAYBOOK_PATH = path.join(DATA_DIR, "playbooks.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function migratePlaybook(raw: any): SitePlaybook {
  // Future migration logic goes here when schemaVersion increments
  if (!raw.schemaVersion || raw.schemaVersion < CURRENT_SCHEMA_VERSION) {
    raw.schemaVersion = CURRENT_SCHEMA_VERSION;
    if (!raw.techHints) raw.techHints = [];
    if (!raw.shortcuts) raw.shortcuts = {};
    if (!raw.endpoints) raw.endpoints = [];
    if (!raw.selectors) raw.selectors = [];
    if (!raw.meta) {
      raw.meta = {
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        visitCount: 0,
        successRate: 0,
        successCount: 0,
      };
    }
    if (!raw.category) raw.category = "unknown";
  }
  return raw as SitePlaybook;
}

class PlaybookStore {
  private store: Record<string, SitePlaybook> = {};
  private dirty = false;

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(PLAYBOOK_PATH)) return;
    try {
      const raw = JSON.parse(readFileSync(PLAYBOOK_PATH, "utf-8"));
      if (typeof raw === "object" && raw !== null) {
        for (const [domain, pb] of Object.entries(raw)) {
          this.store[domain] = migratePlaybook(pb);
        }
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  private save(): void {
    if (!this.dirty) return;
    try {
      ensureDataDir();
      writeFileSync(PLAYBOOK_PATH, JSON.stringify(this.store, null, 2), "utf-8");
      this.dirty = false;
    } catch (e: any) {
      console.warn(`⚠️ Failed to persist playbooks: ${e.message}`);
    }
  }

  /** Get playbook for a domain, or undefined if never seen. */
  get(domain: string): SitePlaybook | undefined {
    return this.store[normalizeDomain(domain)];
  }

  /** Get or create a playbook for a domain. */
  getOrCreate(domain: string): SitePlaybook {
    const d = normalizeDomain(domain);
    if (!this.store[d]) {
      this.store[d] = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        domain: d,
        category: "unknown",
        techHints: [],
        shortcuts: {},
        endpoints: [],
        selectors: [],
        meta: {
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          visitCount: 0,
          successRate: 0,
          successCount: 0,
        },
      };
      this.dirty = true;
    }
    return this.store[d]!;
  }

  /** Record a visit to a domain. */
  recordVisit(domain: string): void {
    const pb = this.getOrCreate(domain);
    pb.meta.visitCount++;
    pb.meta.lastSeen = new Date().toISOString();
    this.dirty = true;
    this.save();
  }

  /** Record a successful goal completion. */
  recordSuccess(domain: string): void {
    const pb = this.getOrCreate(domain);
    pb.meta.successCount++;
    pb.meta.successRate =
      pb.meta.visitCount > 0 ? pb.meta.successCount / pb.meta.visitCount : 1;
    this.dirty = true;
    this.save();
  }

  /** Record a discovered API endpoint. */
  recordEndpoint(domain: string, urlPattern: string, purpose: string, sample?: string): void {
    const pb = this.getOrCreate(domain);
    const existing = pb.endpoints.find((e) => e.urlPattern === urlPattern);
    if (existing) {
      existing.successCount++;
      existing.lastVerified = new Date().toISOString();
      if (sample) existing.sampleSnippet = sample.slice(0, 300);
    } else {
      pb.endpoints.push({
        urlPattern,
        purpose,
        sampleSnippet: sample?.slice(0, 300),
        successCount: 1,
        failureCount: 0,
        lastVerified: new Date().toISOString(),
      });
    }
    this.dirty = true;
    this.save();
  }

  /** Record a verified CSS selector. */
  recordSelector(domain: string, purpose: string, selector: string): void {
    const pb = this.getOrCreate(domain);
    const existing = pb.selectors.find(
      (s) => s.purpose === purpose && s.selector === selector
    );
    if (existing) {
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      existing.lastVerified = new Date().toISOString();
    } else {
      pb.selectors.push({
        purpose,
        selector,
        confidence: 0.6,
        lastVerified: new Date().toISOString(),
      });
    }
    this.dirty = true;
    this.save();
  }

  /** Decay a selector's confidence on failure. */
  decaySelector(domain: string, purpose: string, selector: string): void {
    const pb = this.get(domain);
    if (!pb) return;
    const s = pb.selectors.find(
      (sel) => sel.purpose === purpose && sel.selector === selector
    );
    if (s) {
      s.confidence = Math.max(0, s.confidence - 0.2);
      if (s.confidence < 0.3) {
        // Evict unreliable selectors
        pb.selectors = pb.selectors.filter(
          (sel) => !(sel.purpose === purpose && sel.selector === selector)
        );
      }
      this.dirty = true;
      this.save();
    }
  }

  /** Record a shortcut URL (search, careers, etc.). */
  recordShortcut(
    domain: string,
    key: keyof SitePlaybook["shortcuts"],
    url: string
  ): void {
    const pb = this.getOrCreate(domain);
    pb.shortcuts[key] = url;
    this.dirty = true;
    this.save();
  }

  /** Record technology hints detected on a domain. */
  recordTechHints(domain: string, hints: string[]): void {
    const pb = this.getOrCreate(domain);
    for (const h of hints) {
      if (!pb.techHints.includes(h)) pb.techHints.push(h);
    }
    this.dirty = true;
    this.save();
  }

  /** Set the category for a domain. */
  setCategory(domain: string, category: SiteCategory): void {
    const pb = this.getOrCreate(domain);
    pb.category = category;
    this.dirty = true;
    this.save();
  }

  /** Link a domain to a master archetype. */
  linkArchetype(domain: string, archetypeId: string): void {
    const pb = this.getOrCreate(domain);
    pb.archetypeId = archetypeId;
    this.dirty = true;
    this.save();
  }

  /** Get all stored playbooks (for diagnostics). */
  getAll(): Record<string, SitePlaybook> {
    return { ...this.store };
  }

  /** Get stats summary. */
  stats(): { totalSites: number; totalEndpoints: number; totalSelectors: number } {
    let totalEndpoints = 0;
    let totalSelectors = 0;
    for (const pb of Object.values(this.store)) {
      totalEndpoints += pb.endpoints.length;
      totalSelectors += pb.selectors.length;
    }
    return {
      totalSites: Object.keys(this.store).length,
      totalEndpoints,
      totalSelectors,
    };
  }
}

/* ══════════════════════════════════════════════════════════════
   Domain Helpers
   ══════════════════════════════════════════════════════════════ */

function normalizeDomain(domainOrUrl: string): string {
  try {
    const u = new URL(
      domainOrUrl.startsWith("http") ? domainOrUrl : `https://${domainOrUrl}`
    );
    return u.hostname.replace(/^www\./, "");
  } catch {
    return domainOrUrl.replace(/^www\./, "").split("/")[0] || domainOrUrl;
  }
}

/* ══════════════════════════════════════════════════════════════
   Archetype Detection (In-Browser Fingerprinting)

   Runs inside page.evaluate() to detect tech stack signals.
   Returns matched archetype IDs for the PlaybookStore to link.
   ══════════════════════════════════════════════════════════════ */

export async function detectArchetypes(page: any): Promise<{
  matchedArchetypeIds: string[];
  detectedHints: string[];
}> {
  try {
    const signals: {
      scriptSrcs: string[];
      domMatches: string[];
      windowGlobals: string[];
      pageUrl: string;
    } = await page.evaluate(() => {
      const scriptSrcs: string[] = [];
      const domMatches: string[] = [];
      const windowGlobals: string[] = [];

      // Collect script sources
      document.querySelectorAll("script[src]").forEach((s) => {
        const src = s.getAttribute("src") || "";
        if (src) scriptSrcs.push(src.slice(0, 200));
      });

      // Collect inline script content signatures
      document.querySelectorAll("script:not([src])").forEach((s) => {
        const text = s.textContent?.slice(0, 500) || "";
        if (text.includes("Shopify")) scriptSrcs.push("Shopify.theme");
        if (text.includes("grnh.se")) scriptSrcs.push("grnh.se");
        if (text.includes("lever.co")) scriptSrcs.push("lever.co");
        if (text.includes("ashbyhq")) scriptSrcs.push("ashbyhq.com");
      });

      // Check DOM signatures
      const domChecks = [
        "#__next", "ytd-app", "ytd-video-renderer", "#grnh_board",
        ".posting", ".postings-group", "[data-ashby]", "[data-shopify]",
        ".shopify-section", ".departments",
      ];
      for (const sel of domChecks) {
        if (document.querySelector(sel)) domMatches.push(sel);
      }

      // Check window globals
      const win = window as any;
      const globalChecks = [
        "__NEXT_DATA__", "ytInitialData", "ytInitialPlayerResponse",
        "Shopify", "__NUXT__",
      ];
      for (const g of globalChecks) {
        if (win[g] !== undefined) windowGlobals.push(g);
      }

      return {
        scriptSrcs,
        domMatches,
        windowGlobals,
        pageUrl: window.location.href,
      };
    });

    const matchedArchetypeIds: string[] = [];
    const detectedHints: string[] = [];

    for (const archetype of BUILT_IN_ARCHETYPES) {
      let matchCount = 0;

      // Check URL patterns
      for (const pat of archetype.fingerprints.urlPatterns) {
        if (signals.pageUrl.includes(pat)) {
          matchCount++;
          break;
        }
      }

      // Check script signatures
      for (const sig of archetype.fingerprints.scriptSignatures) {
        if (signals.scriptSrcs.some((src) => src.includes(sig))) {
          matchCount++;
          detectedHints.push(sig);
          break;
        }
      }

      // Check DOM signatures
      for (const domSig of archetype.fingerprints.domSignatures) {
        if (signals.domMatches.includes(domSig)) {
          matchCount++;
          break;
        }
      }

      // Check window globals
      for (const g of archetype.fingerprints.windowGlobals) {
        if (signals.windowGlobals.includes(g)) {
          matchCount++;
          detectedHints.push(`window.${g}`);
          break;
        }
      }

      if (matchCount >= 2) {
        matchedArchetypeIds.push(archetype.id);
      }
    }

    // Add generic tech hints
    if (signals.windowGlobals.includes("__NEXT_DATA__"))
      detectedHints.push("next.js");
    if (signals.windowGlobals.includes("__NUXT__")) detectedHints.push("nuxt");
    if (signals.scriptSrcs.some((s) => s.includes("_next/static")))
      detectedHints.push("next.js");
    if (signals.scriptSrcs.some((s) => s.includes("algolia")))
      detectedHints.push("algolia");
    if (signals.windowGlobals.includes("Shopify"))
      detectedHints.push("shopify");

    return {
      matchedArchetypeIds,
      detectedHints: [...new Set(detectedHints)],
    };
  } catch {
    return { matchedArchetypeIds: [], detectedHints: [] };
  }
}

/**
 * Get a master archetype by ID.
 */
export function getArchetype(id: string): MasterArchetype | undefined {
  return BUILT_IN_ARCHETYPES.find((a) => a.id === id);
}

/* ══════════════════════════════════════════════════════════════
   Playbook-Powered Direct API Fetch

   If we have a stored endpoint for a domain, try fetching it
   directly from the browser via page.evaluate(fetch(...)),
   completely bypassing DOM parsing and LLM evaluation.
   ══════════════════════════════════════════════════════════════ */

export async function tryDirectApiFetch(
  page: any,
  domain: string,
  purpose: string
): Promise<string | null> {
  const pb = playbooks.get(domain);
  if (!pb) return null;

  // Find matching endpoint
  let endpoint = pb.endpoints.find(
    (e) => e.purpose === purpose && e.successCount > 0
  );

  // If no direct match, check archetype
  if (!endpoint && pb.archetypeId) {
    const archetype = getArchetype(pb.archetypeId);
    if (archetype) {
      const defaultEp = archetype.defaultEndpoints.find(
        (e) => e.purpose === purpose
      );
      if (defaultEp) {
        endpoint = {
          urlPattern: defaultEp.urlPattern,
          purpose,
          successCount: 0,
          failureCount: 0,
          lastVerified: "",
        };
      }
    }
  }

  if (!endpoint) return null;

  try {
    const data = await page.evaluate(async (apiUrl: string) => {
      try {
        const resp = await fetch(apiUrl, {
          headers: { Accept: "application/json" },
        });
        if (!resp.ok) return null;
        const text = await resp.text();
        return text.slice(0, 10000);
      } catch {
        return null;
      }
    }, endpoint.urlPattern);

    if (data) {
      // Record success
      playbooks.recordEndpoint(domain, endpoint.urlPattern, purpose, data);
      return data;
    } else {
      // Record failure
      const pbRef = playbooks.get(domain);
      const ep = pbRef?.endpoints.find(
        (e) => e.urlPattern === endpoint!.urlPattern
      );
      if (ep) {
        ep.failureCount++;
      }
    }
  } catch {
    // Non-critical
  }

  return null;
}

/* ══════════════════════════════════════════════════════════════
   Auto-Learn After Navigation

   Called after the agent successfully navigates and completes
   actions on a page. Records discovered APIs and tech signals.
   ══════════════════════════════════════════════════════════════ */

export async function autoLearnFromPage(
  page: any,
  url: string,
  capturedApiUrls: string[]
): Promise<void> {
  try {
    const domain = normalizeDomain(url);
    playbooks.recordVisit(domain);

    // Record any API endpoints we intercepted
    for (const apiUrl of capturedApiUrls) {
      const purpose = classifyEndpointPurpose(apiUrl);
      playbooks.recordEndpoint(domain, apiUrl, purpose);
    }

    // Detect and link archetypes
    const { matchedArchetypeIds, detectedHints } = await detectArchetypes(page);
    if (detectedHints.length) {
      playbooks.recordTechHints(domain, detectedHints);
    }
    if (matchedArchetypeIds.length) {
      playbooks.linkArchetype(domain, matchedArchetypeIds[0]!);
      const arch = getArchetype(matchedArchetypeIds[0]!);
      if (arch) {
        playbooks.setCategory(domain, arch.category);
      }
    }

    // Auto-detect careers URL from the current page
    if (url.includes("/career") || url.includes("/jobs")) {
      playbooks.recordShortcut(domain, "careersUrl", url);
    }
  } catch {
    // Non-critical
  }
}

function classifyEndpointPurpose(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("job") || lower.includes("posting") || lower.includes("career"))
    return "job_listings";
  if (lower.includes("product") || lower.includes("catalog") || lower.includes("collection"))
    return "catalog_search";
  if (lower.includes("search") || lower.includes("query"))
    return "search_results";
  if (lower.includes("video") || lower.includes("player") || lower.includes("media"))
    return "media_metadata";
  return "page_data";
}

/* ══════════════════════════════════════════════════════════════
   Singleton Export
   ══════════════════════════════════════════════════════════════ */

export const playbooks = new PlaybookStore();
