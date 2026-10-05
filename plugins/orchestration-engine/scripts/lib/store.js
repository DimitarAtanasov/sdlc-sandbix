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
  return safeSid(process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || DEFAULT_SID);
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
  run.updatedAt = new Date().toISOString();
  writeJson(path.join(sessionDir(sid), 'run.json'), run);
}

// Cross-process lock so parallel hook invocations (two subagents finishing at
// once) cannot overwrite each other's read-modify-write of run.json.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(sid, fn, { timeoutMs = 5000, staleMs = 10_000 } = {}) {
  const dir = sessionDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmdirSync(lock);
      } catch {
        // lock vanished between stat and rmdir - retry
      }
      if (Date.now() > deadline) break; // proceed unlocked rather than wedge the pipeline
      sleepSync(15 + Math.floor(Math.random() * 25));
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // already released or stolen as stale
    }
  }
}

/** Returns the session's run, creating it from `factory()` if absent (race-safe). */
function ensureRun(sid, factory) {
  return withLock(sid, () => {
    let run = loadRun(sid);
    if (!run) {
      run = factory();
      saveRun(sid, run);
    }
    return run;
  });
}

/**
 * Atomic read-modify-write of the session's run. `fn(run)` mutates the run
 * and may return a value; a null/undefined run is passed through so callers can
 * create one. The run is saved unless fn returns the sentinel `store.SKIP_SAVE`.
 */
const SKIP_SAVE = Symbol('skip-save');
function updateRun(sid, fn) {
  return withLock(sid, () => {
    const run = loadRun(sid);
    const result = fn(run);
    if (result === SKIP_SAVE) return undefined;
    if (run) saveRun(sid, run);
    return result;
  });
}

function loadRun(sid) {
  return readJson(path.join(sessionDir(sid), 'run.json'));
}

/** Decisions expire ttlHours after the last activity on the run, not after creation. */
function loadFreshDecision(sid, ttlHours) {
  const decision = readJson(path.join(sessionDir(sid), 'decision.json'));
  if (!decision) return null;
  const run = loadRun(sid);
  const last = Math.max(new Date(decision.computedAt).getTime(), run && run.updatedAt ? new Date(run.updatedAt).getTime() : 0);
  const ageHours = (Date.now() - last) / 3_600_000;
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
  saveDecision, saveRun, loadRun, ensureRun, updateRun, withLock, SKIP_SAVE, loadFreshDecision, locate,
};
