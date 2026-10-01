#!/usr/bin/env node
'use strict';

// PreToolUse hook for the Agent tool. Gates each SDLC pipeline agent call
// against the session's computed decision and lifecycle run:
//   - denies when the pipeline is halted (Level 3 Decline Gate, or an agent declined)
//   - denies steps the level skips (Level 1 design/eval)
//   - denies a step whose prerequisite stages are not yet approved (sequential gating)
//   - otherwise allows, filling in the mandated model tier when none was set
// Agent calls that don't look like SDLC pipeline agents (sdlcAgentPattern) are
// ignored (no output -> normal permission flow).

const fs = require('node:fs');
const { load: loadConfig } = require('./lib/config');
const store = require('./lib/store');
const lifecycle = require('./lib/lifecycle');

function emit(hookSpecificOutput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...hookSpecificOutput } }));
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  const config = loadConfig();
  const toolInput = input.tool_input || {};
  const haystack = `${toolInput.subagent_type || ''} ${toolInput.description || ''}`;

  if (!new RegExp(config.sdlcAgentPattern, 'i').test(haystack)) process.exit(0);

  const found = store.locate(input.session_id, config.decisionTtlHours);
  if (!found) {
    // No permissionDecision on purpose: in headless (-p) runs 'defer' pauses the whole session.
    emit({
      additionalContext:
        'orchestration-engine: no fresh complexity decision for this session. Run /orchestrate "<task>" first so this Agent call is routed against the Complexity Vector & Matrix.',
    });
    process.exit(0);
  }

  const { sid, decision } = found;
  const run = store.loadRun(sid) || lifecycle.beginRun(decision, config);
  const step = lifecycle.stepForCall(toolInput);

  const check = lifecycle.checkStart(run, step);
  if (!check.allow) {
    emit({ permissionDecision: 'deny', permissionDecisionReason: check.reason });
    process.exit(0);
  }

  const notes = step ? lifecycle.startNotes(run, step) : [];
  if (step) {
    lifecycle.markStarted(run, step);
    store.saveRun(sid, run);
  }

  const { modelTier, tokenCap, levelName } = decision.matrix;
  const updatedInput = { ...toolInput };
  if (!updatedInput.model) updatedInput.model = modelTier.model;

  emit({
    permissionDecision: 'allow',
    updatedInput,
    additionalContext: [
      `orchestration-engine gate: ${levelName}${step ? `, step=${step}` : ''}, model tier=${modelTier.tier} (model="${modelTier.model}"), token cap=${tokenCap.description}.`,
      ...notes,
    ].join(' '),
  });
}

main();
