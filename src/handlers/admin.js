// ============================================================================
// handlers/admin.js — Raghav's admin commands over WhatsApp (V1.2)
// ============================================================================
// Routing:
//   - index.js receives a Raghav message and calls parseAdminCommand(text)
//   - If that returns null, fall through to LLM (adminNLParser.js)
//   - The parsed command goes to executeAdminCommand(cmd) which returns a
//     string reply (sent back to Raghav via WhatsApp)
//
// Design rules:
//   - Commands are case-insensitive (`/MEDS` works), arguments are not.
//   - Every command returns a short, plain-text reply suitable for WhatsApp.
//   - No confirmations. Every change goes through configStore which writes
//     the AuditLog row before returning.
//   - The string `/undo` is special — handled by undo.js.
// ============================================================================

import { PEOPLE } from '../config.js';
import {
  getMedicationSlots, setMedicationSlots,
  getThresholds, setThreshold,
} from '../configStore.js';
import { readRecent as readAuditLog } from '../auditLog.js';
import { undoLast } from '../undo.js';
import { sendNudge } from '../nudge.js';
import { sendMessage } from '../whatsapp.js';
import { getStatus as getGarminStatus } from '../garmin.js';

// Sender check — single source of truth for admin authorisation.
export function isAdmin(fromWhatsApp) {
  return fromWhatsApp && fromWhatsApp === PEOPLE.raghav.whatsapp;
}

// ----------------------------------------------------------------------------
// PARSER — returns a structured command object or null
// ----------------------------------------------------------------------------
export function parseAdminCommand(text) {
  if (!text) return null;
  const t = text.trim();
  if (!t.startsWith('/')) return null;

  const [head, ...rest] = t.split(/\s+/);
  const cmd = head.slice(1).toLowerCase();
  const args = rest;
  const rawArgs = t.slice(head.length).trim();

  switch (cmd) {
    case 'help':       return { type: 'help' };
    case 'schedule':   return { type: 'schedule_show' };
    case 'thresholds': return { type: 'thresholds_show' };
    case 'audit':      return { type: 'audit_show', limit: parseInt(args[0], 10) || 10 };
    case 'undo':       return { type: 'undo', count: parseInt(args[0], 10) || 1 };
    case 'say':        return { type: 'nudge', body: rawArgs };
    case 'set':        return parseSet(args);
    case 'meds':       return parseMeds(args);
    case 'garmin':     return parseGarmin(args);
    case 'status':     return { type: 'status_passthrough' };  // existing handler
    case 'brief':      return { type: 'brief_passthrough' };   // existing handler
    default:           return { type: 'unknown_command', cmd };
  }
}

function parseSet(args) {
  // /set bp.systolicHigh 155
  if (args.length < 2) return { type: 'error', reason: 'usage: /set <key> <value>' };
  return { type: 'threshold_set', key: args[0], value: args[1] };
}

function parseMeds(args) {
  // /meds morning time 08:30
  // /meds night add Reminpra 15mg
  // /meds night remove Reminpra
  // /meds noon off
  // /meds noon on
  if (args.length < 2) return { type: 'error', reason: 'usage: /meds <slot> <action> [args]' };
  const [slotId, action, ...rest] = args;

  switch (action.toLowerCase()) {
    case 'time': {
      if (!rest[0]) return { type: 'error', reason: 'usage: /meds <slot> time HH:MM' };
      return { type: 'meds_time', slotId, time: rest[0] };
    }
    case 'add': {
      if (rest.length < 2) return { type: 'error', reason: 'usage: /meds <slot> add <name> <dose>' };
      // Last token is dose, everything before is the name (handles "Vit D" etc)
      const dose = rest[rest.length - 1];
      const name = rest.slice(0, -1).join(' ');
      return { type: 'meds_add', slotId, name, dose };
    }
    case 'remove': case 'rm': case 'delete': {
      if (!rest[0]) return { type: 'error', reason: 'usage: /meds <slot> remove <name>' };
      return { type: 'meds_remove', slotId, name: rest.join(' ') };
    }
    case 'on':  return { type: 'meds_toggle', slotId, enabled: true };
    case 'off': return { type: 'meds_toggle', slotId, enabled: false };
    default:    return { type: 'error', reason: `unknown action: ${action}` };
  }
}

function parseGarmin(args) {
  // /garmin status
  // /garmin stress on 60 3d
  // /garmin stress off
  if (!args.length) return { type: 'garmin_status' };
  const [metric, action, ...rest] = args;
  if (metric === 'status') return { type: 'garmin_status' };
  if (!action) return { type: 'error', reason: 'usage: /garmin <metric> on|off [threshold] [days]' };

  if (action.toLowerCase() === 'off') {
    return { type: 'garmin_toggle', metric, enabled: false };
  }
  if (action.toLowerCase() === 'on') {
    const threshold = rest[0] ? Number(rest[0]) : null;
    // days arg can be "3" or "3d"
    const daysArg = rest[1] ? rest[1].replace(/d$/, '') : null;
    const days = daysArg ? Number(daysArg) : null;
    return { type: 'garmin_toggle', metric, enabled: true, threshold, days };
  }
  return { type: 'error', reason: `usage: /garmin ${metric} on|off [threshold] [days]` };
}

