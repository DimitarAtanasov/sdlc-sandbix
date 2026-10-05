#!/usr/bin/env node
'use strict';

// Lifecycle CLI for the current session's pipeline run.
//   lifecycle.js status [--json]
//   lifecycle.js clarified                       the user answered the open questions
//   lifecycle.js record <step> --decision draft|ask_clarification|decline
//        [--verdict approve|revise] [--confidence 0.8] [--missing "q1;q2"] [--summary "..."]
//        manual fallback when an agent could not emit its <decision> block
//   lifecycle.js override --reason "<why>"       a human lifts a halt (decline gate / agent decline)
//   lifecycle.js deliver --pr <url> [--branch b]  record delivery (needs fresh passing verification)
//   lifecycle.js reset                           restart the run from the current decision

const { load: loadConfig } = require('./lib/config');
const store = require('./lib/store');
const lifecycle = require('./lib/lifecycle');
const history = require('./lib/history');
const verify = require('./lib/verify');

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
  if (!found) fail('No fresh orchestration decision for this session. Run /sdlc (or /orchestrate "<task>") first.');
  const { sid, decision } = found;
  store.ensureRun(sid, () => lifecycle.beginRun(decision, config));
  let out = '';
  let code = 0;

  store.updateRun(sid, (run) => {
    switch (cmd) {
      case 'status':
        out = f.json ? JSON.stringify(run, null, 2) : lifecycle.summarize(run);
        return store.SKIP_SAVE;
      case 'clarified':
        run.clarified = true;
        for (const s of lifecycle.STEPS) if (run.steps[s].status === 'needs_clarification') run.steps[s].questions = [];
        out = 'Marked clarified. Re-run the step that was waiting.';
        return undefined;
      case 'record': {
        const step = f._[0];
        if (!lifecycle.AGENT_STEPS.includes(step)) {
          out = `Unknown step '${step}'. Steps: ${lifecycle.AGENT_STEPS.join(', ')}`;
          code = 1;
          return store.SKIP_SAVE;
        }
        const res = lifecycle.recordReport(run, step, {
          decision: f.decision,
          verdict: f.verdict,
          confidence: f.confidence !== undefined ? Number(f.confidence) : undefined,
          missing_info: typeof f.missing === 'string' ? f.missing.split(';').filter(Boolean) : [],
          summary: typeof f.summary === 'string' ? f.summary : '',
        });
        history.closeIfFinished(sid, run);
        out = `${step} -> ${res.status}; next: ${res.nextAction}${res.coerced.length ? `\nAdjusted: ${res.coerced.join(' ')}` : ''}`;
        return undefined;
      }
      case 'override': {
        if (typeof f.reason !== 'string' || !f.reason.trim()) {
          out = 'An override needs a reason: sdlc-lifecycle override --reason "<why>"';
          code = 1;
          return store.SKIP_SAVE;
        }
        const res = lifecycle.override(run, f.reason);
        out = res.ok ? `Halt lifted (logged). Resume the pipeline.` : res.reason;
        code = res.ok ? 0 : 1;
        return res.ok ? undefined : store.SKIP_SAVE;
      }
      case 'deliver': {
        const res = lifecycle.markDelivered(run, { pr: typeof f.pr === 'string' ? f.pr : null, branch: typeof f.branch === 'string' ? f.branch : null, treeHash: verify.treeHash(run.repoRoot) });
        if (!res.ok) {
          out = res.reason;
          code = 1;
          return store.SKIP_SAVE;
        }
        history.closeIfFinished(sid, run);
        const u = run.delivery.unverified;
        out = `Delivered${run.delivery.pr ? `: ${run.delivery.pr}` : ''}. Run complete.${u && u.length ? `\nUnverified here (say so in the PR): ${u.join('; ')}` : ''}`;
        return undefined;
      }
      case 'reset':
        history.closeAsReplaced(sid, run);
        Object.assign(run, lifecycle.beginRun(decision, config, { hotfix: run.hotfix }));
        out = 'Run reset from the current decision.';
        return undefined;
      default:
        out = 'Usage: lifecycle.js status|clarified|record <step>|override --reason|deliver --pr <url>|reset';
        code = 1;
        return store.SKIP_SAVE;
    }
  });

  (code ? process.stderr : process.stdout).write(out + '\n');
  process.exit(code);
}

main();
