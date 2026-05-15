// ============================================================================
// PATCH FOR src/sheets.js — V1.2 addition
// ============================================================================
// V1.1 has appendRow() and readAll(). V1.2 needs replaceTab() — atomic
// "clear the data rows and write these instead" — for whole-schedule and
// whole-thresholds saves.
//
// Add this function to sheets.js, alongside the existing exports.
// Uses the same `sheets` Google client that's already initialized in that file.
// ============================================================================

/**
 * Replace all data rows in a tab (keeps the header row).
 * If the tab doesn't exist, creates it with the given headers first.
 *
 * @param {string} tabName    — e.g. "MedSchedule"
 * @param {string[]} headers  — header row, e.g. ["slot_id", "time", ...]
 * @param {string[][]} rows   — 2D array of data rows (no header)
 */
export async function replaceTab(tabName, headers, rows) {
  const client = await getSheetsClient();         // existing internal helper
  const sheetId = process.env.GOOGLE_SHEET_ID;

  // 1. Ensure the tab exists with our headers (idempotent)
  await ensureTab(tabName, headers);

  // 2. Clear existing data (everything below row 1)
  await client.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `${tabName}!A2:ZZ`,
  });

  // 3. Write new rows (if any)
  if (rows.length === 0) return;

  await client.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!A2`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

// `ensureTab(name, headers)` already exists as an internal in V1.1 sheets.js
// (bootstrap() uses it). If it's not exported, just export it now.
