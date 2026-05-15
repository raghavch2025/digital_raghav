// ============================================================================
// adminNLParser.js — natural-language → slash-command translation (V1.2)
// ============================================================================
// When Raghav types something that doesn't start with `/`, we still want to
// understand intents like:
//   "move morning meds to 7:30"
//   "alert me at 155 systolic instead"
//   "what's on the schedule"
//   "tell madhav to drink water"
//
// We do this via a small Claude call (claude-haiku for speed/cost) that
// returns the canonical slash command as a string. Then we route that back
// through the deterministic parser. This way the LLM never executes
// anything directly — it only suggests a command, which we re-parse and
// validate normally.
//
// The system prompt is restrictive: if the LLM is uncertain, it returns
// PASS so we hand off to existing handlers (which will eventually treat the
// message as "unknown" and reply with the help hint).
// ============================================================================

import { Anthropic } from '@anthropic-ai/sdk';
import { CLAUDE } from './config.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You translate Raghav's natural-language WhatsApp messages into slash commands for a health bot. Raghav manages medication and alert configuration for his brother Madhav.

Output EXACTLY ONE LINE — either a slash command (starting with /) or the literal string PASS.

Available commands:
  /schedule
  /thresholds
  /audit [n]
  /undo [n]
  /status
  /brief
  /help
  /meds <slot> time <HH:MM>
  /meds <slot> add <name> <dose>
  /meds <slot> remove <name>
  /meds <slot> on
  /meds <slot> off
  /set <key> <value>
  /garmin <metric> on [threshold] [days]
  /garmin <metric> off
  /garmin status
  /say <message>

Slot ids: morning, noon, night, weekly_tayo
Threshold keys include: bp.systolicHigh, bp.systolicLow, bp.diastolicHigh, bp.diastolicLow, meds.missedSlotsPerDay, weight.deltaWeeklyKg, mood.lowStreakDays.
Garmin metrics: stress, steps, sleep, rhr, spo2.

Rules:
- If the message is clearly a config change request, output the exact slash command.
- If the message looks like a quick question Raghav wants to ask Madhav, do NOT auto-forward — output PASS. (Use of /say must be explicit, e.g. "tell madhav...", "send him...".)
- If the user explicitly says "tell madhav X" or "send him X", output /say X
- If you're not confident, output PASS.
- Output the command on a single line with no surrounding text, no explanation, no markdown.

Examples:
"move morning meds to 7:30" → /meds morning time 07:30
"add reminpra 15mg to night" → /meds night add Reminpra 15mg
"alert me when systolic hits 155" → /set bp.systolicHigh 155
"turn on stress alerts above 65 for 4 days" → /garmin stress on 65 4d
"what's the schedule" → /schedule
"undo that" → /undo
"tell madhav to drink water" → /say drink some water bhai 💧
"i'm worried about him today" → PASS
"thx" → PASS`;

/**
 * Translate a natural-language admin request into a slash command.
 * @param {string} text — Raghav's raw message
 * @returns {Promise<string|null>} — a slash command starting with /, or null if PASS
 */
export async function parseAdminNL(text) {
  if (!text || text.trim().length === 0) return null;
  if (text.trim().startsWith('/')) return text.trim();  // already a command, no LLM needed

  try {
    const res = await client.messages.create({
      model: CLAUDE.model,
      max_tokens: 100,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text.trim() }],
    });
    const out = (res.content?.[0]?.text || '').trim();
    if (!out || out === 'PASS')  return null;
    if (!out.startsWith('/'))    return null;
    if (out.includes('\n'))      return null;  // multi-line = confused
    if (out.length > 300)        return null;  // suspiciously long
    return out;
  } catch (err) {
    console.warn('[adminNL] error:', err.message);
    return null;
  }
}
