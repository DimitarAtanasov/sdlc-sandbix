#!/usr/bin/env node
'use strict';

// Deterministic loop evaluator (no model). Exit 0 PASS, 1 FAIL, 2 usage.
//   loop-eval.js graph <loop.md>
//   loop-eval.js run   <loop.md> <trace.jsonl>

const fs = require('node:fs');
const { decodeText } = require('./lib/pycompat');
const { evalGraph, evalRun, loadRun } = require('./lib/loop-eval');

const USAGE = `Deterministic loop evaluator. No model is involved: the same inputs always give the same verdict.

  loop-eval graph docs/loops/<name>.md
  loop-eval run   docs/loops/<name>.md docs/loops/runs/<name>.<run-id>.jsonl

\`graph\` checks the loop contract: structure (G0) plus strict criteria S1-S4.
\`run\` checks a recorded run (JSON lines) against the graph and its budgets (R0-R8).
Exit 0 means PASS, 1 means FAIL (violations are printed, one per line, with a rule id), 2 usage error.
An agent saying it is finished is never evidence; only a verifier record with command evidence is.
`;

/** Read a file as Python's open(..., encoding="utf-8").read() would; describe failures in one line. */
function readText(file) {
  try {
    return { text: decodeText(fs.readFileSync(file)) };
  } catch (e) {
    if (e.code) return { error: `[${e.code}] ${e.message.replace(/^[A-Z]+: /, '')}` };
    return { error: `'utf-8' codec can't decode ${file}: invalid UTF-8` };
  }
}

function main(args) {
  const say = (s) => process.stdout.write(s + '\n');
  let errs;
  if (args.length >= 2 && args[0] === 'graph') {
    const loop = readText(args[1]);
    if (loop.error) {
      process.stderr.write(`error: cannot read loop ${loop.error}\n`);
      return 1;
    }
    errs = evalGraph(loop.text, args[1]);
  } else if (args.length >= 3 && args[0] === 'run') {
    const loop = readText(args[1]);
    if (loop.error) {
      process.stderr.write(`error: cannot read loop ${loop.error}\n`);
      return 1;
    }
    let recs;
    try {
      let buf;
      try {
        buf = fs.readFileSync(args[2]);
      } catch (e) {
        throw new Error(`[${e.code}] ${e.message.replace(/^[A-Z]+: /, '')}`);
      }
      let text;
      try {
        text = decodeText(buf);
      } catch {
        throw new Error(`'utf-8' codec can't decode ${args[2]}: invalid UTF-8`);
      }
      recs = loadRun(text);
    } catch (e) {
      say(`FAIL R0 ${e.message}`);
      return 1;
    }
    errs = evalRun(loop.text, recs, args[2]);
  } else {
    say(USAGE);
    return 2;
  }
  for (const e of errs) say(`FAIL ${e}`);
  say(errs.length ? `${errs.length} violation(s)` : 'PASS');
  return errs.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
