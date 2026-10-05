#!/usr/bin/env node
'use strict';

// One-time project setup (idempotent, non-destructive): makes a repo work for
// the SDLC framework from a fresh web/phone session.
//   - .claude/settings.json   registers the sdlc-sandbix marketplace and enables both plugins
//                             (merged into any existing settings; existing keys are kept)
//   - .sdlc/verify.json       verification commands (autodetected where possible)
//   - .sdlc/lessons.md        empty, capped lessons file
//   setup.js [--repo DIR] [--print]    --print shows what would be written without writing

const fs = require('node:fs');
const path = require('node:path');
const verify = require('./lib/verify');
const lessons = require('./lib/lessons');

const MARKETPLACE = 'sdlc-sandbix';
const SETTINGS = {
  extraKnownMarketplaces: { [MARKETPLACE]: { source: { source: 'github', repo: 'DimitarAtanasov/sdlc-sandbix' } } },
  enabledPlugins: { [`orchestration-engine@${MARKETPLACE}`]: true, [`sdlc-agents@${MARKETPLACE}`]: true },
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function plan(repoRoot) {
  const out = [];
  const settingsFile = path.join(repoRoot, '.claude', 'settings.json');
  const existing = readJson(settingsFile) || {};
  const merged = {
    ...existing,
    extraKnownMarketplaces: { ...(existing.extraKnownMarketplaces || {}), ...SETTINGS.extraKnownMarketplaces },
    enabledPlugins: { ...(existing.enabledPlugins || {}), ...SETTINGS.enabledPlugins },
  };
  if (JSON.stringify(existing) !== JSON.stringify(merged)) out.push({ file: settingsFile, content: JSON.stringify(merged, null, 2) + '\n', why: 'register marketplace + enable plugins' });

  const verifyFile = path.join(repoRoot, verify.CONFIG_REL);
  if (!fs.existsSync(verifyFile)) {
    const detected = verify.loadVerifyConfig(repoRoot);
    const commands = detected.commands.length
      ? detected.commands
      : [{ name: 'unit', cmd: 'REPLACE-WITH-YOUR-TEST-COMMAND', required: true }, { name: 'ATF', manual: true, note: 'Describe checks that cannot run here (for example a ServiceNow ATF suite)' }];
    out.push({ file: verifyFile, content: JSON.stringify({ commands }, null, 2) + '\n', why: detected.commands.length ? 'autodetected verification commands' : 'template: replace the placeholder command' });
  }
  const lessonsFile = lessons.lessonsFile(repoRoot);
  if (!fs.existsSync(lessonsFile)) out.push({ file: lessonsFile, content: null, why: 'empty lessons file', init: true });
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const repoRoot = path.resolve(args.includes('--repo') ? args[args.indexOf('--repo') + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const print = args.includes('--print');
  const changes = plan(repoRoot);
  if (!changes.length) {
    process.stdout.write('Already set up: nothing to change.\n');
    return;
  }
  for (const c of changes) {
    process.stdout.write(`${print ? 'would write' : 'writing'} ${path.relative(repoRoot, c.file)}  (${c.why})\n`);
    if (print) {
      if (c.content) process.stdout.write(c.content);
      continue;
    }
    if (c.init) {
      lessons.add(repoRoot, 'placeholder', '', '1970-01-01');
      lessons.remove(repoRoot, 1);
    } else {
      fs.mkdirSync(path.dirname(c.file), { recursive: true });
      fs.writeFileSync(c.file, c.content);
    }
  }
  if (!print) process.stdout.write('Commit these files so every session (including phone sessions) picks them up.\n');
}

main();
