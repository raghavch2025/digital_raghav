// ============================================================================
// garmin.js — Garmin Connect Health API integration (V1.2 scaffold)
// ============================================================================
// SCOPE: This file gets Madhav's watch data into the system. It does NOT
// fire any alerts or send messages — that's garminTriggers.js.
//
// SHIPPED DISABLED. Set GARMIN_ENABLED=true in env to turn it on. When off,
// every exported function is a safe no-op so the rest of the app boots
// untouched.
//
// API: Garmin offers two tiers:
//   1. "Wellness API" — daily summaries (sleep, stress, steps, body battery,
//      RHR, HRV). Requires applying at https://developer.garmin.com/
//      and signing an agreement. Free for personal use.
//   2. "Health API" — real-time webhooks. Paid, enterprise-tier. Not needed.
//
// We use tier 1. Once-daily poll at 06:00 IST pulls yesterday's data.
// ============================================================================

import { appendRow, readAll } from './sheets.js';
import { DateTime } from 'luxon';
import { TIMEZONE } from './config.js';

const GARMIN_ENABLED = process.env.GARMIN_ENABLED === 'true';
const TAB_RAW   = 'GarminRaw';     // append-only raw daily records
const TAB_FLAGS = 'GarminFlags';   // computed threshold breaches (for digest)

const RAW_HEADERS = [
  'date', 'fetched_at', 'stress_avg', 'stress_max', 'steps',
  'sleep_minutes', 'sleep_quality', 'rhr', 'hrv_overnight',
  'body_battery_low', 'body_battery_high', 'spo2_avg', 'spo2_min', 'raw_json',
];

// ----------------------------------------------------------------------------
// Public surface
// ----------------------------------------------------------------------------

export function isGarminEnabled() {
  return GARMIN_ENABLED;
}

/**
 * Called once on boot by index.js. Idempotent.
 */
export async function bootstrapGarmin() {
  if (!GARMIN_ENABLED) {
    console.log('[garmin] disabled (set GARMIN_ENABLED=true to enable)');
    return;
  }
  console.log('[garmin] bootstrap — checking tabs…');
  // sheets.bootstrap() will already have run; tabs are made on first append.
}

/**
 * Connection state. Used by /api/garmin/status so the UI can show
 * "Not linked" or "Connected · last sync 2h ago".
 */
export async function getStatus() {
  if (!GARMIN_ENABLED) {
    return { enabled: false, linked: false, message: 'Disabled in env' };
  }
  const hasTokens = !!(process.env.GARMIN_OAUTH_TOKEN && process.env.GARMIN_OAUTH_SECRET);
  if (!hasTokens) {
    return { enabled: true, linked: false, message: 'Not linked — run /api/garmin/connect' };
  }
  const rows = await readAll(TAB_RAW).catch(() => []);
  const last = rows[rows.length - 1];
  return {
    enabled: true, linked: true,
    lastFetched: last?.fetched_at || null,
    lastDate: last?.date || null,
    daysOfData: rows.length,
  };
}

/**
 * Daily poll job. Wired into scheduler.js to run at 06:00 IST.
 * Fetches yesterday's summary and writes one row to GarminRaw.
 */
export async function pollYesterday() {
  if (!GARMIN_ENABLED) return { skipped: true };
  if (!process.env.GARMIN_OAUTH_TOKEN) {
    console.log('[garmin] poll skipped — not linked');
    return { skipped: true, reason: 'not_linked' };
  }

  const date = DateTime.now().setZone(TIMEZONE).minus({ days: 1 }).toISODate();
  try {
    const summary = await fetchDailySummary(date);
    await appendRow(TAB_RAW, [
      summary.date,
      new Date().toISOString(),
      summary.stress_avg ?? '',
      summary.stress_max ?? '',
      summary.steps ?? '',
      summary.sleep_minutes ?? '',
      summary.sleep_quality ?? '',
      summary.rhr ?? '',
      summary.hrv_overnight ?? '',
      summary.body_battery_low ?? '',
      summary.body_battery_high ?? '',
      summary.spo2_avg ?? '',
      summary.spo2_min ?? '',
      JSON.stringify(summary.raw || {}),
    ]);
    console.log(`[garmin] pulled ${date}: stress=${summary.stress_avg}, sleep=${summary.sleep_minutes}m`);
    return { ok: true, date };
  } catch (err) {
    console.error('[garmin] poll failed:', err);
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------------------
// HTTP layer — Garmin OAuth 1.0a + REST
// ----------------------------------------------------------------------------
// NOTE: When you actually order the watch and apply for API access, you'll
// receive a CONSUMER_KEY, CONSUMER_SECRET. The full OAuth dance is documented
// at https://developer.garmin.com/gc-developer-program/wellness-api/
//
// The stub below shows the shape of what fetchDailySummary returns so the
// trigger evaluator can be tested with fake data today.
// ----------------------------------------------------------------------------

async function fetchDailySummary(date) {
  // Real implementation will look something like:
  //
  // const url = `https://apis.garmin.com/wellness-api/rest/dailies?uploadStartTimeInSeconds=...`;
  // const res = await fetch(url, { headers: oauthHeaders(url, 'GET') });
  // const data = await res.json();
  // return normalize(data);

  // For now, return a deterministic mock so tests don't break.
  if (process.env.GARMIN_USE_MOCK === 'true') {
    return mockSummary(date);
  }

  throw new Error('Garmin OAuth not configured — real fetch not yet implemented');
}

function mockSummary(date) {
  // Just enough variability to exercise the trigger logic.
  const seed = date.split('-').reduce((a, b) => a + parseInt(b, 10), 0);
  const rand = (n) => ((seed * 9301 + 49297 + n) % 233280) / 233280;
  return {
    date,
    stress_avg:       Math.round(30 + rand(1) * 40),     // 30–70
    stress_max:       Math.round(60 + rand(2) * 35),     // 60–95
    steps:            Math.round(1500 + rand(3) * 8000), // 1500–9500
    sleep_minutes:    Math.round(300 + rand(4) * 200),   // 5h–8h20
    sleep_quality:    Math.round(40 + rand(5) * 50),     // 40–90
    rhr:              Math.round(58 + rand(6) * 12),     // 58–70
    hrv_overnight:    Math.round(35 + rand(7) * 25),     // 35–60
    body_battery_low: Math.round(10 + rand(8) * 25),
    body_battery_high:Math.round(60 + rand(9) * 35),
    spo2_avg:         Math.round(94 + rand(10) * 4),
    spo2_min:         Math.round(88 + rand(11) * 6),
    raw: { source: 'mock' },
  };
}

export { TAB_RAW as GARMIN_RAW_TAB, TAB_FLAGS as GARMIN_FLAGS_TAB, RAW_HEADERS };
