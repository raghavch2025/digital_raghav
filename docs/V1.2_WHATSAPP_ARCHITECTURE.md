# Digital Raghav V1.2 — WhatsApp-First Admin

**V1.2 design:** the bot itself becomes the admin surface. Same WhatsApp number Raghav already uses; everything Raghav needs day-to-day is a one-line command.

The web dashboard from V1.1 stays as-is (read-only view of Madhav's data). No second dashboard, no separate login.

---

## What Raghav can do from WhatsApp

| Intent | Slash form | Natural language also works |
|---|---|---|
| Read current state | `/schedule`, `/thresholds`, `/status` | "show the schedule", "what are the alert limits" |
| Change a med time | `/meds morning time 08:30` | "move morning meds to 8:30" |
| Add or remove a med | `/meds night add Reminpra 15mg` / `/meds night remove Reminpra` | "add reminpra 15mg at night" |
| Pause a slot | `/meds noon off` / `/meds noon on` | "skip afternoon meds today" → no, this is a permanent toggle; one-day skip stays manual |
| Adjust a threshold | `/set bp.systolicHigh 155` | "alert me at systolic 155 instead of 160" |
| Toggle a Garmin trigger | `/garmin stress on 60 3d` | "alert me if stress stays above 60 for 3 days" |
| Send a nudge to Madhav | `/say how's today going?` | (NL only — anything not parsed as a command is treated as a nudge candidate via confirmation. Actually we trust the sender, so it just sends.) |
| Reset to a previous state | `/undo` (last change) or `/undo 3` (last 3) | "undo the morning time change" |
| See recent changes | `/audit` (last 10) | "what did i change recently" |
| Help | `/help` | — |

---

## Trust model

Per Raghav's choice: **no confirmations**.

- Every admin command applies immediately.
- Every change is auditable via `/audit`.
- Every change is reversible via `/undo`.
- Sender check is strict: only `PEOPLE.raghav.whatsapp` can run admin commands. Anyone else gets the standard "not recognized" reply.

This is the right tradeoff because:
- Raghav uses the bot many times a day; confirmation dialogs become noise
- Every action has a paper trail
- Worst-case (typo'd threshold, deleted slot) is a one-line `/undo`
- No admin command is destructive at the *medical* level — meds aren't taken or skipped because of a schedule change; the schedule just determines when Madhav gets a reminder

---

## Send-as-nudge ambiguity

What happens if Raghav types `feeling worried about him` — is that a nudge to Madhav, or a comment to himself?

Decision: **anything Raghav types that doesn't match a command is logged but NOT auto-forwarded to Madhav.** Sending a nudge requires either `/say ...` or the dashboard composer. This prevents accidental relay of private comments.

A typed message from Raghav that doesn't match anything gets a quiet reply: `not a command — use /say <text> to message Madhav, or /help to see commands`.

---

## Files

```
src/
├── handlers/
│   └── admin.js          ← NEW — slash command parser + per-command handlers
├── adminNLParser.js      ← NEW — LLM fallback for natural-language admin
├── configStore.js        ← NEW — same as previous v1.2 (Sheets-backed config)
├── auditLog.js           ← NEW — same as previous v1.2
├── garmin.js             ← NEW — same as previous v1.2 (scaffold)
├── garminTriggers.js     ← NEW — same as previous v1.2
├── parser.js             ← MODIFIED — recognise /set, /meds, /schedule, /undo, /audit, /say, /garmin
├── index.js              ← MODIFIED — route admin commands through handlers/admin.js
└── scheduler.js          ← MODIFIED — read schedule from configStore each tick
```

The actual code files are unchanged from the previous V1.2 drop except for the routing layer (`index.js` patch) and the new admin command handler. The web dashboard files from the previous drop are not needed — Raghav can delete `adminDashboard.html` if he wants, or keep it as an optional bulk-edit tool.

---

## Boot-time auth check

The strict sender check goes here, in `handlers/admin.js`:

```js
export function isAdmin(fromWhatsApp) {
  return fromWhatsApp === PEOPLE.raghav.whatsapp;
}
```

That's the entire access control. No tokens, no passwords. Twilio enforces that the sender is who the From header says they are.

If Raghav's number ever changes, update `RAGHAV_WHATSAPP` in env and redeploy. Old number loses admin instantly.

---

## Example WhatsApp sessions

**Quick threshold tweak (10 seconds):**
```
Raghav: /set bp.systolicHigh 155
Bot:    ✓ bp.systolicHigh: 160 → 155
        next alert fires at ≥155 systolic
```

**Move morning meds back 30 minutes:**
```
Raghav: /meds morning time 07:30
Bot:    ✓ morning slot: 08:00 → 07:30
        applies from tomorrow's reminder
```

**Add a new med (doctor changed prescription):**
```
Raghav: /meds night add Reminpra 15mg
Bot:    ✓ added Reminpra 15mg to night slot (now 6 meds)
```

**Natural language fallback:**
```
Raghav: alert me if his stress stays above 65 for 4 days
Bot:    interpreted as: /garmin stress on 65 4d
        ✓ stress trigger enabled · ≥65 for 4d → flag
```

**Audit:**
```
Raghav: /audit
Bot:    last 10 changes:
        14:22 today   bp.systolicHigh 160→155
        14:18 today   morning slot 08:00→07:30
        09:30 May 14  weight trigger enabled (2.0 kg/7d)
        ...
        use /undo to revert most recent
```

**Oops:**
```
Raghav: /undo
Bot:    ✓ reverted: bp.systolicHigh 155 → 160
```

---

## What `/help` shows

```
admin commands:
  /schedule              show current med schedule
  /thresholds            show all alert limits
  /status                last 7d snapshot of Madhav
  /brief                 60-day brief for Dr. Anand

  /meds <slot> time HH:MM            change slot time
  /meds <slot> add <name> <dose>     add a med
  /meds <slot> remove <name>         remove a med
  /meds <slot> on|off                enable/disable slot

  /set <key> <value>     adjust threshold (e.g. /set bp.systolicHigh 155)
  /garmin <metric> on|off [args]     toggle wearable trigger

  /say <message>         send to Madhav as you (signed "— Raghav")
  /undo [n]              revert last n changes (default 1)
  /audit [n]             show last n changes (default 10)

natural language works too — try "move morning to 7:30"
```

---

## Migration from V1.1

1. Drop the new files into `src/`
2. Apply two patches (`parser.js`, `index.js`)
3. Boot — config tabs auto-seed from current `config.js` values
4. From Raghav's WhatsApp, send `/help` to confirm

No data migration. No re-onboarding for Madhav (none of this is visible to him; he keeps getting reminders).
