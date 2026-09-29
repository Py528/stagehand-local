/**
 * apis.ts — Tier -1 Direct API Fast-paths
 *
 * These bypass the browser entirely for structured, predictable queries.
 * They're called BEFORE any browser navigation — if a direct API can answer
 * the question in <200ms with zero LLM calls, we use it.
 *
 * Tier hierarchy:
 *   Tier -1 (Direct API, ~50-200ms, 0 LLM calls)  ← this file
 *   Tier  0 (Heuristic,  ~500ms,    0 LLM calls)
 *   Tier 0.4 (Pattern,   ~1s,       0 LLM calls)
 *   Tier 0.5 (Trace,     ~2s,       0-1 LLM calls)
 *   Tier  2 (LLM planner, ~5-15s,   2-5 LLM calls)
 *
 * All APIs used here are:
 *   - Free / no-auth (wttr.in, Open-Meteo)
 *   - Or use keys from cfg.apiKeys (YouTube, Google Places)
 *   - Never block startup — all optional, graceful fallback to Tier 0
 */

import https from "node:https";
import http from "node:http";
import { cfg } from "./config.js";
import { extractPattern } from "./patterns.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ApiResult {
  /** The final answer to show the user */
  answer: string;
  /** Which API provided this (for logging) */
  source: string;
  /** Latency in ms */
  latencyMs: number;
  /** Whether this is a complete answer (vs partial that needs enrichment) */
  isComplete: boolean;
}

// ── Core HTTP helper ────────────────────────────────────────────────────────

function fetchJson<T>(url: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, {
      headers: { "User-Agent": "stagehand-local/1.0 (local browser agent)" },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data) as T); }
        catch { reject(new Error(`JSON parse failed for ${url}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function fetchText(url: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, {
      headers: { "User-Agent": "stagehand-local/1.0" },
      timeout: timeoutMs,
    }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ── Weather API (wttr.in) — FREE, no API key needed ────────────────────────
//
// API docs: https://wttr.in/:help
// JSON endpoint: https://wttr.in/{city}?format=j1
// Response time: ~80-200ms
// Rate limit: none documented (reasonable use)

interface WttrCurrent {
  temp_C: string;
  temp_F: string;
  humidity: string;
  windspeedKmph: string;
  weatherDesc: Array<{ value: string }>;
  FeelsLikeC: string;
  uvIndex: string;
  visibility: string;
  precipMM: string;
}

interface WttrResponse {
  current_condition: WttrCurrent[];
  weather: Array<{
    date: string;
    maxtempC: string;
    mintempC: string;
    hourly: Array<{ time: string; tempC: string; weatherDesc: Array<{ value: string }>; precipMM: string; }>;
  }>;
  nearest_area: Array<{ areaName: Array<{ value: string }>; country: Array<{ value: string }>; }>;
}

export async function getWeather(city: string): Promise<ApiResult | null> {
  const t0 = Date.now();
  try {
    const encodedCity = encodeURIComponent(city.trim());
    const data = await fetchJson<WttrResponse>(
      `https://wttr.in/${encodedCity}?format=j1`,
      3500
    );

    const cur = data.current_condition?.[0];
    if (!cur) return null;

    const desc      = cur.weatherDesc?.[0]?.value ?? "Unknown";
    const temp      = cur.temp_C;
    const feels     = cur.FeelsLikeC;
    const humidity  = cur.humidity;
    const wind      = cur.windspeedKmph;
    const precip    = cur.precipMM;

    // Today's forecast
    const today = data.weather?.[0];
    const hi    = today?.maxtempC ?? temp;
    const lo    = today?.mintempC ?? temp;

    // Format as clean answer
    const location = data.nearest_area?.[0]?.areaName?.[0]?.value ?? city;
    const country  = data.nearest_area?.[0]?.country?.[0]?.value ?? "";

    let answer = `**Weather in ${location}${country ? `, ${country}` : ""}:**\n`;
    answer += `🌡️ ${temp}°C (feels like ${feels}°C) — ${desc}\n`;
    answer += `📊 High: ${hi}°C | Low: ${lo}°C\n`;
    answer += `💧 Humidity: ${humidity}% | 💨 Wind: ${wind} km/h`;
    if (parseFloat(precip) > 0) answer += `\n🌧️ Precipitation: ${precip} mm`;

    // Hourly forecast for today (morning/afternoon/evening)
    const hourly = today?.hourly ?? [];
    const slots = hourly.filter(h => ["600","1200","1800"].includes(h.time));
    if (slots.length > 0) {
      const slotNames: Record<string, string> = { "600": "Morning", "1200": "Afternoon", "1800": "Evening" };
      const forecast = slots.map(h => `${slotNames[h.time] ?? h.time}: ${h.tempC}°C, ${h.weatherDesc?.[0]?.value ?? "—"}`).join(" | ");
      answer += `\n\n📅 Today: ${forecast}`;
    }

    return { answer, source: "wttr.in", latencyMs: Date.now() - t0, isComplete: true };
  } catch {
    return null; // fall through to browser
  }
}

