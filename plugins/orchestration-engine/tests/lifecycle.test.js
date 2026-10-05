'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../scripts/lib/lifecycle');
const { decideExecutionMatrix } = require('../scripts/lib/matrix');
const { magnitude } = require('../scripts/lib/complexity');
const { DEFAULTS } = require('../scripts/lib/config');

const newRun = (S, D, H, cfg = {}, opts = {}) => {
  const vector = { S, D, H };
  const result = { matrix: decideExecutionMatrix({ vector, magnitude: magnitude(S, D, H) }, { ...DEFAULTS, ...cfg }) };
  return L.beginRun(result, { ...DEFAULTS, ...cfg }, opts);
};
const L1 = () => newRun(5, 0, 0);
const L2 = () => newRun(30, 0, 10);
const L3 = () => newRun(120, 10, 10);

const start = (run, step) => {
  assert.equal(L.checkStart(run, step).allow, true, `${step} should be startable: ${L.checkStart(run, step).reason}`);
  return L.markStarted(run, step);
};
const approve = (run, step, extra = {}) => {
  start(run, step);
  return L.recordReport(run, step, { decision: 'draft', verdict: 'approve', confidence: 0.9, ...extra });
};
const passThroughImplementation = (run) => {
  approve(run, 'spec-eval');
  approve(run, 'tech-design');
  approve(run, 'tech-design-eval');
  approve(run, 'implementation');
};

test('stepFor maps agent names to steps, strictly', () => {
  const cases = {
    'spec-eval-agent': 'spec-eval',
    'sdlc-agents:tech-design-agent': 'tech-design',
    'tech-design-eval-agent': 'tech-design-eval',
    'implementation-agent': 'implementation',
    'documentation-agent': 'documentation',
    'testing-agent': 'testing',
    'service-now-architect': null,
    Explore: null,
    'inspect-docker-latest': null, // inspect != spec, docker != doc, latest != test
  };
  for (const [name, step] of Object.entries(cases)) assert.equal(L.stepFor(name), step, name);
});

test('stepForCall only falls back to the description for generic agents', () => {
  assert.equal(L.stepForCall({ subagent_type: 'general-purpose', description: 'Write tests' }), 'testing');
  assert.equal(L.stepForCall({ subagent_type: 'Explore', description: 'Find test files' }), null);
  assert.equal(L.stepForCall({ subagent_type: 'general-purpose', description: 'Inspect the docker image' }), null);
});

test('level 1 skips design/eval and goes straight to implementation', () => {
  const run = L1();
  for (const s of ['spec-eval', 'tech-design', 'tech-design-eval']) {
    const c = L.checkStart(run, s);
    assert.equal(c.allow, false);
    assert.match(c.reason, /skipped/);
  }
  assert.equal(approve(run, 'implementation').nextAction, 'run:documentation|testing');
});

test('hotfix skips design/eval at any level and never forces a clarification', () => {
  const run = newRun(30, 0, 45, {}, { hotfix: true });
  assert.equal(run.level, 2);
  assert.equal(run.requireClarification, false);
  assert.match(L.checkStart(run, 'tech-design').reason, /Hotfix/);
  assert.equal(approve(run, 'implementation').status, 'approved');
  assert.match(L.startNotes(run, 'testing').join(' '), /Hotfix/);
});

test('level 1 coerces ask_clarification and decline to draft', () => {
  const run = L1();
  start(run, 'implementation');
  const r = L.recordReport(run, 'implementation', { decision: 'decline', summary: 'nope' });
  assert.equal(r.status, 'approved');
  assert.equal(run.halted, false);
  assert.match(r.coerced[0], /Level 1/);
});

test('level 2 enforces sequential gating and ends at delivery, not done', () => {
  const run = L2();
  assert.equal(L.checkStart(run, 'tech-design').allow, false);
  assert.match(L.checkStart(run, 'implementation').reason, /spec-eval/);
  passThroughImplementation(run);
  assert.equal(L.checkStart(run, 'documentation').allow, true);
  assert.equal(L.checkStart(run, 'testing').allow, true);
  approve(run, 'testing');
  assert.equal(run.completed, false);
  assert.equal(approve(run, 'documentation').nextAction, 'deliver');
  assert.equal(run.completed, false);
});

