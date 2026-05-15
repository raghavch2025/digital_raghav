// ============================================================================
// undo.js — revert recent changes (V1.2)
// ============================================================================
// /undo and /undo N use this. We re-apply the `before` value from the most
// recent N audit entries, in reverse order (so undo of (A then B) restores
// B-before first, then A-before).
//
// Important: this reverts CONFIG changes only — threshold values and med
// schedule entries. It doesn't unsend a /say nudge (you can't unsend a
// WhatsApp message). Nudges aren't logged as "changes" anyway; they go to
// the Inbox sheet as audit trail but are filtered out of /audit display.
// ============================================================================

import { readRecent as readAuditLog, recordChange } from './auditLog.js';
import { setMedicationSlots, setThreshold } from './configStore.js';

const REVERTABLE_AREAS = new Set(['med_schedule', 'threshold']);

export async function undoLast(count, actor) {
  const recent = await readAuditLog(50);
  // Filter to revertable + skip prior /undo entries to avoid undo loops
  const revertable = recent.filter(e =>
    REVERTABLE_AREAS.has(e.area) && !e.summary.startsWith('UNDO:'));

  if (revertable.length === 0) return 'nothing to undo.';
  const target = revertable.slice(0, count);

  const results = [];
  for (const entry of target) {
    try {
      if (entry.area === 'threshold') {
        // summary is like "bp.systolicHigh → 155" — but we have explicit before/after JSON
        const key = entry.summary.split(' → ')[0].trim();
        const beforeValue = entry.before;
        if (beforeValue === undefined || beforeValue === null) {
          results.push(`⚠️ ${key}: no previous value recorded, skipped`);
          continue;
        }
        await setThreshold(key, beforeValue, actor + '_undo');
        await recordChange({
          actor, area: 'threshold',
          summary: `UNDO: ${key} ${entry.after} → ${beforeValue}`,
          before: entry.after, after: beforeValue,
        });
        results.push(`↶ ${key}: ${entry.after} → ${beforeValue}`);

      } else if (entry.area === 'med_schedule') {
        if (!Array.isArray(entry.before)) {
          results.push(`⚠️ schedule entry has no restorable snapshot, skipped`);
          continue;
        }
        await setMedicationSlots(entry.before, actor + '_undo');
        await recordChange({
          actor, area: 'med_schedule',
          summary: `UNDO: schedule reverted (${entry.before.length} slots)`,
          before: entry.after, after: entry.before,
        });
        results.push(`↶ schedule reverted (${entry.before.length} slots)`);
      }
    } catch (err) {
      console.error('[undo] entry error:', err);
      results.push(`❌ ${entry.area}: ${err.message}`);
    }
  }

  return `✓ undid ${results.length} change(s):\n\n${results.join('\n')}`;
}
