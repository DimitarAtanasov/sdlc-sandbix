#!/usr/bin/env node
'use strict';

// PreToolUse hook for the Agent tool. Gates each SDLC pipeline agent call
// against the session's computed decision and lifecycle run:
//   - denies when the pipeline is halted (Level 3 decline gate, or an agent declined)
//   - denies steps the level skips (Level 1 / hotfix design+eval)
//   - denies a step whose prerequisite stages are not yet approved (sequential gating)
//   - otherwise allows, filling in the mandated model tier when none was set and
//     appending the project's approved lessons to the agent's prompt
// Calls that are not pipeline steps (Explore, general-purpose research, ...) are
// ignored: no output, normal permission flow.

const fs = require('node:fs');
const { load: loadConfig } = require('./lib/config');
const store = require('./lib/store');
const lifecycle = require('./lib/lifecycle');
const lessons = require('./lib/lessons');

const LESSON_MARK = 'Project lessons (.sdlc/lessons.md';

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
  const step = lifecycle.stepForCall(toolInput);
  if (!step) process.exit(0);

  const found = store.locate(input.session_id, config.decisionTtlHours);
  if (!found) {
    // No permissionDecision on purpose: in headless (-p) runs 'defer' pauses the whole session.
    emit({
      additionalContext:
        'orchestration-engine: no fresh complexity decision for this session. Run /sdlc (or /orchestrate "<task>") first so this Agent call is routed against the Complexity Vector & Matrix.',
    });
    process.exit(0);
  }

  const { sid, decision } = found;
  store.ensureRun(sid, () => lifecycle.beginRun(decision, config));

  let denied = null;
  let notes = [];
  let repoRoot = input.cwd || null;
  store.updateRun(sid, (run) => {
    repoRoot = run.repoRoot || repoRoot;
    const check = lifecycle.checkStart(run, step);
    if (!check.allow) {
      denied = check.reason;
      return store.SKIP_SAVE;
    }
    notes = lifecycle.startNotes(run, step);
    lifecycle.markStarted(run, step, { generic: lifecycle.isGenericAgent(toolInput.subagent_type) });
    return undefined;
  });

  if (denied) {
    emit({ permissionDecision: 'deny', permissionDecisionReason: denied });
    process.exit(0);
  }

  const { modelTier, tokenCap, levelName } = decision.matrix;
  const updatedInput = { ...toolInput };
  if (!updatedInput.model) updatedInput.model = modelTier.model;
  if (config.injectLessons && repoRoot && typeof updatedInput.prompt === 'string' && !updatedInput.prompt.includes(LESSON_MARK)) {
    const text = lessons.injection(repoRoot);
    if (text) updatedInput.prompt = `${updatedInput.prompt}\n\n${text}`;
  }

  emit({
    permissionDecision: 'allow',
    updatedInput,
    additionalContext: [
      `orchestration-engine gate: ${levelName}, step=${step}, model tier=${modelTier.tier} (model="${modelTier.model}"), token cap=${tokenCap.description}.`,
      ...notes,
    ].join(' '),
  });
}

main();
