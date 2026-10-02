#!/usr/bin/env node
'use strict';

// Lifecycle CLI for the current session's pipeline run.
//   lifecycle.js status [--json]
//   lifecycle.js clarified            user answered the open questions
//   lifecycle.js record <step> --decision draft|ask_clarification|decline
//        [--verdict approve|revise] [--confidence 0.8] [--missing "q1;q2"] [--summary "..."]
//        manual fallback when an agent could not emit its <decision> block
//   lifecycle.js reset                forget the current run

const { load: loadConfig } = require('./lib/config');
const store = require('./lib/store');
const lifecycle = require('./lib/lifecycle');
const history = require('./lib/history');

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const config = loadConfig();
  const found = store.locate(store.currentSid(), config.decisionTtlHours);
  if (!found && cmd !== 'reset') fail('No fresh orchestration decision for this session. Run /orchestrate "<task>" first.');
  const sid = found ? found.sid : store.currentSid();
  const run = found ? (store.loadRun(sid) || lifecycle.beginRun(found.decision, config)) : null;

  switch (cmd) {
    case 'status':
      process.stdout.write((f.json ? JSON.stringify(run, null, 2) : lifecycle.summarize(run)) + '\n');
      break;
    case 'clarified':
      run.clarified = true;
      run.pendingQuestions = [];
      store.saveRun(sid, run);
      process.stdout.write('Marked clarified.\n');
      break;
    case 'record': {
      const step = f._[0];
      if (!lifecycle.STEPS.includes(step)) fail(`Unknown step '${step}'. Steps: ${lifecycle.STEPS.join(', ')}`);
      const res = lifecycle.recordReport(run, step, {
        decision: f.decision,
        verdict: f.verdict,
        confidence: f.confidence !== undefined ? Number(f.confidence) : undefined,
        missing_info: typeof f.missing === 'string' ? f.missing.split(';').filter(Boolean) : [],
        summary: typeof f.summary === 'string' ? f.summary : '',
      });
      history.closeIfFinished(sid, run);
      store.saveRun(sid, run);
      process.stdout.write(`${step} -> ${res.status}; next: ${res.nextAction}${res.coerced.length ? `\nAdjusted: ${res.coerced.join(' ')}` : ''}\n`);
      break;
    }
    case 'reset':
      if (found) {
        history.closeAsReplaced(sid, run);
        store.saveRun(sid, lifecycle.beginRun(found.decision, config));
        process.stdout.write('Run reset from the current decision.\n');
      } else {
        process.stdout.write('Nothing to reset.\n');
      }
      break;
    default:
      fail('Usage: lifecycle.js status|clarified|record <step>|reset');
  }
}

main();
