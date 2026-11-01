'use strict';

// Deterministic loop evaluator. No model is involved: the same inputs always give the same verdict.
//
//   loop-eval graph <loop.md>                 structure (G0) plus strict criteria S1-S4
//   loop-eval run   <loop.md> <trace.jsonl>   a recorded run (JSON lines) against the graph (R0-R8)
//
// Exit 0 PASS, 1 FAIL (one violation per line, each starting with its rule id), 2 usage error.
// An agent saying it is finished is never evidence; only a verifier record with command evidence is.
//
// Port of tools/skills/loop_eval.py + check_loop() of tools/skills/validate.py from the heroes-mobile
// project (same author, same rules, same messages). Python semantics that reach a verdict are kept
// via ./pycompat (Unicode whitespace, int vs float in JSON, == and truthiness).

const py = require('./pycompat');

const CONTRACT_FIELDS = ['goal and input', 'state', 'actions', 'observation', 'verification', 'stop and escalation', 'evidence'];
const TERMINALS = ['done', 'failed', 'escalated'];
const ROLES = ['advisor', 'producer', 'runner', 'verifier', 'lead'];
const EVIDENCE_KINDS = ['command', 'file', 'commit', 'report', 'decision'];
const RECORD_KEYS = new Set(['step', 'node', 'to', 'label', 'actor', 'role', 'evidence', 'spent']);

const W = py.WS;
const NODE = '([A-Za-z_][A-Za-z0-9_]*)(?:\\[[^\\]]*\\]|\\{[^}]*\\}|\\([^)]*\\))?';
const EDGE = new RegExp(`^${W}*${NODE}${W}*-->${W}*(?:\\|([^|]*)\\|${W}*)?${NODE}${W}*$`, 'u');
const MERMAID = /```mermaid\n([\s\S]*?)```/;
const HEADING = new RegExp(`(?<=^|\\n)#{2,3}${W}+([^\\n]*)(?=\\n|$)`, 'gu');
// Python's re.I also folds U+0130 and U+0131 onto i; JS's u-flag case folding does not, hence the extra pair.
const BUDGET = new RegExp(`(?<=^|\\n)${W}*-${W}*budget[: ]${W}*([A-Za-z0-9_ \\u0130\\u0131-]+?)${W}*[:=]${W}*(\\p{Nd}+)`, 'giu');

const lower = (s) => s.toLowerCase();
const pair = (a, b) => a + '\u0000' + b;

function budgetMatches(text) {
  return [...text.matchAll(BUDGET)].map((m) => [py.strip(m[1]), py.digitsToInt(m[2])]);
}

/** Edges of the mermaid block as [src, label, dst]; `skipHeaders` mirrors validate.py, which ignores flowchart/graph/%% lines. */
function mermaidEdges(text, skipHeaders) {
  const m = MERMAID.exec(text);
  if (!m) return null;
  const edges = [];
  for (let line of py.splitlines(m[1])) {
    line = py.strip(line);
    if (skipHeaders && (!line || ['flowchart', 'graph', '%%'].some((p) => line.startsWith(p)))) continue;
    const e = EDGE.exec(line);
    if (e) edges.push([e[1], py.strip(e[2] || ''), e[3]]);
  }
  return edges;
}

/** [edges, budgets]: edges as [src, label, dst] in document order; budgets a Map name -> int. */
function parseLoop(text) {
  const edges = mermaidEdges(text, false) || [];
  const budgets = new Map();
  for (const [k, v] of budgetMatches(text)) budgets.set(k, v);
  return [edges, budgets];
}

