#!/usr/bin/env node
'use strict';

// Curated project lessons (.sdlc/lessons.md), capped and PR-reviewed.
//   lessons.js list
//   lessons.js add "<one rule>" [--why "<evidence>"]
//   lessons.js remove <n>

const path = require('node:path');
const lessons = require('./lib/lessons');

const [cmd = 'list', ...rest] = process.argv.slice(2);
const repoRoot = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const whyAt = rest.indexOf('--why');
const why = whyAt >= 0 ? rest[whyAt + 1] : undefined;
const positional = rest.filter((_, i) => whyAt < 0 || (i !== whyAt && i !== whyAt + 1));

function done(res, okMessage) {
  if (!res.ok) {
    process.stderr.write(res.reason + '\n');
    process.exit(1);
  }
  process.stdout.write(okMessage(res) + '\n');
}

if (cmd === 'list') {
  const items = lessons.list(repoRoot);
  process.stdout.write(items.length ? items.map((l, i) => `${i + 1}. ${l.slice(2)}`).join('\n') + '\n' : 'No lessons yet.\n');
} else if (cmd === 'add') {
  done(lessons.add(repoRoot, positional.join(' '), why), (r) => `Added (${r.count}/${lessons.MAX_LESSONS}). It becomes official when the PR containing .sdlc/lessons.md is merged.`);
} else if (cmd === 'remove') {
  done(lessons.remove(repoRoot, positional[0]), (r) => `Removed: ${r.removed}`);
} else {
  process.stderr.write('Usage: lessons.js list | add "<rule>" [--why "<evidence>"] | remove <n>\n');
  process.exit(1);
}
