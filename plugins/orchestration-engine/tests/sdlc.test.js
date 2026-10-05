'use strict';

// Integration tests for the full-SDLC pieces: concurrency, generic agents,
// gating scope, verification, stop gate, delivery, lessons, setup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir, gitRepo, write, run, runAsync, json } = require('./helpers');

function setup(files = { 'README.md': 'hello\n' }) {
  return { repo: gitRepo(files), data: tmpDir('oe-data-') };
}
const env = (c, sid = 's1', extra = {}) => ({ CLAUDE_PROJECT_DIR: c.repo, CLAUDE_PLUGIN_DATA: c.data, CLAUDE_SESSION_ID: sid, ...extra });
const orchestrate = (c, task, args = [], sid = 's1', extra = {}) => {
  const out = run('compute-complexity.js', { args: ['--json', ...args, task], env: env(c, sid, extra) });
  assert.equal(out.status, 0, out.stderr);
  return json(out);
};
const gate = (c, toolInput, sid = 's1') => {
  const out = run('enforce-gate.js', { input: { session_id: sid, cwd: c.repo, tool_input: toolInput }, env: { CLAUDE_PLUGIN_DATA: c.data } });
  return out.stdout ? json(out).hookSpecificOutput : null;
};
const stop = (c, agentType, message, agentId = 'a1', sid = 's1') =>
  run('record-step.js', { input: { session_id: sid, agent_type: agentType, agent_id: agentId, last_assistant_message: message }, env: { CLAUDE_PLUGIN_DATA: c.data } });
const decision = (obj) => `done.\n<decision>${JSON.stringify(obj)}</decision>`;
const call = (type, extra = {}) => ({ subagent_type: type, description: `run ${type}`, prompt: 'do the thing', ...extra });
const lc = (c, ...args) => run('lifecycle.js', { args, env: env(c) });
const runState = (c, sid = 's1') => JSON.parse(fs.readFileSync(path.join(c.data, 'sessions', sid, 'run.json'), 'utf8'));
const stopGate = (c, over = {}, sid = 's1') => {
  const out = run('stop-gate.js', { input: { session_id: sid, prompt_id: 'p1', last_assistant_message: 'All done.', ...over }, env: { CLAUDE_PLUGIN_DATA: c.data } });
  return out.stdout ? json(out) : null;
};
const passingVerify = (c) => write(c.repo, '.sdlc/verify.json', JSON.stringify({ commands: [{ name: 'ok', cmd: 'true' }] }));

test('parallel subagents finishing together do not overwrite each other (lock)', async () => {
  for (let round = 0; round < 4; round++) {
    const c = setup();
    orchestrate(c, 'Fix a typo in the README', [], `par${round}`);
    const sid = `par${round}`;
    for (const step of ['implementation']) {
      gate(c, call(`${step}-agent`), sid);
      stop(c, `${step}-agent`, decision({ decision: 'draft' }), 'a0', sid);
    }
    gate(c, call('documentation-agent'), sid);
    gate(c, call('testing-agent'), sid);
    const results = await Promise.all([
      runAsync('record-step.js', { input: { session_id: sid, agent_type: 'documentation-agent', agent_id: 'd', last_assistant_message: decision({ decision: 'draft' }) }, env: { CLAUDE_PLUGIN_DATA: c.data } }),
      runAsync('record-step.js', { input: { session_id: sid, agent_type: 'testing-agent', agent_id: 't', last_assistant_message: decision({ decision: 'draft', verdict: 'approve' }) }, env: { CLAUDE_PLUGIN_DATA: c.data } }),
    ]);
    assert.ok(results.every((r) => r.status === 0));
    const state = runState(c, sid);
    assert.equal(state.steps.documentation.status, 'approved', `round ${round}`);
    assert.equal(state.steps.testing.status, 'approved', `round ${round}`);
    assert.equal(state.events.filter((e) => e.nextAction).length >= 3, true);
  }
});

test('a generic agent that did a pipeline step is recorded against the single running generic step', () => {
  const c = setup();
  orchestrate(c, 'Fix a typo in the README');
  const gen = { subagent_type: 'general-purpose', description: 'Write tests for the change', prompt: 'x' };
  gate(c, call('implementation-agent'));
  stop(c, 'implementation-agent', decision({ decision: 'draft' }));
  assert.equal(gate(c, gen).permissionDecision, 'allow');
  assert.equal(runState(c).steps.testing.generic, true);
  stop(c, 'general-purpose', decision({ decision: 'draft', verdict: 'approve' }), 'g1');
  assert.equal(runState(c).steps.testing.status, 'approved');
});

