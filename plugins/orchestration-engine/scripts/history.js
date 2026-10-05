#!/usr/bin/env node
'use strict';

// Pipeline run history.
//   history.js summary [--json] [--min-runs N] [--repo DIR]   per-step stats + necessity signals
//   history.js list [--limit N]                  most recent runs
//   history.js path                              history file location

const path = require('node:path');
const history = require('./lib/history');

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

function main() {
  const [cmd = 'summary', ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const repoRoot = path.resolve(typeof f.repo === 'string' ? f.repo : process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const entries = history.readAll(repoRoot);
  if (cmd === 'path') {
    process.stdout.write(history.historyFile(repoRoot) + '\n');
  } else if (cmd === 'summary') {
    const sum = history.summarize(entries, f['min-runs'] ? Number(f['min-runs']) : history.MIN_RUNS);
    process.stdout.write((f.json ? JSON.stringify(sum, null, 2) : history.formatSummary(sum)) + '\n');
  } else if (cmd === 'list') {
    const limit = Number(f.limit) || 10;
    for (const e of entries.slice(-limit).reverse()) {
      process.stdout.write(`${e.at}  L${e.level}  ${e.outcome.padEnd(9)} M=${e.magnitude === null ? '-' : Number(e.magnitude).toFixed(1)}  ${e.task}\n`);
    }
    if (!entries.length) process.stdout.write('No runs recorded.\n');
  } else {
    process.stderr.write('Usage: history.js summary|list|path\n');
    process.exit(1);
  }
}

main();
