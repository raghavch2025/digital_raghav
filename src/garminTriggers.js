// ============================================================================
// garminTriggers.js — evaluate Garmin data against configurable thresholds
// ============================================================================
// Runs once a day after the Garmin poll. Reads the last N days of GarminRaw,
// checks each enabled trigger, and writes flags to GarminFlags.
//
// Flags surface in: (a) the weekly digest to Raghav, (b) the dashboard
// "Discuss with Dr. Anand" card, (c) the doctor brief.
//
// EXPLICITLY DOES NOT: send WhatsApp messages, change medications, raise
// alarm-tone alerts. Garmin data is descriptive, not diagnostic.
// ============================================================================

import { DateTime } from 'luxon';
import { readAll, appendRow } from './sheets.js';
import { GARMIN_RAW_TAB, GARMIN_FLAGS_TAB, isGarminEnabled } from './garmin.js';
import { getThresholds } from './configStore.js';
import { TIMEZONE } from './config.js';

const FLAG_HEADERS = ['date_detected', 'trigger', 'detail', 'window_days', 'acknowledged'];

// Built-in trigger definitions. Each maps a configurable threshold key to
// a function that evaluates the last N days of data.
const TRIGGER_DEFS = {
  stress_high_streak: {
    key:       'garmin.stress.avgHigh',
    daysKey:   'garmin.stress.streakDays',
    defaults:  { value: 60, days: 3 },
    label:     'Sustained high stress',
    evaluate: (rows, threshold, days) => {
      const recent = rows.slice(-days);
      if (recent.length < days) return null;
      const allHigh = recent.every(r => num(r.stress_avg) >= threshold);
      if (!allHigh) return null;
      const avg = recent.reduce((a, r) => a + num(r.stress_avg), 0) / recent.length;
      return `Avg stress ${avg.toFixed(0)} ≥ ${threshold} for ${days} consecutive days`;
    },
  },
  steps_low_streak: {
    key:       'garmin.steps.dailyLow',
    daysKey:   'garmin.steps.streakDays',
    defaults:  { value: 2000, days: 3 },
    label:     'Low activity',
    evaluate: (rows, threshold, days) => {
      const recent = rows.slice(-days);
      if (recent.length < days) return null;
      const allLow = recent.every(r => num(r.steps) <= threshold);
      if (!allLow) return null;
      const avg = recent.reduce((a, r) => a + num(r.steps), 0) / recent.length;
      return `Daily steps avg ${avg.toFixed(0)} ≤ ${threshold} for ${days} days`;
    },
  },
  short_sleep_streak: {
    key:       'garmin.sleep.minMinutes',
    daysKey:   'garmin.sleep.streakDays',
    defaults:  { value: 360, days: 2 },  // 6 hours
    label:     'Short sleep',
    evaluate: (rows, threshold, days) => {
      const recent = rows.slice(-days);
      if (recent.length < days) return null;
      const allShort = recent.every(r => num(r.sleep_minutes) > 0 && num(r.sleep_minutes) < threshold);
      if (!allShort) return null;
      const avg = recent.reduce((a, r) => a + num(r.sleep_minutes), 0) / recent.length;
      return `Sleep < ${(threshold/60).toFixed(1)}h on ${days} consecutive nights (avg ${(avg/60).toFixed(1)}h)`;
    },
  },
  rhr_deviation: {
    key:       'garmin.rhr.deviationBpm',
    daysKey:   'garmin.rhr.baselineDays',
    defaults:  { value: 10, days: 14 },
    label:     'Resting HR elevated',
    evaluate: (rows, threshold, days) => {
      if (rows.length < days + 2) return null;
      const baseline = rows.slice(-(days + 2), -2);  // skip last 2 days
      const recent   = rows.slice(-2);
      const baseAvg = avg(baseline.map(r => num(r.rhr)).filter(Boolean));
      const recentAvg = avg(recent.map(r => num(r.rhr)).filter(Boolean));
      if (!isFinite(baseAvg) || !isFinite(recentAvg)) return null;
      const delta = recentAvg - baseAvg;
      if (delta < threshold) return null;
      return `RHR up ${delta.toFixed(1)} bpm above ${days}d baseline (${baseAvg.toFixed(0)}→${recentAvg.toFixed(0)})`;
    },
  },
  spo2_low: {
    key:       'garmin.spo2.minPct',
    daysKey:   null,
    defaults:  { value: 90, days: 1 },
    label:     'Low overnight SpO₂',
    evaluate: (rows, threshold) => {
      const last = rows[rows.length - 1];
      if (!last) return null;
      const min = num(last.spo2_min);
      if (!min || min >= threshold) return null;
      return `Overnight SpO₂ dipped to ${min}% (threshold ${threshold}%)`;
    },
  },
};

/**
 * Called by scheduler.js right after garmin.pollYesterday().
 */
export async function evaluateTriggers() {
  if (!isGarminEnabled()) return { skipped: true };

  const [rows, thresholds] = await Promise.all([
    readAll(GARMIN_RAW_TAB).catch(() => []),
    getThresholds(),
  ]);
  if (rows.length === 0) return { skipped: true, reason: 'no_data' };

  const today = DateTime.now().setZone(TIMEZONE).toISODate();
  const garminCfg = thresholds.garmin || {};
  const fired = [];

  for (const [triggerId, def] of Object.entries(TRIGGER_DEFS)) {
    const enabled = getByPath(garminCfg, def.key.replace(/^garmin\./, '') + '.enabled');
    if (enabled !== true) continue;   // every trigger off by default

    const threshold = getByPath(garminCfg, def.key.replace(/^garmin\./, '')) ?? def.defaults.value;
    const days      = def.daysKey
      ? getByPath(garminCfg, def.daysKey.replace(/^garmin\./, '')) ?? def.defaults.days
      : def.defaults.days;

    const detail = def.evaluate(rows, threshold, days);
    if (detail) {
      fired.push({ id: triggerId, label: def.label, detail, days });
      await appendRow(GARMIN_FLAGS_TAB, [today, triggerId, detail, days, 'false']);
    }
  }

  console.log(`[garminTriggers] ${fired.length} flag(s) raised`);
  return { fired };
}

/**
 * Read recent flags for dashboard/digest.
 */
export async function recentFlags(days = 14) {
  if (!isGarminEnabled()) return [];
  const rows = await readAll(GARMIN_FLAGS_TAB).catch(() => []);
  const cutoff = DateTime.now().setZone(TIMEZONE).minus({ days }).toISODate();
  return rows
    .filter(r => r.date_detected >= cutoff)
    .map(r => ({
      date: r.date_detected,
      trigger: r.trigger,
      detail: r.detail,
      acknowledged: r.acknowledged === 'true',
    }))
    .reverse();
}

// ----------------------------------------------------------------------------
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function avg(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export { TRIGGER_DEFS, FLAG_HEADERS };
