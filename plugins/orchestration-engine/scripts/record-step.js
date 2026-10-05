#!/usr/bin/env node
'use strict';

// SubagentStop hook. When an SDLC pipeline agent finishes, parse the
// <decision>{...}</decision> block from its final message and apply it to the
// lifecycle run (draft / ask_clarification / decline, with per-level policy).
//  - Missing block + requireDecisionBlock: the subagent is blocked from
//    stopping once so it can append the block.
//  - Still missing: a producer step is recorded as an implicit draft (so a
//    foreign agent cannot deadlock the pipeline); a REVIEW step is NOT approved
//    by default - it becomes ask_clarification so a human looks.
//  - Generic agents (general-purpose, ...) are matched to the single generic
//    step currently running; if that is ambiguous nothing is recorded and the
//    orchestrator uses `sdlc-lifecycle record`.

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
  const agentType = String(input.agent_type || '').replace(/^.*:/, '');
  const named = lifecycle.stepFor(agentType);
  if (!named && !lifecycle.isGenericAgent(agentType)) process.exit(0);

  const config = loadConfig();
  const found = store.locate(input.session_id, config.decisionTtlHours);
  if (!found) process.exit(0);
  const { sid } = found;
  const agentKey = String(input.agent_id || 'anon');
  const parsed = lifecycle.parseDecisionBlock(input.last_assistant_message);
  let blockReason = null;

  store.updateRun(sid, (run) => {
    if (!run) return store.SKIP_SAVE;
    let step = named;
    if (!step) {
      const candidates = lifecycle.AGENT_STEPS.filter((s) => run.steps[s].status === 'running' && run.steps[s].generic);
      if (candidates.length !== 1) return store.SKIP_SAVE;
      step = candidates[0];
    }
    const st = run.steps[step];
    if (st.status !== 'running') return store.SKIP_SAVE;

    let report = parsed;
    if (!report) {
      if (config.requireDecisionBlock && st.promptedFor !== agentKey) {
        st.promptedFor = agentKey;
        blockReason =
          'Pipeline contract: end your reply with a block like ' +
          '<decision>{"decision":"draft|ask_clarification|decline","confidence":0.0-1.0,' +
          '"verdict":"approve|revise","missing_info":[],"summary":"..."}</decision>. ' +
          '"verdict" applies to review steps (spec-eval, tech-design-eval, testing).';
        return undefined; // save promptedFor
      }
      report = lifecycle.REVIEW_STEPS.has(step)
        ? { decision: 'ask_clarification', missing_info: [`'${step}' returned no decision block, so its verdict is unknown. Re-run it, or review its output yourself and use: sdlc-lifecycle record ${step} --decision draft --verdict approve|revise`] }
        : { decision: 'draft', summary: 'implicit (no decision block reported)' };
    }
    lifecycle.recordReport(run, step, report);
    history.closeIfFinished(sid, run);
    return undefined;
  });

  if (blockReason) process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason }));
}

main();