test('generic agents in parallel are ambiguous: nothing is guessed', () => {
  const c = setup();
  orchestrate(c, 'Fix a typo in the README');
  gate(c, call('implementation-agent'));
  stop(c, 'implementation-agent', decision({ decision: 'draft' }));
  gate(c, { subagent_type: 'general-purpose', description: 'Write tests', prompt: 'x' });
  gate(c, { subagent_type: 'general-purpose', description: 'Update the docs', prompt: 'x' });
  stop(c, 'general-purpose', decision({ decision: 'draft' }), 'g1');
  const s = runState(c);
  assert.equal(s.steps.testing.status, 'running');
  assert.equal(s.steps.documentation.status, 'running');
});

test('the gate ignores non-pipeline agents even after a halt, and non-pipeline words', () => {
  const c = setup();
  orchestrate(c, 'Fix a typo in the README');
  lc(c, 'record', 'implementation', '--decision', 'draft'); // run in progress
  const file = path.join(c.data, 'sessions', 's1', 'run.json');
  const r = runState(c);
  r.halted = true;
  r.haltReason = 'test halt';
  fs.writeFileSync(file, JSON.stringify(r));
  assert.equal(gate(c, { subagent_type: 'Explore', description: 'find the tests', prompt: 'x' }), null);
  assert.equal(gate(c, { subagent_type: 'general-purpose', description: 'Inspect the docker image', prompt: 'x' }), null);
  assert.equal(gate(c, call('testing-agent')).permissionDecision, 'deny');
});

test('a review step that never reports a verdict is NOT approved by default', () => {
  const c = setup({ 'README.md': 'x\n' });
  // Level 1 deliberately auto-approves (ask/decline are disabled there), so force Level 2.
  const res = orchestrate(c, 'Fix a typo in the README', ['--hotfix'], 's1', { CLAUDE_PLUGIN_OPTION_specDistanceWeight: '100' });
  assert.equal(res.matrix.level, 2);
  gate(c, call('implementation-agent'));
  stop(c, 'implementation-agent', decision({ decision: 'draft' }));
  gate(c, call('testing-agent'));
  const first = stop(c, 'testing-agent', 'tests look fine');
  assert.equal(json(first).decision, 'block');
  stop(c, 'testing-agent', 'still no block');
  const s = runState(c);
  assert.equal(s.steps.testing.status, 'needs_clarification');
  assert.match(s.steps.testing.questions[0], /no decision block/);
});

test('lifecycle CLI: override and a halt that can be undone', () => {
  const c = setup();
  orchestrate(c, 'Fix a typo in the README');
  const r = runState(c);
  r.halted = true;
  r.haltReason = 'decline gate';
  fs.writeFileSync(path.join(c.data, 'sessions', 's1', 'run.json'), JSON.stringify(r));
  assert.equal(lc(c, 'override').status, 1);
  assert.match(lc(c, 'override').stderr, /needs a reason/);
  assert.equal(lc(c, 'override', '--reason', 'the ceiling is too low for this repo').status, 0);
  assert.equal(runState(c).halted, false);
  assert.equal(runState(c).overrides.length, 1);
});

test('hotfix: design/eval skipped regardless of level; testing still required', () => {
  const c = setup();
  const res = orchestrate(c, 'Fix a typo in the README', ['--hotfix']);
  assert.equal(res.hotfix, true);
  assert.equal(gate(c, call('tech-design-agent')).permissionDecision, 'deny');
  assert.match(gate(c, call('tech-design-agent')).permissionDecisionReason, /Hotfix/);
  assert.equal(runState(c).steps.testing.status, 'pending');
});

test('verify: pass, fail, manual checks, unconfigured, evidence recorded in the run', () => {
  const c = setup({ 'README.md': 'x\n' });
  orchestrate(c, 'Fix a typo in the README');
  let out = run('verify.js', { args: ['run'], env: env(c) });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /NOT CONFIGURED/);
  assert.equal(runState(c).verification.configured, false);

  write(c.repo, '.sdlc/verify.json', JSON.stringify({ commands: [{ name: 'ok', cmd: 'echo fine' }, { name: 'ATF', manual: true, note: 'Run the NeedIt ATF suite' }] }));
  out = run('verify.js', { args: ['run'], env: env(c) });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /PASSED/);
  assert.match(out.stdout, /manual \(unverified here\): Run the NeedIt ATF suite/);
  const v = runState(c).verification;
  assert.equal(v.passed, true);
  assert.deepEqual(v.manual, ['Run the NeedIt ATF suite']);

  write(c.repo, '.sdlc/verify.json', JSON.stringify({ commands: [{ name: 'bad', cmd: 'echo boom >&2; exit 3' }] }));
  out = run('verify.js', { args: ['run'], env: env(c) });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /FAIL bad\s+exit=3/);
  assert.match(out.stdout, /boom/);
  assert.equal(runState(c).verification.passed, false);
});

