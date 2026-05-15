// ============================================================================
// configStore.js — Sheets-backed dynamic config (V1.2)
// ============================================================================
// Replaces hardcoded MEDICATION_SLOTS and ALERTS in config.js with values
// read from Google Sheets at runtime. config.js still ships the DEFAULTS
// used on first boot to seed the sheet tabs.
//
// Two new tabs:
//   - MedSchedule  — rows = (slot_id, time, frequency, dayOfWeek, label,
//                            meds_json, enabled, updated_at)
//   - Thresholds   — rows = (key, value, updated_at) — flat key/value, lets
//                    us add new alert types without schema migration
//
// Read path:
//   getMedicationSlots() / getThresholds() — async, 60-second in-memory TTL.
//
// Write path:
//   setMedicationSlots() / setThreshold() — write to Sheet + bust cache +
//   append an AuditLog row.
// ============================================================================

import { readAll, replaceTab, appendRow } from './sheets.js';
import { SHEETS, MEDICATION_SLOTS as DEFAULT_SLOTS, ALERTS as DEFAULT_ALERTS } from './config.js';
import { recordChange } from './auditLog.js';

const CACHE_TTL_MS = 60 * 1000;
const cache = { slots: null, slotsAt: 0, thresholds: null, thresholdsAt: 0 };

// New sheet-tab names — add these to SHEETS in config.js if you prefer,
// or keep them here so the V1.2 layer is self-contained.
const TABS = {
  schedule:   'MedSchedule',
  thresholds: 'Thresholds',
};

const SCHEDULE_HEADERS  = ['slot_id', 'time', 'frequency', 'dayOfWeek', 'label', 'meds_json', 'enabled', 'updated_at'];
const THRESHOLD_HEADERS = ['key', 'value', 'updated_at'];

// ----------------------------------------------------------------------------
// Bootstrap — called once on app boot. If the tabs are empty, seed them.
// ----------------------------------------------------------------------------
export async function bootstrapConfigStore() {
  const [scheduleRows, thresholdRows] = await Promise.all([
    readAll(TABS.schedule).catch(() => []),
    readAll(TABS.thresholds).catch(() => []),
  ]);

  if (scheduleRows.length === 0) {
    console.log('[configStore] seeding MedSchedule from defaults');
    await replaceTab(TABS.schedule, SCHEDULE_HEADERS,
      DEFAULT_SLOTS.map(slotToRow));
  }

  if (thresholdRows.length === 0) {
    console.log('[configStore] seeding Thresholds from defaults');
    await replaceTab(TABS.thresholds, THRESHOLD_HEADERS,
      flattenThresholds(DEFAULT_ALERTS).map(({ key, value }) => [
        key, String(value), new Date().toISOString(),
      ]));
  }
}

// ----------------------------------------------------------------------------
// MEDICATION SLOTS
// ----------------------------------------------------------------------------
export async function getMedicationSlots() {
  if (cache.slots && Date.now() - cache.slotsAt < CACHE_TTL_MS) return cache.slots;

  const rows = await readAll(TABS.schedule);
  const slots = rows
    .map(rowToSlot)
    .filter(s => s && s.enabled !== false);

  cache.slots = slots.length > 0 ? slots : DEFAULT_SLOTS;  // safety fallback
  cache.slotsAt = Date.now();
  return cache.slots;
}

/**
 * Replace the entire schedule. Use this from the admin endpoint.
 * Validation should already have happened upstream.
 */
export async function setMedicationSlots(newSlots, actor = 'system') {
  const before = await getMedicationSlots();
  const rows = newSlots.map(slotToRow);
  await replaceTab(TABS.schedule, SCHEDULE_HEADERS, rows);
  cache.slots = null;  // bust
  await recordChange({
    actor,
    area: 'med_schedule',
    summary: `Schedule updated — ${newSlots.length} slots`,
    before, after: newSlots,
  });
}

// ----------------------------------------------------------------------------
// THRESHOLDS
// ----------------------------------------------------------------------------
export async function getThresholds() {
  if (cache.thresholds && Date.now() - cache.thresholdsAt < CACHE_TTL_MS) {
    return cache.thresholds;
  }

  const rows = await readAll(TABS.thresholds);
  const flat = {};
  for (const r of rows) {
    if (!r.key) continue;
    flat[r.key] = parseNum(r.value);
  }
  cache.thresholds = unflattenThresholds(flat);
  cache.thresholdsAt = Date.now();
  return cache.thresholds;
}

/**
 * Update a single threshold key. Pass dot-notation, e.g. "bp.systolicHigh".
 */
export async function setThreshold(key, value, actor = 'system') {
  const before = await getThresholds();

  // Re-read raw rows so we can update in place rather than replace the tab.
  const rows = await readAll(TABS.thresholds);
  const idx = rows.findIndex(r => r.key === key);
  const updatedAt = new Date().toISOString();

  if (idx >= 0) {
    rows[idx] = { ...rows[idx], value: String(value), updated_at: updatedAt };
  } else {
    rows.push({ key, value: String(value), updated_at: updatedAt });
  }

  await replaceTab(TABS.thresholds, THRESHOLD_HEADERS,
    rows.map(r => [r.key, r.value, r.updated_at]));
  cache.thresholds = null;

  await recordChange({
    actor,
    area: 'threshold',
    summary: `${key} → ${value}`,
    before: getByPath(before, key),
    after:  value,
  });
}

// ----------------------------------------------------------------------------
// Helpers — flattening lets us store nested ALERTS as flat key/value rows
// ----------------------------------------------------------------------------
function flattenThresholds(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') out.push(...flattenThresholds(v, path));
    else out.push({ key: path, value: v });
  }
  return out;
}

function unflattenThresholds(flat) {
  const out = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  return out;
}

function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function parseNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function slotToRow(slot) {
  return [
    slot.id,
    slot.time,
    slot.frequency,
    slot.dayOfWeek ?? '',
    slot.label,
    JSON.stringify(slot.meds || []),
    slot.enabled === false ? 'false' : 'true',
    new Date().toISOString(),
  ];
}

function rowToSlot(row) {
  try {
    return {
      id: row.slot_id,
      time: row.time,
      frequency: row.frequency,
      dayOfWeek: row.dayOfWeek === '' ? undefined : Number(row.dayOfWeek),
      label: row.label,
      meds: JSON.parse(row.meds_json || '[]'),
      enabled: row.enabled !== 'false',
    };
  } catch (err) {
    console.warn(`[configStore] bad schedule row, skipping:`, row, err.message);
    return null;
  }
}

// Manually bust cache — used by tests and by /api/config/refresh.
export function bustCache() {
  cache.slots = null;
  cache.thresholds = null;
}