test('ask_clarification keeps per-step questions and blocks later steps until re-run', () => {
  const run = L2();
  start(run, 'spec-eval');
  const r = L.recordReport(run, 'spec-eval', { decision: 'ask_clarification', missing_info: ['Which table?'] });
  assert.equal(r.nextAction, 'ask_user');
  assert.deepEqual(L.openQuestions(run), ['Which table?']);
  assert.equal(L.checkStart(run, 'tech-design').allow, false);
  L.markStarted(run, 'spec-eval'); // re-spawn after the user answered
  assert.equal(run.clarified, true);
  assert.deepEqual(L.openQuestions(run), []);
});

test('H > 40 forces the first step to ask, once', () => {
  const run = newRun(30, 0, 45);
  assert.equal(run.requireClarification, true);
  assert.match(L.startNotes(run, 'spec-eval').join(' '), /MUST end with decision 'ask_clarification'/);
  start(run, 'spec-eval');
  const r = L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'approve', confidence: 0.99 });
  assert.equal(r.status, 'needs_clarification');
  assert.match(r.coerced.join(' '), /H > 40/);
  start(run, 'spec-eval');
  assert.equal(L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'approve', confidence: 0.99 }).status, 'approved');
});

test('low-confidence draft is downgraded at level 2 but not level 1', () => {
  const run = L2();
  start(run, 'spec-eval');
  assert.equal(L.recordReport(run, 'spec-eval', { decision: 'draft', confidence: 0.2 }).status, 'needs_clarification');
  const l1 = L1();
  start(l1, 'implementation');
  assert.equal(L.recordReport(l1, 'implementation', { decision: 'draft', confidence: 0.2 }).status, 'approved');
});

test('decline halts the whole pipeline; a human override resumes it and is logged', () => {
  const run = L2();
  start(run, 'spec-eval');
  const r = L.recordReport(run, 'spec-eval', { decision: 'decline', summary: 'no requirements' });
  assert.equal(r.nextAction, 'abort');
  assert.equal(run.halted, true);
  assert.match(L.checkStart(run, 'implementation').reason, /halted/i);
  assert.match(L.checkStart(run, 'implementation').reason, /override/);
  assert.equal(L.override(run, 'requirements arrived by email').ok, true);
  assert.equal(run.overrides.length, 1);
  assert.equal(run.halted, false);
  assert.equal(run.steps['spec-eval'].status, 'pending');
  assert.equal(L.checkStart(run, 'spec-eval').allow, true);
  assert.equal(L.override(run, 'again').ok, false);
});

test('level 3 decline gate halts before any agent runs, and can be overridden', () => {
  const run = newRun(120, 70, 10);
  assert.equal(run.halted, true);
  assert.equal(L.checkStart(run, 'spec-eval').allow, false);
  assert.equal(L.override(run, 'D is fine, the ceiling is too low for this monorepo').ok, true);
  assert.equal(L.checkStart(run, 'spec-eval').allow, true);
});

test('revise sends tech-design-eval back to tech-design, then re-evaluates', () => {
  const run = L2();
  approve(run, 'spec-eval');
  approve(run, 'tech-design');
  start(run, 'tech-design-eval');
  const r = L.recordReport(run, 'tech-design-eval', { decision: 'draft', verdict: 'revise', summary: 'missing error handling' });
  assert.equal(r.nextAction, 'rerun:tech-design');
  assert.equal(run.steps['tech-design'].status, 'needs_rework');
  assert.equal(L.checkStart(run, 'tech-design-eval').allow, false);
  assert.equal(L.checkStart(run, 'tech-design').allow, true);
  approve(run, 'tech-design');
  assert.equal(run.steps['tech-design-eval'].status, 'pending');
  assert.equal(approve(run, 'tech-design-eval').status, 'approved');
});

test('testing that finds defects sends implementation back instead of halting, and invalidates docs', () => {
  const run = L2();
  passThroughImplementation(run);
  approve(run, 'documentation');
  start(run, 'testing');
  const r = L.recordReport(run, 'testing', { decision: 'draft', verdict: 'revise', summary: '2 acceptance criteria fail' });
  assert.equal(run.halted, false);
  assert.equal(r.nextAction, 'rerun:implementation');
  assert.equal(run.steps.implementation.status, 'needs_rework');
  assert.equal(L.checkStart(run, 'testing').allow, false); // implementation must be redone first
  approve(run, 'implementation'); // rework
  assert.equal(run.steps.documentation.status, 'pending', 'docs consumed the old implementation');
  assert.equal(run.steps.testing.status, 'pending');
  approve(run, 'documentation');
  assert.equal(approve(run, 'testing').nextAction, 'deliver');
});

