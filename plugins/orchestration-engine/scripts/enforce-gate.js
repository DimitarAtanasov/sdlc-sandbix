#!/usr/bin/env node
'use strict';

// PreToolUse hook for the "Agent" tool. Enforces the most recently computed
// orchestration decision (written by compute-complexity.js / the /orchestrate
// skill) against the subagent about to be spawned:
//   - Level 1: denies spec-eval/tech-design/tech-design-eval calls (skipped by design).
//   - Level 3 Decline Gate: denies all SDLC agent calls when D exceeds the ceiling.
//   - Otherwise: allows, and fills in the mandated model tier when the caller
//     didn't already pick one, plus a token-cap reminder.
// Agent calls that don't look like one of the SDLC pipeline agents (per
// sdlcAgentPattern) are left alone (no output -> normal flow applies).

const fs = require('node:fs');
const path = require('node:path');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function pluginDataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(require('node:os').tmpdir(), 'orchestration-engine-data');
}

function loadDecision(ttlHours) {
  const file = path.join(pluginDataDir(), 'last-decision.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let decision;
  try {
    decision = JSON.parse(raw);
  } catch {
    return null;
  }
  const ageHours = (Date.now() - new Date(decision.computedAt).getTime()) / 3_600_000;
  if (ageHours > ttlHours) return null;
  return decision;
}

function emit(output) {
  process.stdout.write(JSON.stringify(output));
}

function main() {
  const input = JSON.parse(readStdin() || '{}');
  const toolInput = input.tool_input || {};
  const subagentType = String(toolInput.subagent_type || '');
  const description = String(toolInput.description || '');
  const haystack = `${subagentType} ${description}`.toLowerCase();

  const ttlHours = Number(process.env.CLAUDE_PLUGIN_OPTION_DECISIONTTLHOURS || 6);
  const pattern = new RegExp(process.env.CLAUDE_PLUGIN_OPTION_SDLCAGENTPATTERN || 'spec|eval|design|implement|document|doc|test', 'i');

  if (!pattern.test(haystack)) {
    process.exit(0); // not an SDLC pipeline agent call - stay out of the way
  }

  const decision = loadDecision(ttlHours);
  if (!decision) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer',
        additionalContext:
          'orchestration-engine: no fresh complexity decision on file. Run /orchestrate "<task>" first so this Agent call is routed against the Complexity Vector & Matrix.',
      },
    });
    process.exit(0);
  }

  const { matrix } = decision;
  const { threeWayDecision, modelTier, tokenCap, level, levelName } = matrix;

  if (threeWayDecision.decision === 'decline') {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Decline Gate: ${threeWayDecision.reason} Ask the user for more information instead of proceeding.`,
      },
    });
    process.exit(0);
  }

  if (level === 1 && threeWayDecision.skipSteps.some((step) => haystack.includes(step.replace('-', '')) || haystack.includes(step))) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${levelName}: Design/Eval steps are skipped at this complexity level. Proceed directly to implementation.`,
      },
    });
    process.exit(0);
  }

  const updatedInput = { ...toolInput };
  if (!updatedInput.model) updatedInput.model = modelTier.model;

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
      additionalContext: `orchestration-engine gate: ${levelName}, model tier=${modelTier.tier} (model="${modelTier.model}"), token cap=${tokenCap.description}, decision=${threeWayDecision.decision}.`,
    },
  });
}

main();
