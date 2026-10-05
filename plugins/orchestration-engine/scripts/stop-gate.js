#!/usr/bin/env node
'use strict';

// Stop hook: verification before "done" for the main session. While a
// pipeline run is in progress, Claude may not simply stop:
//   - if the pipeline has a pending agent step to run or re-run, or
//   - if implementation is approved but the CURRENT code has no verification
//     record (never run, or the code changed since it ran),
// the stop is blocked ONCE per turn with an instruction. Legitimate stops are
// never blocked: halted/completed runs, open questions for the user, a reply
// that ends by asking the user something, a second stop in the same turn, and
// the delivery checkpoint (opening a PR is the human's call, so stopping to
// ask for it is correct).

const fs = require('node:fs');
const { load: loadConfig } = require('./lib/config');
const store = require('./lib/store');
const lifecycle = require('./lib/lifecycle');
const verify = require('./lib/verify');

const SAME_TURN_WINDOW_MS = 60_000;

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  if (input.stop_hook_active) process.exit(0);

  const config = loadConfig();
  const found = store.locate(input.session_id, config.decisionTtlHours);
  if (!found) process.exit(0);
  const { sid } = found;

  let reason = null;
  store.updateRun(sid, (run) => {
    if (!run || run.halted || run.completed) return store.SKIP_SAVE;
    if (lifecycle.openQuestions(run).length) return store.SKIP_SAVE;
    if (/\?\s*$/.test(String(input.last_assistant_message || '').trim())) return store.SKIP_SAVE;

    const started = lifecycle.STEPS.some((s) => run.steps[s].attempts > 0 || run.steps[s].status === 'approved');
    if (!started) return store.SKIP_SAVE;

    const last = run.events[run.events.length - 1];
    const pending = last && /^(run:|rerun:)/.test(last.nextAction) ? last.nextAction : null;
    const anyRunning = lifecycle.AGENT_STEPS.some((s) => run.steps[s].status === 'running');

    let verifyReason = null;
    if (run.steps.implementation.status === 'approved' && run.repoRoot) {
      const current = verify.treeHash(run.repoRoot);
      if (!run.verification || run.verification.treeHash !== current) {
        verifyReason = run.verification
          ? 'The code changed since it was last verified.'
          : 'Implementation is approved but nothing has been verified.';
      }
    }
    if (!pending && !verifyReason) return store.SKIP_SAVE;
    if (anyRunning && !verifyReason) return store.SKIP_SAVE; // agents still working in the background

    // Never block twice in the same turn.
    const prev = run.stopBlock;
    const sameTurn = prev && ((input.prompt_id && prev.promptId === input.prompt_id) || (!input.prompt_id && Date.now() - new Date(prev.at).getTime() < SAME_TURN_WINDOW_MS));
    if (sameTurn) return store.SKIP_SAVE;

    const parts = [];
    if (verifyReason) parts.push(`${verifyReason} Run: sdlc-verify run (then fix failures, or state plainly what could not be verified).`);
    if (pending) parts.push(`Pipeline not finished - next action: ${pending}. Continue it, or tell the user why you are stopping.`);
    reason = `Verification before done: ${parts.join(' ')}`;
    run.stopBlock = { at: new Date().toISOString(), promptId: input.prompt_id || null };
    return undefined;
  });

  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

main();
