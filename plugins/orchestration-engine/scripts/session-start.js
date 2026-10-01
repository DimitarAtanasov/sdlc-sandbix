#!/usr/bin/env node
'use strict';

// SessionStart hook. Claude Code exports plugin variables (CLAUDE_PLUGIN_DATA,
// CLAUDE_PLUGIN_OPTION_*) only to hook processes, but /orchestrate and the
// lifecycle CLI run through the Bash tool. This hook mirrors what they need
// into the session's Bash environment (via CLAUDE_ENV_FILE):
//   CLAUDE_SESSION_ID   per-session state key
//   OE_PLUGIN_DATA      the same data dir the hooks use
//   OE_OPTION_<key>     the user's plugin config values

const fs = require('node:fs');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file) process.exit(0);

  const lines = [];
  const sid = String(input.session_id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (sid) lines.push(`export CLAUDE_SESSION_ID=${sid}`);
  if (process.env.CLAUDE_PLUGIN_DATA) lines.push(`export OE_PLUGIN_DATA=${shellQuote(process.env.CLAUDE_PLUGIN_DATA)}`);
  for (const [key, value] of Object.entries(process.env)) {
    const m = /^CLAUDE_PLUGIN_OPTION_([A-Za-z0-9_]+)$/.exec(key);
    if (m) lines.push(`export OE_OPTION_${m[1]}=${shellQuote(value)}`);
  }
  if (lines.length) fs.appendFileSync(file, lines.join('\n') + '\n');
}

main();