// ----------------------------------------------------------------------------
// EXECUTOR — applies the parsed command and returns a reply string
// ----------------------------------------------------------------------------
export async function executeAdminCommand(parsed, raghavWhatsApp) {
  try {
    switch (parsed.type) {
      case 'help':              return helpText();
      case 'schedule_show':     return await renderSchedule();
      case 'thresholds_show':   return await renderThresholds();
      case 'audit_show':        return await renderAudit(parsed.limit);
      case 'undo':              return await runUndo(parsed.count);
      case 'nudge':             return await runNudge(parsed.body);
      case 'threshold_set':     return await runThresholdSet(parsed.key, parsed.value);
      case 'meds_time':         return await runMedsTime(parsed.slotId, parsed.time);
      case 'meds_add':          return await runMedsAdd(parsed.slotId, parsed.name, parsed.dose);
      case 'meds_remove':       return await runMedsRemove(parsed.slotId, parsed.name);
      case 'meds_toggle':       return await runMedsToggle(parsed.slotId, parsed.enabled);
      case 'garmin_status':     return await renderGarminStatus();
      case 'garmin_toggle':     return await runGarminToggle(parsed);
      case 'error':             return `⚠️ ${parsed.reason}`;
      case 'unknown_command':   return `unknown command: /${parsed.cmd}\nsend /help for the list`;
      // These two are existing V1.1 commands; let the caller handle them
      case 'status_passthrough':
      case 'brief_passthrough': return null;
      default:                  return `not implemented: ${parsed.type}`;
    }
  } catch (err) {
    console.error('[admin] execute error:', err);
    return `❌ error: ${err.message}`;
  }
}

// ----------------------------------------------------------------------------
// Renderers (read-only commands)
// ----------------------------------------------------------------------------
async function renderSchedule() {
  const slots = await getMedicationSlots();
  if (!slots.length) return 'no medications scheduled.';

  const dayName = (d) => ['sun','mon','tue','wed','thu','fri','sat'][d] || '?';
  const lines = slots.map(s => {
    const when = s.frequency === 'weekly'
      ? `${s.time} ${dayName(s.dayOfWeek)} weekly`
      : `${s.time} daily`;
    const off = s.enabled === false ? ' [OFF]' : '';
    const meds = s.meds.map(m => `${m.name} ${m.dose}`).join(', ');
    return `*${s.id}*  ${when}${off}\n  ${meds}`;
  });
  return `📋 schedule:\n\n${lines.join('\n\n')}`;
}

async function renderThresholds() {
  const t = await getThresholds();
  const flat = flatten(t);
  // Group by top-level key
  const groups = {};
  for (const [k, v] of Object.entries(flat)) {
    const top = k.split('.')[0];
    (groups[top] = groups[top] || []).push(`  ${k} = ${v}`);
  }
  const sections = Object.entries(groups).map(([g, lines]) =>
    `*${g}*\n${lines.join('\n')}`).join('\n\n');
  return `🔔 thresholds:\n\n${sections}`;
}

