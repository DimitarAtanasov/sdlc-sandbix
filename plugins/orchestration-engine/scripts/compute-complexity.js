#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { computeComplexityVector } = require('./lib/complexity');
const { decideExecutionMatrix } = require('./lib/matrix');
const { load: loadConfig } = require('./lib/config');
const { beginRun } = require('./lib/lifecycle');
const store = require('./lib/store');
const history = require('./lib/history');

function parseArgs(argv) {
  const args = { files: [], json: false, hotfix: false, task: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--hotfix') args.hotfix = true;
    else if (a === '--files') args.files = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--repo') args.repo = argv[++i];
    else rest.push(a);
  }
  args.task = rest.join(' ').trim();
  return args;
}

function formatReport(task, result, sid) {
  const { vector, magnitude, inputs } = result.complexity;
  const m = result.matrix;
  const spec = inputs.specsFound
    ? (inputs.specRelevant ? `, closest=${inputs.closestSpec}` : ', no relevant spec - neutral distance')
    : ', no specs/ found - neutral distance';
  const lines = [];
  lines.push('# Orchestration Engine - Complexity Vector & Matrix');
  lines.push('');
  if (task) lines.push(`Task: ${task}`);
  lines.push(`Session: ${sid}`);
  if (result.hotfix) lines.push('Mode: HOTFIX (design/eval skipped; testing and verification mandatory)');
  lines.push(`Analysis mode: ${inputs.mode === 'diff' ? 'working-tree diff' : 'pre-implementation estimate'}`);
  lines.push(`Files considered (${inputs.fCount}): ${inputs.files.length ? inputs.files.join(', ') : '(none resolved - greenfield task)'}`);
  lines.push('');
  lines.push('## Complexity Vector C = [S, D, H]');
  lines.push(`- S (Structural Mutation):        ${vector.S.toFixed(2)}  (deltaLines=${inputs.deltaLines}, fCount=${inputs.fCount})`);
  lines.push(`- D (Dependency & Coupling Depth): ${vector.D.toFixed(2)}  (sum of inbound+outbound refs across files)`);
  lines.push(`- H (Historical Uncertainty):      ${vector.H.toFixed(2)}  (churn30d=${inputs.gitChurn30d}, cosineDistanceToSpecs=${inputs.cosineDistanceToSpecs.toFixed(2)}${spec})`);
  lines.push('');
  lines.push(`## Magnitude M = ${magnitude.toFixed(2)}`);
  lines.push('');
  lines.push(`## Execution Matrix: ${m.levelName} (${m.magnitudeRange})`);
  lines.push(`- Pipeline strategy: ${m.pipelineStrategy}`);
  lines.push(`- Model tier: ${m.modelTier.tier} -> use model="${m.modelTier.model}" for the Agent tool`);
  lines.push(`- Token cap: ${m.tokenCap.description}`);
  lines.push(`- 3-way decision: **${m.threeWayDecision.decision.toUpperCase()}** - ${m.threeWayDecision.reason}`);
  if (m.threeWayDecision.skipSteps.length) {
    lines.push(`- Steps to skip: ${m.threeWayDecision.skipSteps.join(', ')}`);
  }
  lines.push('');
  lines.push('Pipeline run started. Check progress any time with: sdlc-lifecycle status');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repo || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const config = loadConfig();

  let stdinTask = '';
  if (!process.stdin.isTTY && !args.task) {
    try {
      stdinTask = fs.readFileSync(0, 'utf8').trim();
    } catch {
      // no stdin available
    }
  }
  const task = args.task || stdinTask;

  const complexity = computeComplexityVector(repoRoot, task, args.files, config);
  const matrix = decideExecutionMatrix(complexity, config);
  const result = { task, repoRoot, complexity, matrix, hotfix: args.hotfix };

  const sid = store.currentSid();
  try {
    store.withLock(sid, () => {
      history.closeAsReplaced(sid, store.loadRun(sid));
      const run = beginRun(result, config, { hotfix: args.hotfix });
      history.closeIfFinished(sid, run); // e.g. declined by the Level 3 gate before any agent ran
      store.saveDecision(sid, result);
      store.saveRun(sid, run);
    });
  } catch (err) {
    process.stderr.write(`[orchestration-engine] warning: could not persist decision: ${err.message}\n`);
  }

  process.stdout.write((args.json ? JSON.stringify({ ...result, sessionId: sid }, null, 2) : formatReport(task, result, sid)) + '\n');
}

main();
