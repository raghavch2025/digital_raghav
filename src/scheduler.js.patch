// ============================================================================
// PATCH FOR src/scheduler.js — V1.2
// ============================================================================
// In V1.1 the cron jobs are defined ONCE at boot from the hardcoded
// MEDICATION_SLOTS array. That means even with a dynamic schedule in
// Sheets, you'd need to restart the app for time-of-day changes.
//
// Fix: replace the per-slot cron jobs with a SINGLE cron job that runs
// every minute, reads the current schedule, and fires any slot whose
// HH:MM matches the current minute.
//
// This adds ~60 sheets reads/day on top of existing volume — negligible.
// The 60-second TTL in configStore.js means most of those hit cache.
// ============================================================================

import cron from 'node-cron';
import { DateTime } from 'luxon';
import { TIMEZONE, CHECK_IN_SLOTS, DIGEST } from './config.js';
import { getMedicationSlots } from './configStore.js';  // NEW
import { sendMedicationReminder, sendCheckIn, sendWeeklyDigest } from './handlers/index.js';
import { pollYesterday as garminPoll } from './garmin.js';
import { evaluateTriggers as garminEvaluate } from './garminTriggers.js';

export function startScheduler() {
  console.log('[scheduler] starting V1.2 unified tick…');

  // ──────────────────────────────────────────────────────────────
  // EVERY-MINUTE TICK — fires any med slot or check-in scheduled
  // for the current HH:MM. Replaces the V1.1 per-slot cron jobs.
  // ──────────────────────────────────────────────────────────────
  cron.schedule('* * * * *', async () => {
    const now = DateTime.now().setZone(TIMEZONE);
    const hhmm = now.toFormat('HH:mm');
    const weekday = now.weekday % 7;  // luxon: 1=Mon..7=Sun → 0=Sun..6=Sat

    try {
      const slots = await getMedicationSlots();
      for (const slot of slots) {
        if (slot.time !== hhmm) continue;
        if (slot.frequency === 'weekly' && slot.dayOfWeek !== weekday) continue;
        await sendMedicationReminder(slot);
      }
    } catch (err) {
      console.error('[scheduler] med tick error:', err);
    }

    // Check-ins stay in config.js for now (they're not user-editable yet)
    for (const c of CHECK_IN_SLOTS) {
      if (c.time === hhmm) {
        sendCheckIn(c).catch(e => console.error('[scheduler] checkin error:', e));
      }
    }
  }, { timezone: TIMEZONE });

  // ──────────────────────────────────────────────────────────────
  // WEEKLY DIGEST
  // ──────────────────────────────────────────────────────────────
  const [dh, dm] = DIGEST.time.split(':');
  cron.schedule(`${dm} ${dh} * * ${DIGEST.dayOfWeek}`,
    () => sendWeeklyDigest().catch(e => console.error('[digest] error:', e)),
    { timezone: TIMEZONE });

  // ──────────────────────────────────────────────────────────────
  // GARMIN — daily poll at 06:00, evaluate at 06:05
  // ──────────────────────────────────────────────────────────────
  cron.schedule('0 6 * * *', async () => {
    try { await garminPoll(); } catch (e) { console.error('[garmin poll]', e); }
  }, { timezone: TIMEZONE });

  cron.schedule('5 6 * * *', async () => {
    try { await garminEvaluate(); } catch (e) { console.error('[garmin evaluate]', e); }
  }, { timezone: TIMEZONE });

  console.log('[scheduler] V1.2 scheduler armed');
}
