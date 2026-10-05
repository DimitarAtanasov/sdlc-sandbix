'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, gitRepo, write, run, json } = require('./helpers');

function setup(files = { 'README.md': 'hello\n' }) {
  return { repo: gitRepo(files), data: tmpDir('oe-data-') };
}

function orchestrate({ repo, data }, task, sid = 'sess-1', extra = {}) {
  const out = run('compute-complexity.js', {
    args: ['--json', task],
    env: { CLAUDE_PROJECT_DIR: repo, CLAUDE_PLUGIN_DATA: data, CLAUDE_SESSION_ID: sid, ...extra },
  });
  assert.equal(out.status, 0, out.stderr);
  return json(out);
}

const gate = (ctx, toolInput, sid = 'sess-1') =>
  json(run('enforce-gate.js', { input: { session_id: sid, tool_input: toolInput }, env: { CLAUDE_PLUGIN_DATA: ctx.data } }));
const stop = (ctx, agentType, message, sid = 'sess-1', agentId = 'a1') =>
  run('record-step.js', { input: { session_id: sid, agent_type: agentType, agent_id: agentId, last_assistant_message: message }, env: { CLAUDE_PLUGIN_DATA: ctx.data } });
const post = (ctx, toolInput, sid = 'sess-1') =>
  json(run('post-agent.js', { input: { session_id: sid, tool_input: toolInput }, env: { CLAUDE_PLUGIN_DATA: ctx.data } }));
const decision = (obj) => `done.\n<decision>${JSON.stringify(obj)}</decision>`;
const call = (type) => ({ subagent_type: type, description: `run ${type}` });

test('tiny task lands on level 1 and persists per session', () => {
  const ctx = setup();
  const res = orchestrate(ctx, 'Fix a typo in the README');
  assert.equal(res.matrix.level, 1);
  assert.equal(res.sessionId, 'sess-1');
  assert.ok(fs.existsSync(path.join(ctx.data, 'sessions', 'sess-1', 'decision.json')));
  assert.ok(fs.existsSync(path.join(ctx.data, 'sessions', 'sess-1', 'run.json')));
});