test('treeHash is stable across a commit, changes with content, and ignores .sdlc/', () => {
  const { treeHash } = require('../scripts/lib/verify');
  const c = setup({ 'a.txt': '1\n' });
  write(c.repo, 'a.txt', '2\n');
  const before = treeHash(c.repo);
  execFileSync('git', ['-C', c.repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'change']);
  assert.equal(treeHash(c.repo), before, 'committing the same content must not change the hash');
  write(c.repo, '.sdlc/history.jsonl', 'x\n');
  assert.equal(treeHash(c.repo), before);
  write(c.repo, 'a.txt', '3\n');
  assert.notEqual(treeHash(c.repo), before);
});

test('deliver is refused until verification is fresh and passing, then completes and logs history', () => {
  const c = setup();
  orchestrate(c, 'Fix a typo in the README');
  lc(c, 'record', 'implementation', '--decision', 'draft');
  lc(c, 'record', 'documentation', '--decision', 'draft');
  const tests = lc(c, 'record', 'testing', '--decision', 'draft', '--verdict', 'approve');
  assert.match(tests.stdout, /next: deliver/);
  assert.match(lc(c, 'deliver', '--pr', 'https://x/pr/1').stderr, /no verification/);
  passingVerify(c);
  assert.equal(run('verify.js', { args: ['run'], env: env(c) }).status, 0);
  write(c.repo, 'README.md', 'changed after verification\n');
  assert.match(lc(c, 'deliver', '--pr', 'https://x/pr/1').stderr, /changed since it was verified/);
  assert.equal(run('verify.js', { args: ['run'], env: env(c) }).status, 0);
  const ok = lc(c, 'deliver', '--pr', 'https://x/pr/1', '--branch', 'sdlc/typo');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Run complete/);
  assert.equal(runState(c).completed, true);
  const hist = fs.readFileSync(path.join(c.repo, '.sdlc', 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(hist.at(-1).outcome, 'completed');
});

test('stop gate: blocks an unverified finish once per turn, never blocks legitimate stops', () => {
  const c = setup();
  assert.equal(stopGate(c), null, 'no run -> allow');
  orchestrate(c, 'Fix a typo in the README');
  assert.equal(stopGate(c), null, 'nothing started -> allow');

  gate(c, call('implementation-agent'));
  stop(c, 'implementation-agent', decision({ decision: 'draft' }));

  const blocked = stopGate(c);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /nothing has been verified/);
  assert.match(blocked.reason, /next action: run:documentation\|testing/);
  assert.equal(stopGate(c), null, 'second stop in the same turn is allowed');
  assert.equal(stopGate(c, { prompt_id: 'p2' }).decision, 'block', 'a new turn is checked again');

  assert.equal(stopGate(c, { prompt_id: 'p3', stop_hook_active: true }), null);
  assert.equal(stopGate(c, { prompt_id: 'p4', last_assistant_message: 'Should I open the PR now?' }), null, 'waiting for the user');
});

test('stop gate: open questions, halted and completed runs are allowed', () => {
  const c = setup();
  orchestrate(c, 'Fix a typo in the README');
  gate(c, call('implementation-agent'));
  stop(c, 'implementation-agent', decision({ decision: 'draft' }));
  const file = path.join(c.data, 'sessions', 's1', 'run.json');
  const base = runState(c);

  const withQuestions = JSON.parse(JSON.stringify(base));
  withQuestions.steps.documentation.status = 'needs_clarification';
  withQuestions.steps.documentation.questions = ['Which audience?'];
  fs.writeFileSync(file, JSON.stringify(withQuestions));
  assert.equal(stopGate(c, { prompt_id: 'q' }), null);

  for (const patch of [{ halted: true, haltReason: 'x' }, { completed: true }]) {
    fs.writeFileSync(file, JSON.stringify({ ...base, ...patch }));
    assert.equal(stopGate(c, { prompt_id: 'h' + JSON.stringify(patch) }), null);
  }
});

test('stop gate: stale verification (code changed after verify) blocks; fresh verification passes through', () => {
  const c = setup();
  orchestrate(c, 'Fix a typo in the README');
  for (const [step, extra] of [['implementation', []], ['documentation', []], ['testing', ['--verdict', 'approve']]]) lc(c, 'record', step, '--decision', 'draft', ...extra);
  passingVerify(c);
  run('verify.js', { args: ['run'], env: env(c) });
  write(c.repo, 'README.md', 'edited after verify\n');
  const stale = stopGate(c, { prompt_id: 's1' });
  assert.match(stale.reason, /changed since it was last verified/);
  run('verify.js', { args: ['run'], env: env(c) });
  // all agent steps approved + fresh verification: only the human delivery checkpoint is left -> stopping is fine
  assert.equal(stopGate(c, { prompt_id: 's2' }), null);
});

