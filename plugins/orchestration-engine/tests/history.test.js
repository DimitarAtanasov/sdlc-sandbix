'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, gitRepo, run, json } = require('./helpers');

function ctx() {
  return { repo: gitRepo({ 'README.md': 'hello\n' }), data: tmpDir('oe-data-') };
}
const env = (c, sid = 's1') => ({ CLAUDE_PROJECT_DIR: c.repo, CLAUDE_PLUGIN_DATA: c.data, CLAUDE_SESSION_ID: sid });
const orchestrate = (c, task, sid) => json(run('compute-complexity.js', { args: ['--json', task], env: env(c, sid) }));
const record = (c, step, ...args) => run('lifecycle.js', { args: ['record', step, ...args], env: env(c) });
const entries = (c) => fs.readFileSync(path.join(c.data, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a completed run is logged once with per-step counters', () => {
  const c = ctx();
  orchestrate(c, 'Fix a typo in the README');
  record(c, 'implementation', '--decision', 'draft');
  record(c, 'documentation', '--decision', 'draft');
  record(c, 'testing', '--decision', 'draft');
  record(c, 'testing', '--decision', 'draft'); // extra call must not double-log
  const logged = entries(c);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].outcome, 'completed');
  assert.equal(logged[0].level, 1);
  assert.equal(logged[0].task, 'Fix a typo in the README');
  assert.equal(logged[0].steps.implementation.attempts, 1);
  assert.equal(logged[0].steps['tech-design'].status, 'skipped');
});

test('replacing an unfinished run logs it as abandoned; untouched runs are not logged', () => {
  const c = ctx();
  orchestrate(c, 'Fix a typo in the README');
  orchestrate(c, 'Fix another typo'); // first run never started: nothing to log
  assert.equal(fs.existsSync(path.join(c.data, 'history.jsonl')), false);
  record(c, 'implementation', '--decision', 'draft');
  orchestrate(c, 'Third task'); // replaces a started, unfinished run
  const logged = entries(c);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].outcome, 'abandoned');
  assert.equal(logged[0].task, 'Fix another typo');
});

test('a Level 3 decline gate run is logged as halted immediately', () => {
  const c = ctx();
  const out = run('compute-complexity.js', {
    args: ['--json', 'Fix a typo in the README'],
    env: { ...env(c), CLAUDE_PLUGIN_OPTION_declineDHardCeiling: '-1', CLAUDE_PLUGIN_OPTION_specDistanceWeight: '5000' },
  });
  assert.equal(json(out).matrix.level, 3);
  assert.equal(json(out).matrix.threeWayDecision.decision, 'decline');
  assert.equal(entries(c)[0].outcome, 'halted');
});

test('summary computes per-step rates and flags rubber-stamp and blocker steps', () => {
  const { summarize } = require('../scripts/lib/history');
  const mk = (over = {}) => ({
    outcome: 'completed', level: 2,
    steps: {
      'spec-eval': { status: 'approved', attempts: 1, cycles: 1, revisions: 0, clarifications: 0 },
      'tech-design': { status: 'approved', attempts: 1, cycles: 0, revisions: 0, clarifications: 0 },
      'tech-design-eval': { status: 'approved', attempts: 1, cycles: 1, revisions: 0, clarifications: 0 },
      implementation: { status: 'declined', attempts: 1, cycles: 0, revisions: 0, clarifications: 0 },
      documentation: { status: 'pending', attempts: 0, cycles: 0, revisions: 0, clarifications: 0 },
      testing: { status: 'skipped', attempts: 0, cycles: 0, revisions: 0, clarifications: 0 },
      ...over,
    },
  });
  const sum = summarize([mk(), mk(), mk(), mk(), mk()]);
  assert.equal(sum.runs, 5);
  assert.equal(sum.steps['spec-eval'].approvalRate, 100);
  assert.equal(sum.steps.implementation.declineRate, 100);
  assert.equal(sum.steps.documentation.neverRan, 5);
  assert.equal(sum.steps.testing.skipped, 5);
  assert.ok(sum.signals.some((s) => /^spec-eval:.*rubber-stamp/.test(s)));
  assert.ok(!sum.signals.some((s) => /^tech-design:/.test(s)), 'producers are not rubber-stamp candidates');
  assert.ok(sum.signals.some((s) => /^implementation:.*frequent blocker/.test(s)));
  const small = summarize([mk(), mk()]);
  assert.ok(small.signals.every((s) => /not enough data/.test(s)));
});

test('history CLI: summary, list, path, and the empty case', () => {
  const c = ctx();
  const h = (...args) => run('history.js', { args, env: { CLAUDE_PLUGIN_DATA: c.data } });
  assert.match(h('summary').stdout, /No pipeline runs recorded/);
  orchestrate(c, 'Fix a typo in the README');
  record(c, 'implementation', '--decision', 'draft');
  record(c, 'documentation', '--decision', 'draft');
  record(c, 'testing', '--decision', 'draft');
  assert.match(h('summary').stdout, /Runs: 1 \(completed 1/);
  assert.equal(json(h('summary', '--json')).runs, 1);
  assert.match(h('list').stdout, /L1\s+completed\s+M=.*Fix a typo/);
  assert.equal(h('path').stdout.trim(), path.join(c.data, 'history.jsonl'));
});