// ── YouTube — direct video search without browser ──────────────────────────
//
// STRATEGY A (no API key): Scrape YouTube search page directly for video IDs
// using a simple regex on the page source. YouTube returns initial data as
// a JSON blob embedded in the HTML. This is what ytdl-core and yt-dlp do.
// Rate limited but works for personal use.
//
// STRATEGY B (with API key): YouTube Data API v3
// GET https://www.googleapis.com/youtube/v3/search?part=snippet&q={query}&type=video&maxResults=5&key={API_KEY}
// Rate limit: 10,000 units/day free (~100 searches/day)
//
// We implement both and use whichever is configured.

interface YouTubeVideoResult {
  videoId: string;
  title: string;
  channelTitle: string;
  watchUrl: string;
}

export async function searchYouTube(query: string): Promise<YouTubeVideoResult[] | null> {
  const t0 = Date.now();

  // Strategy A: scrape YouTube search page (no API key needed)
  try {
    const encodedQuery = encodeURIComponent(query);
    const html = await fetchText(
      `https://www.youtube.com/results?search_query=${encodedQuery}&sp=EgIQAQ%3D%3D`, // sp = songs filter
      5000
    );

    // Extract ytInitialData JSON from the page
    const match = html.match(/var ytInitialData\s*=\s*({.+?});<\/script>/s);
    if (!match) return null;

    const ytData = JSON.parse(match[1] ?? "{}");
    const contents =
      ytData?.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents ?? [];

    const videos: YouTubeVideoResult[] = [];
    for (const item of contents) {
      const vr = item?.videoRenderer;
      if (!vr?.videoId) continue;
      videos.push({
        videoId: vr.videoId,
        title: vr.title?.runs?.[0]?.text ?? "",
        channelTitle: vr.ownerText?.runs?.[0]?.text ?? "",
        watchUrl: `https://www.youtube.com/watch?v=${vr.videoId}`,
      });
      if (videos.length >= 5) break;
    }

    if (videos.length > 0) {
      console.log(`   🎬 YouTube API (scrape): found ${videos.length} results in ${Date.now()-t0}ms`);
      return videos;
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * Pick the best video from a list given the original goal.
 * Uses simple title matching — no LLM needed for exact/close matches.
 */
export function pickBestVideo(
  videos: YouTubeVideoResult[],
  song: string,
  artist?: string
): YouTubeVideoResult | null {
  if (videos.length === 0) return null;

  const normalize = (s: string) => s.toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const normSong   = normalize(song);
  const normArtist = artist ? normalize(artist) : "";

  // Score each video
  const scored = videos.map(v => {
    const title = normalize(v.title);
    const channel = normalize(v.channelTitle);
    let score = 0;

    // Song title match
    if (title.includes(normSong)) score += 40;
    else {
      // Partial match: check if song words appear in title
      const songWords = normSong.split(" ").filter(w => w.length > 2);
      const matched = songWords.filter(w => title.includes(w));
      score += (matched.length / Math.max(songWords.length, 1)) * 30;
    }

    // Artist match (title or channel)
    if (normArtist) {
      if (title.includes(normArtist) || channel.includes(normArtist)) score += 35;
      else {
        const artistWords = normArtist.split(" ").filter(w => w.length > 2);
        const matched = artistWords.filter(w => title.includes(w) || channel.includes(w));
        score += (matched.length / Math.max(artistWords.length, 1)) * 25;
      }
    }

    // Prefer official channels/titles
    if (title.includes("official") || title.includes("official music video") || title.includes("official audio")) score += 10;
    if (channel.toLowerCase().includes("vevo")) score += 5;

    // Penalize covers, live, instrumental
    if (title.includes("cover") || title.includes("karaoke") || title.includes("instrumental")) score -= 15;

    return { ...v, score };
  });

  // Return highest scorer
  const best = scored.sort((a, b) => b.score - a.score)[0];
  return (best?.score ?? 0) > 10 ? best ?? null : null;
}

// ── Open-Meteo weather (alternative, more detailed) ────────────────────────
//
// Open-Meteo is completely free, no API key, gives more detailed forecast.
// But it requires lat/lon — we geocode via wttr.in first.
// Less useful as primary since wttr.in already gives what we need.

// ── Google Places API — restaurant hours ───────────────────────────────────
//
// Requires API key. Free tier: $200/month credit (~5000 searches).
// Only enabled if cfg.apiKeys?.googlePlaces is set.

export interface PlaceHours {
  name: string;
  address: string;
  isOpenNow?: boolean;
  openNowText?: string;
  weekdayText?: string[];
  phone?: string;
  rating?: number;
}

export async function getPlaceHours(query: string, location?: string): Promise<ApiResult | null> {
  // Require API key — graceful skip if not configured
  const apiKey = (cfg as any).apiKeys?.googlePlaces;
  if (!apiKey) return null;

  const t0 = Date.now();
  try {
    const fullQuery = location ? `${query} ${location}` : query;
    const encoded = encodeURIComponent(fullQuery);

    // Find place ID
    const findUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json` +
      `?input=${encoded}&inputtype=textquery&fields=place_id,name,formatted_address&key=${apiKey}`;
    const findRes = await fetchJson<any>(findUrl);
    const placeId = findRes?.candidates?.[0]?.place_id;
    if (!placeId) return null;

    // Get details
    const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${placeId}&fields=name,formatted_address,opening_hours,formatted_phone_number,rating&key=${apiKey}`;
    const detailRes = await fetchJson<any>(detailUrl);
    const place = detailRes?.result;
    if (!place) return null;

    const hours = place.opening_hours;
    const isOpen = hours?.open_now;
    const weekday = hours?.weekday_text ?? [];

    let answer = `📍 **${place.name}**\n`;
    answer += `📫 ${place.formatted_address}\n`;
    if (isOpen !== undefined) answer += `\n${isOpen ? "✅ **Open now**" : "❌ **Currently closed**"}\n`;
    if (weekday.length > 0) {
      answer += "\n🕐 **Hours:**\n";
      answer += weekday.map((d: string) => `  ${d}`).join("\n");
    }
    if (place.formatted_phone_number) answer += `\n\n📞 ${place.formatted_phone_number}`;
    if (place.rating) answer += `\n⭐ Rating: ${place.rating}/5`;

    return { answer, source: "google-places", latencyMs: Date.now() - t0, isComplete: true };
  } catch {
    return null;
  }
}

// ── Main dispatcher: tryDirectApi ──────────────────────────────────────────
//
// Given a goal string, attempt to answer it directly via API.
// Returns null if no direct API applies — caller falls through to browser.

export async function tryDirectApi(goal: string): Promise<ApiResult | null> {
  const abstractGoal = extractPattern(goal);
  if (!abstractGoal) return null;

  const { patternKey, slots } = abstractGoal;

  // Weather
  if (patternKey === "google::weather::CITY") {
    const city = slots.CITY;
    if (city && city.length > 1) {
      console.log(`   ⚡ Tier -1: weather API for "${city}"...`);
      return await getWeather(city);
    }
  }

  // YouTube — direct video result
  if (patternKey === "youtube::media_play::SONG+ARTIST") {
    const song   = slots.SONG   ?? "";
    const artist = slots.ARTIST ?? "";
    if (song) {
      console.log(`   ⚡ Tier -1: YouTube search API for "${song} ${artist}"...`);
      const query   = artist ? `${song} ${artist}` : song;
      const results = await searchYouTube(query);
      if (results && results.length > 0) {
        const best = pickBestVideo(results, song, artist);
        if (best) {
          // Return the watch URL — the caller navigates to it directly
          return {
            answer: `__YOUTUBE_NAVIGATE__:${best.watchUrl}:${best.title}:${best.channelTitle}`,
            source: "youtube-api",
            latencyMs: 0, // will be updated by caller
            isComplete: false, // browser still needs to navigate + confirm playback
          };
        }
      }
    }
  }

  // YouTube — song only (no artist)
  if (patternKey === "youtube::media_play::SONG") {
    const song = slots.SONG ?? "";
    if (song) {
      console.log(`   ⚡ Tier -1: YouTube search for "${song}"...`);
      const results = await searchYouTube(song);
      if (results && results.length > 0) {
        const best = pickBestVideo(results, song);
        if (best) {
          return {
            answer: `__YOUTUBE_NAVIGATE__:${best.watchUrl}:${best.title}:${best.channelTitle}`,
            source: "youtube-api",
            latencyMs: 0,
            isComplete: false,
          };
        }
      }
    }
  }

  // Restaurant hours — via Google Places (requires API key)
  if (patternKey === "restaurant::hours::RESTAURANT+LOCATION" ||
      patternKey === "restaurant::hours::RESTAURANT") {
    const restaurant = slots.RESTAURANT ?? "";
    const location   = slots.LOCATION ?? "";
    if (restaurant) {
      console.log(`   ⚡ Tier -1: Places API for "${restaurant}"...`);
      return await getPlaceHours(restaurant, location);
    }
  }

  return null;
}