test('lessons: capped, deduped, removable; injected into sessions and subagent prompts', () => {
  const lessons = require('../scripts/lib/lessons');
  const c = setup();
  assert.equal(lessons.add(c.repo, 'Run ATF before opening a PR', 'missed twice').ok, true);
  assert.equal(lessons.add(c.repo, 'run ATF before opening a PR!').ok, false, 'dedupe ignores case/punctuation');
  assert.equal(lessons.add(c.repo, 'x'.repeat(201)).ok, false);
  for (let i = 0; lessons.list(c.repo).length < lessons.MAX_LESSONS && i < 60; i++) lessons.add(c.repo, `rule number ${i}`);
  const full = lessons.add(c.repo, 'one more rule that must not fit');
  assert.equal(full.ok, false);
  assert.match(full.reason, /full/);
  assert.equal(lessons.remove(c.repo, 1).ok, true);
  assert.equal(lessons.remove(c.repo, 999).ok, false);

  const fresh = setup();
  assert.equal(lessons.injection(fresh.repo), '');
  lessons.add(fresh.repo, 'Never log full payloads from the NeedIt endpoint', 'PII incident');

  const start = run('session-start.js', { input: { session_id: 'abc', cwd: fresh.repo }, env: { CLAUDE_PLUGIN_DATA: fresh.data } });
  assert.match(json(start).hookSpecificOutput.additionalContext, /Never log full payloads/);
  assert.equal(run('session-start.js', { input: { session_id: 'abc', cwd: c.repo.replace(/.$/, 'x') }, env: {} }).stdout, '');

  orchestrate(fresh, 'Fix a typo in the README');
  const g = gate(fresh, call('implementation-agent'));
  assert.match(g.updatedInput.prompt, /^do the thing\n\nProject lessons/);
  assert.match(g.updatedInput.prompt, /Never log full payloads/);
  const off = run('enforce-gate.js', { input: { session_id: 's1', cwd: fresh.repo, tool_input: call('implementation-agent') }, env: { CLAUDE_PLUGIN_DATA: fresh.data, CLAUDE_PLUGIN_OPTION_injectLessons: 'false' } });
  assert.doesNotMatch(JSON.stringify(json(off).hookSpecificOutput.updatedInput.prompt), /Project lessons/);
});

test('lessons CLI: add / list / remove, with the cap explained', () => {
  const c = setup();
  const l = (...args) => run('lessons.js', { args, env: { CLAUDE_PROJECT_DIR: c.repo } });
  assert.match(l('list').stdout, /No lessons yet/);
  assert.equal(l('add', 'Pin the Kafka client version', '--why', 'rebalance bug').status, 0);
  assert.match(l('list').stdout, /1\. Pin the Kafka client version \(why: rebalance bug\)/);
  assert.equal(l('remove', '1').status, 0);
  assert.equal(l('remove', '1').status, 1);
});

test('setup: writes settings (merged), verify config and lessons; idempotent; --print writes nothing', () => {
  const c = setup({ 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }), '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(git status)'] }, enabledPlugins: { 'other@m': true } }) });
  const printed = run('setup.js', { args: ['--print'], env: { CLAUDE_PROJECT_DIR: c.repo } });
  assert.match(printed.stdout, /would write/);
  assert.equal(fs.existsSync(path.join(c.repo, '.sdlc')), false);

  const out = run('setup.js', { env: { CLAUDE_PROJECT_DIR: c.repo } });
  assert.equal(out.status, 0, out.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(c.repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Bash(git status)'], 'existing keys kept');
  assert.equal(settings.enabledPlugins['other@m'], true);
  assert.equal(settings.enabledPlugins['orchestration-engine@sdlc-sandbix'], true);
  assert.equal(settings.enabledPlugins['sdlc-agents@sdlc-sandbix'], true);
  assert.equal(settings.extraKnownMarketplaces['sdlc-sandbix'].source.repo, 'DimitarAtanasov/sdlc-sandbix');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.repo, '.sdlc', 'verify.json'), 'utf8')).commands[0].cmd, 'npm test');
  assert.ok(fs.existsSync(path.join(c.repo, '.sdlc', 'lessons.md')));
  assert.match(run('setup.js', { env: { CLAUDE_PROJECT_DIR: c.repo } }).stdout, /Already set up/);
});

test('.sdlc/ files do not count as the task\'s change in complexity scoring', () => {
  const c = setup({ 'a.cs': 'class A {}\n' });
  write(c.repo, '.sdlc/lessons.md', '# Lessons\n- x\n');
  write(c.repo, '.sdlc/history.jsonl', '{}\n');
  const res = orchestrate(c, 'Fix a typo in the README');
  assert.equal(res.complexity.inputs.mode, 'estimate');
});
