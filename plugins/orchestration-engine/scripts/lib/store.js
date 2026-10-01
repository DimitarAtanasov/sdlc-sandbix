'use strict';

// Per-session persistence for the orchestration decision and pipeline run
// state. Layout under the plugin data dir:
//   sessions/<session-id>/decision.json   (written by /orchestrate)
//   sessions/<session-id>/run.json        (lifecycle state machine)
// The session id comes from CLAUDE_SESSION_ID (exported by the SessionStart
// hook) or from the hook input's session_id. When /orchestrate ran without
// that variable it writes under "default"; hooks fall back to "default".
// Claude Code exports CLAUDE_PLUGIN_DATA only to hook processes, so the same
// SessionStart hook mirrors the data dir to the Bash tool as OE_PLUGIN_DATA;
// that way the CLI and the hooks always agree on one directory.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_SID = 'default';

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || process.env.OE_PLUGIN_DATA || path.join(os.tmpdir(), 'orchestration-engine-data');
}

function safeSid(sid) {
  return String(sid || DEFAULT_SID).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || DEFAULT_SID;
}

function currentSid() {
  return safeSid(process.env.CLAUDE_SESSION_ID || DEFAULT_SID);
}

function sessionDir(sid) {
  return path.join(dataDir(), 'sessions', safeSid(sid));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function saveDecision(sid, result) {
  writeJson(path.join(sessionDir(sid), 'decision.json'), { ...result, computedAt: new Date().toISOString() });
}

function saveRun(sid, run) {
  writeJson(path.join(sessionDir(sid), 'run.json'), run);
}

function loadRun(sid) {
  return readJson(path.join(sessionDir(sid), 'run.json'));
}

function loadFreshDecision(sid, ttlHours) {
  const decision = readJson(path.join(sessionDir(sid), 'decision.json'));
  if (!decision) return null;
  const ageHours = (Date.now() - new Date(decision.computedAt).getTime()) / 3_600_000;
  return ageHours > ttlHours ? null : decision;
}

/**
 * Finds the session id under which a fresh decision exists: the caller's own
 * session first, then the shared "default" slot. Returns { sid, decision } or null.
 */
function locate(sessionId, ttlHours) {
  for (const sid of new Set([safeSid(sessionId), DEFAULT_SID])) {
    const decision = loadFreshDecision(sid, ttlHours);
    if (decision) return { sid, decision };
  }
  return null;
}

module.exports = {
  DEFAULT_SID, dataDir, safeSid, currentSid, sessionDir,
  saveDecision, saveRun, loadRun, loadFreshDecision, locate,
};
