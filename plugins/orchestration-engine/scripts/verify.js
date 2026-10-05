#!/usr/bin/env node
'use strict';

// Deterministic verification of the current working tree.
//   verify.js run [--repo DIR]     run the checks in .sdlc/verify.json (or autodetected) and record the evidence
//   verify.js status [--repo DIR]  is the last verification still valid for the current code?
// Exit 1 when automated checks ran and failed. "Not configured" exits 0 but says so loudly: it is NOT a pass.

const path = require('node:path');
const { load: loadConfig } = require('./lib/config');
const store = require('./lib/store');
const verify = require('./lib/verify');

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

function main() {
  const [cmd = 'run', ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const config = loadConfig();
  const found = store.locate(store.currentSid(), config.decisionTtlHours);
  const run = found ? store.loadRun(found.sid) : null;
  const repoRoot = path.resolve(typeof f.repo === 'string' ? f.repo : (run && run.repoRoot) || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  if (cmd === 'run') {
    const v = verify.runVerification(repoRoot);
    if (found) store.updateRun(found.sid, (r) => { if (!r) return store.SKIP_SAVE; r.verification = v; return undefined; });
    process.stdout.write(verify.format(v) + '\n');
    process.exit(v.configured && !v.passed ? 1 : 0);
  } else if (cmd === 'status') {
    const v = run && run.verification;
    if (!v) {
      process.stdout.write('No verification recorded for this run.\n');
      process.exit(1);
    }
    const fresh = v.treeHash === verify.treeHash(repoRoot);
    process.stdout.write(`${verify.format({ ...v, results: v.results.map((r) => ({ ...r, outputTail: '' })) })}\nCode unchanged since verification: ${fresh ? 'yes' : 'NO - re-run sdlc-verify run'}\n`);
    process.exit(fresh && (v.passed || !v.configured) ? 0 : 1);
  } else {
    process.stderr.write('Usage: verify.js run|status [--repo DIR]\n');
    process.exit(1);
  }
}

main();