async function renderAudit(limit) {
  const entries = await readAuditLog(limit);
  if (!entries.length) return 'no changes recorded yet.';
  const lines = entries.map(e => {
    const when = new Date(e.ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    return `${when}  ${e.summary}`;
  });
  return `📜 last ${entries.length} changes:\n\n${lines.join('\n')}\n\n_use /undo to revert most recent_`;
}

async function renderGarminStatus() {
  const status = await getGarminStatus();
  if (!status.enabled) return '⌚ garmin: disabled in env (GARMIN_ENABLED=false)';
  if (!status.linked)  return '⌚ garmin: not linked yet. send /garmin connect to start';
  return `⌚ garmin: connected\n` +
         `last sync: ${status.lastFetched ? new Date(status.lastFetched).toLocaleString() : '—'}\n` +
         `${status.daysOfData} days of data`;
}

// ----------------------------------------------------------------------------
// Writers (state-changing commands)
// ----------------------------------------------------------------------------
async function runThresholdSet(key, valueStr) {
  const before = await getThresholds();
  const oldVal = getByPath(before, key);
  const value = parseValue(valueStr);
  await setThreshold(key, value, 'raghav_wa');
  return `✓ ${key}: ${oldVal ?? '(unset)'} → ${value}`;
}

async function runMedsTime(slotId, time) {
  if (!/^\d{1,2}:\d{2}$/.test(time)) return `⚠️ bad time format: ${time} (use HH:MM)`;
  // Normalize to two-digit hour
  const [h, m] = time.split(':').map(Number);
  if (h > 23 || m > 59) return `⚠️ invalid time: ${time}`;
  const normalized = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  const slots = await getMedicationSlots();
  const slot = findSlot(slots, slotId);
  if (!slot) return slotNotFoundError(slots, slotId);

  const old = slot.time;
  slot.time = normalized;
  await setMedicationSlots(slots, 'raghav_wa');
  return `✓ ${slot.id} slot: ${old} → ${normalized}\n_applies from next scheduler tick (~1 min)_`;
}

async function runMedsAdd(slotId, name, dose) {
  const slots = await getMedicationSlots();
  const slot = findSlot(slots, slotId);
  if (!slot) return slotNotFoundError(slots, slotId);

  // Normalise dose: "15mg" → "15 mg"
  const normDose = dose.replace(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/, '$1 $2');

  // Reject exact duplicates
  if (slot.meds.some(m => m.name.toLowerCase() === name.toLowerCase())) {
    return `⚠️ ${name} is already in the ${slot.id} slot`;
  }
  slot.meds.push({ name, dose: normDose });
  await setMedicationSlots(slots, 'raghav_wa');
  return `✓ added ${name} ${normDose} to ${slot.id} (now ${slot.meds.length} meds)`;
}

async function runMedsRemove(slotId, name) {
  const slots = await getMedicationSlots();
  const slot = findSlot(slots, slotId);
  if (!slot) return slotNotFoundError(slots, slotId);

  const before = slot.meds.length;
  slot.meds = slot.meds.filter(m => m.name.toLowerCase() !== name.toLowerCase());
  if (slot.meds.length === before) {
    return `⚠️ ${name} not found in ${slot.id} (current: ${slot.meds.map(m => m.name).join(', ') || 'empty'})`;
  }
  if (slot.meds.length === 0) {
    return `⚠️ removing ${name} would empty the ${slot.id} slot. ` +
           `use /meds ${slot.id} off to disable instead, or add another med first.`;
  }
  await setMedicationSlots(slots, 'raghav_wa');
  return `✓ removed ${name} from ${slot.id} (${slot.meds.length} left)`;
}

async function runMedsToggle(slotId, enabled) {
  const slots = await getMedicationSlots();
  const slot = findSlot(slots, slotId);
  if (!slot) return slotNotFoundError(slots, slotId);
  slot.enabled = enabled;
  await setMedicationSlots(slots, 'raghav_wa');
  return `✓ ${slot.id} slot ${enabled ? 'enabled' : 'disabled'}`;
}

async function runNudge(body) {
  if (!body) return 'usage: /say <message>';
  const result = await sendNudge({ body, acknowledgeWarnings: true });  // trust the sender
  if (!result.ok) return `❌ ${result.reason}`;
  return `✓ sent to Madhav`;
}

async function runUndo(count) {
  return await undoLast(count, 'raghav_wa');
}

async function runGarminToggle(parsed) {
  const { metric, enabled, threshold, days } = parsed;
  // Toggle the .enabled flag
  await setThreshold(`garmin.${metric}.enabled`, enabled, 'raghav_wa');
  let reply = `✓ garmin ${metric}: ${enabled ? 'enabled' : 'disabled'}`;

  // If turning on with custom threshold/days, set them too
  if (enabled && threshold != null) {
    const keyForMetric = metricToThresholdKey(metric);
    if (keyForMetric) {
      await setThreshold(keyForMetric, threshold, 'raghav_wa');
      reply += `\n  threshold = ${threshold}`;
    }
  }
  if (enabled && days != null) {
    await setThreshold(`garmin.${metric}.streakDays`, days, 'raghav_wa').catch(() => {});
    reply += `\n  streak = ${days}d`;
  }
  return reply;
}

function metricToThresholdKey(metric) {
  // Maps `stress` → `garmin.stress.avgHigh`, etc.
  const map = {
    stress: 'garmin.stress.avgHigh',
    steps:  'garmin.steps.dailyLow',
    sleep:  'garmin.sleep.minMinutes',
    rhr:    'garmin.rhr.deviationBpm',
    spo2:   'garmin.spo2.minPct',
  };
  return map[metric] || null;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function findSlot(slots, slotId) {
  const id = slotId.toLowerCase();
  return slots.find(s => s.id.toLowerCase() === id);
}

function slotNotFoundError(slots, slotId) {
  const known = slots.map(s => s.id).join(', ');
  return `⚠️ slot "${slotId}" not found. known: ${known}`;
}

function parseValue(v) {
  if (v === 'true')  return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') Object.assign(out, flatten(v, path));
    else out[path] = v;
  }
  return out;
}

function helpText() {
  return `*admin commands*

📋 read:
  /schedule       show current med schedule
  /thresholds     show all alert limits
  /status         last 7d snapshot
  /brief          60-day brief for Dr. Anand
  /audit [n]      last n changes (default 10)

💊 medications:
  /meds <slot> time HH:MM
  /meds <slot> add <name> <dose>
  /meds <slot> remove <name>
  /meds <slot> on | off
  slot ids: morning, noon, night, weekly_tayo

🔔 thresholds:
  /set <key> <value>
  e.g. /set bp.systolicHigh 155

⌚ wearable:
  /garmin status
  /garmin <metric> on [threshold] [days]
  /garmin <metric> off
  metrics: stress, steps, sleep, rhr, spo2

✉️ message:
  /say <text>     send to Madhav as you

↶ undo:
  /undo [n]       revert last n changes (default 1)

_natural language works too — try "move morning meds to 7:30"_`;
}
