#!/usr/bin/env node
'use strict';

// PostToolUse hook for the Agent tool. After a pipeline agent returns, tell
// the orchestrating session what the lifecycle recorded and what to do next
// (ask the user, rerun a step, run the next stage, verify/deliver, abort, done).
// Events are per step, so parallel agents each get their own message.

const fs = require('node:fs');
const { load: loadConfig } = require('./lib/config');
const store = require('./lib/store');
const lifecycle = require('./lib/lifecycle');

function describe(next, run, step) {
  if (next === 'ask_user') {
    const qs = lifecycle.openQuestions(run);
    return `Ask the user to resolve the open questions before continuing.${qs.length ? ` Questions: ${qs.join(' | ')}` : ''} Then re-run the same step.`;
  }
  if (next === 'abort') return `Stop. Tell the user why: ${run.haltReason}. They can override with: sdlc-lifecycle override --reason "<why>".`;
  if (next === 'deliver') return 'All agent steps are approved. Run verification (sdlc-verify run), then deliver (commit, push, draft PR) after the user approves.';
  if (next === 'done') return 'Pipeline complete. Summarize results for the user.';
  if (next.startsWith('rerun:')) return `Re-run step '${next.slice(6)}' (revision / extra isolation cycle required).`;
  if (next.startsWith('run:')) return `Next stage: ${next.slice(4).split('|').join(' and/or ')}.`;
  return next;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  const step = lifecycle.stepForCall(input.tool_input || {});
  if (!step) process.exit(0);

  const found = store.locate(input.session_id, loadConfig().decisionTtlHours);
  if (!found) process.exit(0);
  const run = store.loadRun(found.sid);
  if (!run) process.exit(0);

  let text;
  if (run.steps[step].status === 'running') {
    text = `'${step}' finished but no decision was recorded. Record it yourself: sdlc-lifecycle record ${step} --decision draft|ask_clarification|decline [--verdict approve|revise]`;
  } else {
    const ev = lifecycle.lastEventFor(run, step);
    if (!ev) process.exit(0);
    const coerced = ev.coerced.length ? ` Engine adjustments: ${ev.coerced.join(' ')}` : '';
    text = `'${step}' -> ${ev.status}.${coerced} ${describe(ev.nextAction, run, step)}`;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `orchestration-engine lifecycle: ${text}` } }));
}

main();
