// ============================================================================
// PATCH FOR src/index.js — V1.2 WhatsApp-first routing
// ============================================================================
// Replace the existing Raghav-branch logic inside routeMessage() with the
// version below. Adds:
//   1. Slash-command handling via handlers/admin.js
//   2. Natural-language fallback via adminNLParser.js
//   3. Reply-with-result (sends executor output back to Raghav)
//
// The Madhav branch is unchanged.
// ============================================================================

// ─── Add to imports ────────────────────────────────────────────────────────
import {
  isAdmin,
  parseAdminCommand,
  executeAdminCommand,
} from './handlers/admin.js';
import { parseAdminNL } from './adminNLParser.js';
import { bootstrapConfigStore } from './configStore.js';
import { bootstrapGarmin } from './garmin.js';

// ─── Replace the Raghav branch inside routeMessage() ───────────────────────
//
// Existing V1.1 code (delete this):
//
//   if (isRaghav) {
//     if (parsed.type === TYPES.BRIEF) {
//       const brief = await generateDoctorBrief();
//       await sendMessage(from, brief);
//       return;
//     }
//     if (parsed.type === TYPES.HELP) {
//       await sendMessage(from,
//         'commands: */brief* (60-day doctor brief), */status* (last 7d snapshot)');
//       return;
//     }
//     return;
//   }
//
// Replace with:

  if (isRaghav) {
    // 1. Existing V1.1 special-cases — keep these for backward compatibility
    if (parsed.type === TYPES.BRIEF) {
      const brief = await generateDoctorBrief();
      await sendMessage(from, brief);
      return;
    }

    // 2. NEW — slash command admin layer
    let adminCmd = parseAdminCommand(text);

    // 3. NEW — natural-language fallback (only if not already a slash command)
    if (!adminCmd) {
      const translated = await parseAdminNL(text);
      if (translated) {
        console.log(`[admin] NL translated "${text}" → "${translated}"`);
        adminCmd = parseAdminCommand(translated);
        // If the LLM produced /say or similar, the executor handles it
      }
    }

    if (adminCmd) {
      // Special handoffs to existing handlers
      if (adminCmd.type === 'status_passthrough') {
        // Reuse the existing weekly digest body as a 7d status
        const status = await generateDoctorBrief({ days: 7 });
        await sendMessage(from, status);
        return;
      }
      if (adminCmd.type === 'brief_passthrough') {
        const brief = await generateDoctorBrief();
        await sendMessage(from, brief);
        return;
      }

      // Everything else goes through the executor
      const reply = await executeAdminCommand(adminCmd, from);
      if (reply) await sendMessage(from, reply);
      return;
    }

    // 4. Unrecognised — short reply with hint (don't echo to Madhav)
    await sendMessage(from,
      'not a command — use /say <text> to message Madhav, or /help for commands');
    return;
  }

// ─── Modify main() boot sequence ───────────────────────────────────────────
// Add these two lines right after the existing `await bootstrap();`

  console.log('[boot] bootstrapping config store…');
  await bootstrapConfigStore();

  console.log('[boot] bootstrapping garmin (if enabled)…');
  await bootstrapGarmin();
