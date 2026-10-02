#!/usr/bin/env node
'use strict';

// SubagentStop hook. When an SDLC pipeline agent finishes, parse the
// <decision>{...}</decision> block from its final message and apply it to the
// lifecycle run (draft / ask_clarification / decline, with per-level policy).
// If the block is missing and requireDecisionBlock is on, the subagent is
// blocked from stopping once so it can append the block; a second miss is
// recorded as an implicit draft so a foreign agent can't deadlock the pipeline.

const fs = require('node:fs');
const { load: loadConfig } = require('./lib/config');
const store = require('./lib/store');
const lifecycle = require('./lib/lifecycle');
const history = require('./lib/history');

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  const step = lifecycle.stepFor(String(input.agent_type || '').replace(/^.*:/, ''));
  if (!step) process.exit(0);

  const config = loadConfig();
  const found = store.locate(input.session_id, config.decisionTtlHours);
  if (!found) process.exit(0);

  const { sid } = found;
  const run = store.loadRun(sid);
  if (!run || run.steps[step].status !== 'running') process.exit(0);

  let report = lifecycle.parseDecisionBlock(input.last_assistant_message);
  if (!report) {
    const st = run.steps[step];
    if (config.requireDecisionBlock && st.promptedFor !== input.agent_id) {
      st.promptedFor = input.agent_id;
      store.saveRun(sid, run);
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason:
          'Pipeline contract: end your reply with a block like ' +
          '<decision>{"decision":"draft|ask_clarification|decline","confidence":0.0-1.0,' +
          '"verdict":"approve|revise","missing_info":[],"summary":"..."}</decision>. ' +
          '"verdict" applies to eval steps only.',
      }));
      process.exit(0);
    }
    report = { decision: 'draft', verdict: 'approve', summary: 'implicit (no decision block reported)' };
  }

  lifecycle.recordReport(run, step, report);
  history.closeIfFinished(sid, run);
  store.saveRun(sid, run);
}

main();
