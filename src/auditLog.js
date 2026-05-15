// ============================================================================
// auditLog.js — append-only record of every config change (V1.2)
// ============================================================================
// Why this matters: when Dr. Anand asks "why are we giving Reminpra at night
// now?" you can answer "I changed it on May 10 based on his sleep notes — here's
// the row." Or when something breaks at 2 AM and you don't remember what you
// touched, you can revert.
//
// Each entry: timestamp, actor, area, summary, before_json, after_json.
// ============================================================================

import { appendRow, readAll } from './sheets.js';

const TAB = 'AuditLog';
const HEADERS = ['timestamp_ist', 'actor', 'area', 'summary', 'before_json', 'after_json'];

export async function recordChange({ actor, area, summary, before, after }) {
  try {
    await appendRow(TAB, [
      new Date().toISOString(),
      actor || 'unknown',
      area,
      summary,
      JSON.stringify(before ?? null),
      JSON.stringify(after  ?? null),
    ]);
  } catch (err) {
    // Audit failures should never block the actual change. Log and continue.
    console.warn('[auditLog] write failed:', err.message);
  }
}

export async function readRecent(limit = 50) {
  try {
    const rows = await readAll(TAB);
    return rows.slice(-limit).reverse().map(r => ({
      ts: r.timestamp_ist,
      actor: r.actor,
      area: r.area,
      summary: r.summary,
      before: safeParse(r.before_json),
      after:  safeParse(r.after_json),
    }));
  } catch (err) {
    console.warn('[auditLog] read failed:', err.message);
    return [];
  }
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

export { HEADERS as AUDIT_HEADERS, TAB as AUDIT_TAB };