function adjacency(edges) {
  const adj = new Map();
  for (const [a, , b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  return adj;
}

/** Edges whose target is on the DFS stack when met (they close a cycle), as "a\0b" keys. */
function backEdges(edges, start) {
  const adj = adjacency(edges);
  const state = new Map();
  const back = new Set();
  const visit = (n) => {
    state.set(n, 1);
    for (const s of adj.get(n) || []) {
      if (state.get(s) === 1) back.add(pair(n, s));
      else if (!state.has(s)) visit(s);
    }
    state.set(n, 2);
  };
  visit(start);
  return back;
}

function hasCycle(adj, nodes) {
  const state = new Map();
  const visit = (n) => {
    state.set(n, 1);
    for (const s of adj.get(n) || []) {
      if (state.get(s) === 1) return true;
      if (!state.has(s) && visit(s)) return true;
    }
    state.set(n, 2);
    return false;
  };
  return nodes.some((n) => !state.has(n) && visit(n));
}

const sortedStrings = (xs) => [...xs].sort(py.cmpStr);

/** Structural checks (G0): contract sections, budget section, graph shape. Messages without the rule id. */
function checkLoop(text, name = 'loop') {
  const errs = [];
  const low = lower(text);
  const heads = [...text.matchAll(HEADING)].map((m) => lower(py.strip(m[1])));
  for (const f of CONTRACT_FIELDS) {
    if (!heads.some((h) => h.includes(f))) errs.push(`${name}: missing contract section '${f}'`);
  }
  const budgets = budgetMatches(text);
  if (!low.includes('## budget')) errs.push(`${name}: missing '## Budget' section`);
  const edges = mermaidEdges(text, true);
  if (edges === null) return [...errs, `${name}: missing \`\`\`mermaid graph`];
  if (!edges.length) return [...errs, `${name}: mermaid graph has no edges`];
  const adj = adjacency(edges);
  const allnodes = sortedStrings(new Set(edges.flatMap(([a, , b]) => [a, b])));
  const terms = allnodes.filter((n) => TERMINALS.includes(n));
  if (!terms.includes('done')) errs.push(`${name}: no 'done' terminal node`);
  for (const t of terms) if (adj.get(t)) errs.push(`${name}: terminal '${t}' has outgoing edges`);
  for (const n of allnodes) if (!TERMINALS.includes(n) && !adj.get(n)) errs.push(`${name}: node '${n}' has no exit (dead end)`);
  const start = edges[0][0];
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(adj.get(n) || []));
  }
  for (const n of allnodes) if (!seen.has(n)) errs.push(`${name}: node '${n}' is unreachable from '${start}'`);
  const rev = new Map();
  for (const [a, , b] of edges) {
    if (!rev.has(b)) rev.set(b, []);
    rev.get(b).push(a);
  }
  const good = new Set(terms);
  const todo = [...terms];
  while (todo.length) {
    for (const p of rev.get(todo.pop()) || []) {
      if (!good.has(p)) {
        good.add(p);
        todo.push(p);
      }
    }
  }
  for (const n of allnodes) if (!good.has(n)) errs.push(`${name}: node '${n}' cannot reach any terminal`);
  if (hasCycle(adj, allnodes) && !budgets.length) errs.push(`${name}: the graph has a cycle but no '- budget <name>: <int>' entry`);
  return errs;
}

/** G0 + S1-S4 for a loop document. Returns violation strings, each starting with its rule id. */
function evalGraph(text, name = 'loop') {
  const errs = checkLoop(text, name).map((e) => `G0 ${e}`);
  const [edges, budgets] = parseLoop(text);
  if (!edges.length) return errs;
  const start = edges[0][0];
  const out = new Map();
  for (const [a, lab, b] of edges) {
    if (!out.has(a)) out.set(a, []);
    out.get(a).push([lab, b]);
  }
  for (const n of sortedStrings(out.keys())) {
    const outs = out.get(n);
    if (outs.length > 1) {
      for (const [lab, b] of outs) if (!lab) errs.push(`S1 ${name}: edge ${n} --> ${b} leaves a branching node without a label`);
    }
  }
  for (const [k, v] of budgets) if (v <= 0) errs.push(`S2 ${name}: budget '${k}' must be a positive integer`);
  const back = [...backEdges(edges, start)].map((k) => k.split('\u0000'));
  back.sort((x, y) => py.cmpStr(x[0], y[0]) || py.cmpStr(x[1], y[1]));
  for (const [a, b] of back) {
    const labs = edges.filter(([x, , y]) => x === a && y === b).map(([, lab]) => lab);
    if (!labs.every(Boolean)) errs.push(`S2 ${name}: back edge ${a} --> ${b} (a retry) must carry a label`);
  }
  const nodes = new Set(edges.flatMap(([a, , b]) => [a, b]));
  const gates = new Set([...nodes].filter((n) => n.startsWith('verify')));
  if (nodes.has('done')) {
    if (!gates.size) {
      errs.push(`S3 ${name}: no verify* node; success has no acceptance gate`);
    } else {
      const seen = new Set();
      const stack = [start];
      while (stack.length) {
        const n = stack.pop();
        if (seen.has(n) || gates.has(n)) continue;
        seen.add(n);
        stack.push(...(out.get(n) || []).map(([, b]) => b));
      }
      if (seen.has('done')) errs.push(`S3 ${name}: 'done' is reachable without passing a verify* node`);
    }
  }
  if (!nodes.has('failed') && !nodes.has('escalated')) errs.push(`S4 ${name}: needs a non-success exit ('failed' or 'escalated')`);
  return errs;
}

