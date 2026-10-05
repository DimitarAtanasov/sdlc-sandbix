'use strict';

// Deterministic verification: runs the commands a repo declares in
// .sdlc/verify.json and records evidence (exit codes + a content hash of the
// tree that was verified). Nothing here calls an LLM, and "no verification
// configured" is reported as such, never as a pass.
//
// .sdlc/verify.json:
//   { "commands": [
//       { "name": "unit", "cmd": "dotnet test --nologo", "required": true, "timeoutSec": 900 },
//       { "name": "ATF", "manual": true, "note": "Run the NeedIt ATF suite on the dev instance" } ] }
// A "manual" entry cannot run in a container; it is listed as unverified.

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_REL = path.join('.sdlc', 'verify.json');
const IGNORED_PREFIX = '.sdlc/';
const OUTPUT_TAIL_LINES = 40;

function git(repoRoot, args, input) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

/**
 * Hash of the working-tree contents (tracked + untracked, honoring .gitignore,
 * excluding .sdlc/). Commit-stable: committing the same content does not change it.
 */
function treeHash(repoRoot) {
  const list = git(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter((f) => f && !f.startsWith(IGNORED_PREFIX) && fs.existsSync(path.join(repoRoot, f)));
  const unique = [...new Set(list)].sort();
  if (!unique.length) return 'empty';
  const hashes = git(repoRoot, ['hash-object', '--stdin-paths'], unique.join('\n') + '\n').split('\n').filter(Boolean);
  const h = crypto.createHash('sha1');
  unique.forEach((f, i) => h.update(`${f}\0${hashes[i] || ''}\n`));
  return h.digest('hex');
}

function loadVerifyConfig(repoRoot) {
  const file = path.join(repoRoot, CONFIG_REL);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.commands)) return { source: CONFIG_REL, commands: parsed.commands };
  } catch {
    // fall through to autodetect
  }
  const commands = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const test = pkg.scripts && pkg.scripts.test;
    if (test && !/no test specified/i.test(test)) commands.push({ name: 'npm test', cmd: 'npm test', required: true });
  } catch {
    // no package.json
  }
  const entries = fs.readdirSync(repoRoot);
  if (entries.some((f) => /\.(sln|csproj)$/i.test(f))) commands.push({ name: 'dotnet test', cmd: 'dotnet test --nologo', required: true });
  return { source: commands.length ? 'autodetected' : null, commands };
}

function tail(text, n = OUTPUT_TAIL_LINES) {
  return String(text || '').split('\n').slice(-n).join('\n').trim();
}

/** Runs the declared commands and returns the evidence record. */
function runVerification(repoRoot, { timeoutDefaultSec = 900 } = {}) {
  const config = loadVerifyConfig(repoRoot);
  const hash = treeHash(repoRoot);
  const results = [];
  const manual = [];
  for (const c of config.commands) {
    if (c.manual) {
      manual.push(c.note || c.name || 'manual check');
      continue;
    }
    if (!c.cmd) continue;
    const started = Date.now();
    const r = spawnSync(c.cmd, { cwd: repoRoot, shell: true, encoding: 'utf8', timeout: (c.timeoutSec || timeoutDefaultSec) * 1000, maxBuffer: 32 * 1024 * 1024 });
    results.push({
      name: c.name || c.cmd,
      cmd: c.cmd,
      required: c.required !== false,
      exit: r.status === null ? (r.error && r.error.code === 'ETIMEDOUT' ? 'timeout' : 'signal') : r.status,
      ms: Date.now() - started,
      outputTail: tail(`${r.stdout || ''}\n${r.stderr || ''}`),
    });
  }
  const automated = results.filter((r) => r.required);
  const configured = automated.length > 0;
  return {
    at: new Date().toISOString(),
    treeHash: hash,
    configured,
    source: config.source,
    passed: configured && automated.every((r) => r.exit === 0),
    results,
    manual,
  };
}

function format(v) {
  const lines = [];
  if (!v.configured) {
    lines.push('Verification NOT CONFIGURED: no automated checks ran. Add .sdlc/verify.json (see /sdlc-setup). Treat this change as unverified.');
  } else {
    lines.push(`Verification ${v.passed ? 'PASSED' : 'FAILED'} (${v.source})`);
  }
  for (const r of v.results) lines.push(`  ${r.exit === 0 ? 'ok  ' : 'FAIL'} ${r.name}  exit=${r.exit}  ${r.ms}ms`);
  for (const r of v.results.filter((x) => x.exit !== 0)) lines.push(`--- ${r.name} (last lines) ---\n${r.outputTail}`);
  for (const m of v.manual) lines.push(`  manual (unverified here): ${m}`);
  return lines.join('\n');
}

module.exports = { treeHash, loadVerifyConfig, runVerification, format, CONFIG_REL };