test('gate ignores non-SDLC agents', () => {
  const ctx = setup();
  orchestrate(ctx, 'Fix a typo in the README');
  const out = run('enforce-gate.js', { input: { session_id: 'sess-1', tool_input: { subagent_type: 'Explore', description: 'find the file' } }, env: { CLAUDE_PLUGIN_DATA: ctx.data } });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

test('level 1: gate denies design/eval, allows implementation with the haiku model', () => {
  const ctx = setup();
  orchestrate(ctx, 'Fix a typo in the README');
  const denied = gate(ctx, call('tech-design-agent'));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /skipped/);
  const ok = gate(ctx, call('implementation-agent'));
  assert.equal(ok.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(ok.hookSpecificOutput.updatedInput.model, 'haiku');
  const kept = gate(ctx, { ...call('implementation-agent'), model: 'sonnet' });
  assert.equal(kept.hookSpecificOutput.updatedInput.model, 'sonnet');
});

test('sessions are isolated: another session has no decision and only gets a reminder', () => {
  const ctx = setup();
  orchestrate(ctx, 'Fix a typo in the README', 'sess-1');
  const other = gate(ctx, call('implementation-agent'), 'sess-2').hookSpecificOutput;
  assert.equal(other.permissionDecision, undefined);
  assert.match(other.additionalContext, /Run \/sdlc/);
});

test('decision made without a session id is found via the default slot', () => {
  const ctx = setup();
  orchestrate(ctx, 'Fix a typo in the README', '');
  const ok = gate(ctx, call('implementation-agent'), 'sess-9');
  assert.equal(ok.hookSpecificOutput.permissionDecision, 'allow');
});

test('stale decisions are ignored', () => {
  const ctx = setup();
  orchestrate(ctx, 'Fix a typo in the README');
  const old = new Date(Date.now() - 7 * 3_600_000).toISOString();
  for (const [name, key] of [['decision.json', 'computedAt'], ['run.json', 'updatedAt']]) {
    const file = path.join(ctx.data, 'sessions', 'sess-1', name);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    d[key] = old;
    fs.writeFileSync(file, JSON.stringify(d));
  }
  const out = gate(ctx, call('implementation-agent')).hookSpecificOutput;
  assert.equal(out.permissionDecision, undefined);
  assert.match(out.additionalContext, /no fresh complexity decision/);
});

test('level 2 end to end: gating, SubagentStop recording, PostToolUse guidance', () => {
  const ctx = setup({ 'src/Api.cs': 'using System;\nclass Api {}\n', 'specs/api.md': 'Scripted REST API payload validation for request fields on the Api class.' });
  const task = 'Add payload validation for request fields to the scripted REST API in src/Api.cs and keep the existing error codes and behaviour for all callers of the Api class working';
  write(ctx.repo, 'src/Api.cs', 'using System;\nclass Api {\n' + '  void M() {}\n'.repeat(12) + '}\n'); // diff mode, sizeable change
  const res = orchestrate(ctx, task);
  assert.equal(res.matrix.level, 2, `M=${res.complexity.magnitude}`);

  assert.equal(gate(ctx, call('implementation-agent')).hookSpecificOutput.permissionDecision, 'deny'); // sequential gating
  assert.equal(gate(ctx, call('spec-eval-agent')).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(stop(ctx, 'spec-eval-agent', decision({ decision: 'draft', verdict: 'approve', confidence: 0.9 })).status, 0);
  assert.match(post(ctx, call('spec-eval-agent')).hookSpecificOutput.additionalContext, /spec-eval' -> approved.*Next stage: tech-design/);

  gate(ctx, call('tech-design-agent'));
  stop(ctx, 'tech-design-agent', decision({ decision: 'draft', confidence: 0.9 }), 'sess-1', 'a2');
  gate(ctx, call('tech-design-eval-agent'));
  stop(ctx, 'tech-design-eval-agent', decision({ decision: 'draft', verdict: 'revise', summary: 'no error handling' }), 'sess-1', 'a3');
  assert.match(post(ctx, call('tech-design-eval-agent')).hookSpecificOutput.additionalContext, /Re-run step 'tech-design'/);
  assert.equal(gate(ctx, call('implementation-agent')).hookSpecificOutput.permissionDecision, 'deny');
});

test('SubagentStop blocks once when the decision block is missing, then records an implicit draft', () => {
  const ctx = setup();
  orchestrate(ctx, 'Fix a typo in the README');
  gate(ctx, call('implementation-agent'));
  const first = json(stop(ctx, 'implementation-agent', 'all done, no block'));
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /<decision>/);
  const second = stop(ctx, 'implementation-agent', 'still no block');
  assert.equal(second.stdout, '');
  const status = run('lifecycle.js', { args: ['status', '--json'], env: { CLAUDE_PLUGIN_DATA: ctx.data, CLAUDE_SESSION_ID: 'sess-1' } });
  assert.equal(json(status).steps.implementation.status, 'approved');
});

test('requireDecisionBlock=false skips the block and records implicitly', () => {
  const ctx = setup();
  orchestrate(ctx, 'Fix a typo in the README');
  gate(ctx, call('implementation-agent'));
  const out = run('record-step.js', {
    input: { session_id: 'sess-1', agent_type: 'implementation-agent', agent_id: 'x', last_assistant_message: 'done' },
    env: { CLAUDE_PLUGIN_DATA: ctx.data, CLAUDE_PLUGIN_OPTION_requireDecisionBlock: 'false' },
  });
  assert.equal(out.stdout, '');
});

test('lifecycle CLI: status, record, clarified, reset', () => {
  const ctx = setup();
  orchestrate(ctx, 'Fix a typo in the README');
  const env = { CLAUDE_PLUGIN_DATA: ctx.data, CLAUDE_SESSION_ID: 'sess-1' };
  assert.match(run('lifecycle.js', { args: ['status'], env }).stdout, /Level 1/);
  const rec = run('lifecycle.js', { args: ['record', 'implementation', '--decision', 'draft'], env });
  assert.match(rec.stdout, /implementation -> approved; next: run:documentation\|testing/);
  assert.equal(run('lifecycle.js', { args: ['record', 'bogus', '--decision', 'draft'], env }).status, 1);
  assert.match(run('lifecycle.js', { args: ['clarified'], env }).stdout, /clarified/);
  run('lifecycle.js', { args: ['reset'], env });
  assert.match(run('lifecycle.js', { args: ['status'], env }).stdout, /implementation\s+pending/);
});

test('lifecycle CLI without a decision fails clearly', () => {
  const out = run('lifecycle.js', { args: ['status'], env: { CLAUDE_PLUGIN_DATA: tmpDir(), CLAUDE_SESSION_ID: 'none' } });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /Run \/sdlc/);
});

test('SessionStart mirrors session id, data dir and options into the Bash env file', () => {
  const envFile = path.join(tmpDir(), 'env.sh');
  run('session-start.js', {
    input: { session_id: 'abc-123; rm -rf /' },
    env: { CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: "/d/it's", CLAUDE_PLUGIN_OPTION_tier1Model: 'fable' },
  });
  const out = fs.readFileSync(envFile, 'utf8');
  assert.match(out, /^export CLAUDE_SESSION_ID=abc-123rm-rf$/m);
  assert.match(out, /^export OE_PLUGIN_DATA='\/d\/it'\\''s'$/m);
  assert.match(out, /^export OE_OPTION_tier1Model='fable'$/m);
});

test('CLI and hooks agree on the data dir when only OE_PLUGIN_DATA is set (Bash tool case)', () => {
  const ctx = setup();
  const out = run('compute-complexity.js', {
    args: ['--json', 'Fix a typo in the README'],
    env: { CLAUDE_PROJECT_DIR: ctx.repo, OE_PLUGIN_DATA: ctx.data, CLAUDE_SESSION_ID: 'sess-1', OE_OPTION_tier3Model: 'fable', CLAUDE_PLUGIN_DATA: '' },
  });
  assert.equal(json(out).matrix.modelTier.model, 'fable');
  assert.equal(gate(ctx, call('implementation-agent')).hookSpecificOutput.updatedInput.model, 'fable');
});