/** Parse a JSON-lines trace (Buffer or string). Throws Error("line N: invalid JSON (...)"). */
function loadRun(content) {
  const text = typeof content === 'string' ? content.replace(/\r\n?/g, '\n') : py.decodeText(content);
  const recs = [];
  text.split('\n').forEach((raw, idx) => {
    const line = py.strip(raw);
    if (!line) return;
    try {
      recs.push(py.parseJson(line));
    } catch (e) {
      if (!(e instanceof py.JSONDecodeError)) throw e;
      throw new Error(`line ${idx + 1}: invalid JSON (${e.message})`);
    }
  });
  return recs;
}

const get = (m, k, dflt = null) => (m.has(k) ? m.get(k) : dflt);
const isStr = (v) => typeof v === 'string';

/** Python's iteration of rr.get("evidence", []) inside the R7 search; non-iterables (a Python TypeError) yield nothing. */
function evidenceItems(ev) {
  return Array.isArray(ev) ? ev : [];
}

/** R0-R8 for a recorded run against its loop. `recs` may be plain objects or the output of loadRun. */
function evalRun(text, records, name = 'run') {
  const graphErrs = evalGraph(text, name).map((e) => `G0 ${e}`);
  if (graphErrs.length) return [...graphErrs, `R0 ${name}: the graph itself fails, so no run can be accepted`];
  const recs = records.map(py.toPy);
  const errs = [];
  const [edges, budgets] = parseLoop(text);
  const start = edges[0][0];
  const legal = new Map(edges.map(([a, lab, b]) => [pair(a, b), lab]));
  const back = backEdges(edges, start);
  const terminals = new Set(TERMINALS.filter((n) => edges.some(([a, , b]) => a === n || b === n)));
  if (!recs.length) return [`R1 ${name}: empty run`];
  const prevSpent = new Map();
  let prevTo = start;
  let verifierOk = false;
  const producers = new Map();
  const verifiers = new Map();
  const addActor = (set, actor) => {
    const k = py.hashKey(actor);
    if (k !== undefined && !set.has(k)) set.set(k, actor);
  };
  recs.forEach((r, idx) => {
    const i = idx + 1;
    const w = `${name} step ${i}`;
    if (!py.isDict(r)) {
      errs.push(`R6 ${w}: record is not an object`);
      return;
    }
    const extra = [...r.keys()].filter((k) => !RECORD_KEYS.has(k));
    if (extra.length) errs.push(`R6 ${w}: unknown keys ${py.repr(sortedStrings(extra))}`);
    if (!py.eq(get(r, 'step'), i)) errs.push(`R1 ${w}: step must be ${i}, got ${py.repr(get(r, 'step'))}`);
    const node = get(r, 'node');
    const to = get(r, 'to');
    if (!py.eq(node, prevTo)) errs.push(`R1 ${w}: node ${py.repr(node)} must equal the previous 'to' ${py.repr(prevTo)}`);
    const role = get(r, 'role');
    if (!ROLES.some((x) => py.eq(role, x))) errs.push(`R6 ${w}: role must be one of ${py.reprTuple(ROLES)}`);
    const actor = get(r, 'actor');
    if (!isStr(actor) || !actor) errs.push(`R6 ${w}: actor must be a non-empty string`);
    let ev = get(r, 'evidence', []);
    if (!Array.isArray(ev)) {
      errs.push(`R5 ${w}: evidence must be a list`);
      ev = [];
    }
    let hasCmdOk = false;
    let hasDecision = false;
    for (const item of ev) {
      if (!py.isDict(item) || !EVIDENCE_KINDS.some((k) => py.eq(get(item, 'kind'), k)) || !isStr(get(item, 'ref')) || !get(item, 'ref')) {
        errs.push(`R5 ${w}: evidence item needs kind in ${py.reprTuple(EVIDENCE_KINDS)} and a non-empty ref`);
        continue;
      }
      const kind = get(item, 'kind');
      if (kind === 'command') {
        const ec = get(item, 'exit_code');
        if (!py.isInt(ec)) errs.push(`R5 ${w}: command evidence needs an integer exit_code`);
        else if (ec == 0) hasCmdOk = true; // eslint-disable-line eqeqeq
      }
      if (kind === 'decision') hasDecision = true;
    }
    if (role === 'producer' || role === 'runner') addActor(producers, actor);
    if (role === 'verifier') {
      addActor(verifiers, actor);
      if (isStr(node) && node.startsWith('verify') && hasCmdOk) verifierOk = true;
    }
    let spent = get(r, 'spent', new Map());
    if (!py.isDict(spent)) {
      errs.push(`R3 ${w}: spent must be an object`);
      spent = new Map();
    }
    for (const [k, v] of spent) {
      if (!budgets.has(k)) {
        errs.push(`R3 ${w}: counter ${py.repr(k)} is not a budget of the loop`);
      } else if (!py.isInt(v) || v < 0) {
        errs.push(`R3 ${w}: counter ${py.repr(k)} must be a non-negative integer`);
      } else {
        if (v > budgets.get(k)) errs.push(`R3 ${w}: counter ${py.repr(k)}=${v} exceeds its budget ${budgets.get(k)}`);
        if (v < get(prevSpent, k, 0)) errs.push(`R3 ${w}: counter ${py.repr(k)} went down (${prevSpent.get(k)} -> ${v})`);
      }
    }
    if (to === null) {
      if (!(isStr(node) && terminals.has(node))) errs.push(`R1 ${w}: the run stops at ${py.repr(node)}, which is not a terminal`);
      if (i !== recs.length) errs.push(`R1 ${w}: records continue after a terminal`);
      if (node === 'done' && !verifierOk) errs.push(`R4 ${w}: 'done' without an earlier verify* record carrying command evidence exit_code 0`);
      if (node === 'escalated' && !(hasDecision || recs.some((rr) => py.isDict(rr) &&
          evidenceItems(get(rr, 'evidence', [])).some((e) => py.isDict(e) && py.eq(get(e, 'kind'), 'decision'))))) {
        errs.push(`R7 ${w}: 'escalated' needs decision evidence naming what the owner must decide`);
      }
      if (node === 'failed' && !ev.length) errs.push(`R8 ${w}: 'failed' needs evidence`);
    } else {
      const key = isStr(node) && isStr(to) ? pair(node, to) : undefined;
      if (key === undefined || !legal.has(key)) {
        errs.push(`R2 ${w}: ${py.repr(node)} --> ${py.repr(to)} is not an edge of the graph`);
      } else {
        const label = get(r, 'label');
        if (!py.eq(legal.get(key), py.truthy(label) ? label : '')) errs.push(`R2 ${w}: label ${py.repr(label)} must be ${py.repr(legal.get(key))}`);
        if (back.has(key)) {
          const grew = [...spent].some(([k, v]) => py.isInt(v) && v > get(prevSpent, k, 0));
          if (!grew) errs.push(`R3 ${w}: retry edge ${node} --> ${to} did not increase any budget counter`);
        }
      }
    }
    for (const [k, v] of spent) {
      if (py.isInt(v)) {
        const p = get(prevSpent, k, 0);
        prevSpent.set(k, v > p ? v : p);
      }
    }
    prevTo = to;
  });
  const last = recs[recs.length - 1];
  if (!py.isDict(last) || get(last, 'to') !== null) errs.push(`R1 ${name}: the run does not end in a terminal`);
  const both = [...producers].filter(([k]) => verifiers.has(k)).map(([, a]) => a);
  if (both.length) {
    const names = [...both].sort((a, b) => (isStr(a) && isStr(b) ? py.cmpStr(a, b) : String(a) < String(b) ? -1 : 1));
    errs.push(`R4 ${name}: actor(s) ${py.repr(names)} both produced work and verified it (maker must not accept)`);
  }
  return errs;
}

/** The rule ids in a list of violations, sorted and unique. */
function rules(errs) {
  return [...new Set(errs.map((e) => e.split(' ')[0]))].sort();
}

module.exports = { CONTRACT_FIELDS, TERMINALS, ROLES, EVIDENCE_KINDS, parseLoop, checkLoop, evalGraph, loadRun, evalRun, rules };
