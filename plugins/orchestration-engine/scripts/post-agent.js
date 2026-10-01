#!/usr/bin/env node
'use strict';

// PostToolUse hook for the Agent tool. After a pipeline agent returns, tell
// the orchestrating session what the lifecycle recorded and what to do next
// (ask the user, rerun a step, run the next stage, abort, or done).

const fs = require('node:fs');
const { load: loadConfig } = require('./lib/config');
const store = require('./lib/store');
const lifecycle = require('./lib/lifecycle');

function describe(next, run) {
  if (next === 'ask_user') {
    const qs = run.pendingQuestions.length ? ` Questions: ${run.pendingQuestions.join(' | ')}` : '';
    return `Ask the user to resolve the open questions before continuing.${qs} Then re-run the same step.`;
  }
  if (next === 'abort') return `Stop. Tell the user why: ${run.haltReason}`;
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
  const ev = run && run.lastEvent;
  if (!ev || ev.step !== step) process.exit(0);

  const coerced = ev.coerced.length ? ` Engine adjustments: ${ev.coerced.join(' ')}` : '';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `orchestration-engine lifecycle: '${step}' -> ${ev.status}.${coerced} ${describe(ev.nextAction, run)}`,
    },
  }));
}

main();
