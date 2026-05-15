// ============================================================================
// PATCH FOR src/parser.js — V1.2
// ============================================================================
// The V1.1 parser knows about /brief and /help. The admin layer adds many
// more slash commands. We don't want them caught by the existing TYPES.HELP
// branch or fall through to the LLM rescue.
//
// Simplest fix: add a new type ADMIN_COMMAND that matches anything starting
// with `/` that isn't already covered. handlers/admin.js handles the actual
// parsing — parser.js just routes.
//
// Add ADMIN_COMMAND to the TYPES export, and add the regex match.
// ============================================================================

// ─── Add to TYPES (near top of parser.js) ──────────────────────────────────

export const TYPES = {
  // ... existing entries ...
  ADMIN_COMMAND: 'admin_command',     // NEW
};

// ─── Add to the parse() function — early in the chain, BEFORE the
//     `/brief` and `/help` checks ─────────────────────────────────────────

  // V1.2: any slash command goes through the admin handler in index.js
  // (which will dispatch /brief and /help correctly via passthrough).
  // We let parseAdminCommand() do the real work; the parser just tags it.
  if (/^\s*\//.test(text)) {
    return { type: TYPES.ADMIN_COMMAND, raw: text };
  }