test('re-approving an upstream step invalidates approved downstream steps', () => {
  const run = L2();
  passThroughImplementation(run);
  approve(run, 'tech-design'); // someone reworks the design after implementation
  assert.equal(run.steps['tech-design-eval'].status, 'pending');
  assert.equal(run.steps.implementation.status, 'pending');
  assert.equal(L.checkStart(run, 'implementation').allow, false);
});

test('level 3 needs N independent approvals; revise resets the approval count', () => {
  const run = L3();
  assert.equal(run.policy.minCycles, 2);
  start(run, 'spec-eval');
  const first = L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'approve', confidence: 0.9 });
  assert.deepEqual([first.status, first.nextAction], ['needs_cycle', 'rerun:spec-eval']);
  assert.equal(L.checkStart(run, 'tech-design').allow, false);
  // a revise in between must not let one later approval satisfy "two independent approvals"
  start(run, 'spec-eval');
  assert.equal(L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'revise' }).status, 'revise');
  assert.equal(approve(run, 'spec-eval').status, 'needs_cycle');
  assert.equal(approve(run, 'spec-eval').status, 'approved');
});

test('an exhausted revision loop asks the user (budget restarts) instead of halting', () => {
  const run = newRun(120, 10, 10, { maxEvalCycles: 2 });
  start(run, 'spec-eval');
  assert.equal(L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'revise' }).status, 'revise');
  start(run, 'spec-eval');
  const r = L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'revise', summary: 'scope unclear' });
  assert.equal(r.nextAction, 'ask_user');
  assert.equal(run.halted, false);
  assert.match(L.openQuestions(run)[0], /still requests revisions after 2 cycles: scope unclear/);
  assert.equal(run.steps['spec-eval'].cycles, 0);
});

test('events are per step, so parallel agents each keep their own message', () => {
  const run = L2();
  passThroughImplementation(run);
  start(run, 'documentation');
  start(run, 'testing');
  L.recordReport(run, 'documentation', { decision: 'draft' });
  L.recordReport(run, 'testing', { decision: 'draft', verdict: 'approve' });
  assert.equal(L.lastEventFor(run, 'documentation').status, 'approved');
  assert.equal(L.lastEventFor(run, 'testing').status, 'approved');
});

test('delivery needs approved steps and a passing verification of exactly this content', () => {
  const run = L2();
  assert.match(L.markDelivered(run, { treeHash: 'a' }).reason, /'spec-eval' is 'pending'/);
  passThroughImplementation(run);
  approve(run, 'documentation');
  approve(run, 'testing');
  assert.match(L.markDelivered(run, { treeHash: 'a' }).reason, /no verification/);
  run.verification = { treeHash: 'a', configured: true, passed: false, manual: [] };
  assert.match(L.markDelivered(run, { treeHash: 'a' }).reason, /failed/);
  run.verification = { treeHash: 'a', configured: true, passed: true, manual: ['ATF suite'] };
  assert.match(L.markDelivered(run, { treeHash: 'b' }).reason, /changed since/);
  const ok = L.markDelivered(run, { treeHash: 'a', pr: 'https://x/pr/1' });
  assert.equal(ok.ok, true);
  assert.equal(run.completed, true);
  assert.deepEqual(run.delivery.unverified, ['ATF suite']);
});

test('unconfigured verification may deliver, but is reported as unverified', () => {
  const run = L1();
  approve(run, 'implementation');
  approve(run, 'documentation');
  approve(run, 'testing');
  run.verification = { treeHash: 'a', configured: false, passed: false, manual: [] };
  assert.equal(L.markDelivered(run, { treeHash: 'a' }).ok, true);
  assert.match(run.delivery.unverified[0], /No automated verification/);
});

test('parseDecisionBlock reads the last block, tolerates fences, rejects junk', () => {
  assert.deepEqual(L.parseDecisionBlock('x <decision>{"decision":"draft"}</decision> y <decision>{"decision":"decline"}</decision>'), { decision: 'decline' });
  assert.deepEqual(L.parseDecisionBlock('<decision>\n```json\n{"decision":"draft"}\n```\n</decision>'), { decision: 'draft' });
  assert.equal(L.parseDecisionBlock('<decision>not json</decision>'), null);
  assert.equal(L.parseDecisionBlock('no block'), null);
});
