# loop-graph

Agent loops as reviewable contracts, judged by a deterministic evaluator, plus a typed project memory.

The orchestration-engine runs one fixed pipeline (`/sdlc`) and enforces it with hooks. This plugin is
for the loops around and between such runs: a multi-agent round, a retry loop, an overnight job. You
write the loop down as a contract, `loop-eval` checks the contract and later checks the recorded run,
and nothing is accepted because an agent said it was done. It adds no hooks and changes nothing in the
other plugins.

| Adds | What it is |
|---|---|
| `loop-eval` | Deterministic evaluator, no model: `graph` rules G0, S1-S4 for a contract; `run` rules R0-R8 for a JSON-lines trace. Exit 0 PASS, 1 FAIL, 2 usage. |
| `/loop-graph` skill | How to design a loop: principles, procedure, contract shape, rules, pitfalls. |
| `loop-advisor`, `loop-producer`, `loop-runner` | Read-only brief (opus); writes contracts until `loop-eval graph` passes (opus); runs a loop and records the trace, never accepts its own work (haiku). |
| `/second-brain` skill | Typed notes in `docs/memory/` (lesson, fact, preference, pointer) with evidence and a date, and how they relate to the engine's `.sdlc/lessons.md`. |
| `brain-index` | Optional Graphify code map of the committed code in `docs/codebase-index/`. |
| `templates/`, `examples/` | `loop.md` (passes `loop-eval graph` as shipped), `memory-note.md`, and a worked agent round with a passing trace. |
| `docs/lessons-seed.md` | Eight general lessons, as proposals for `/retro`, in `sdlc-lessons add` form. |

## Install

```
/plugin marketplace add dimitaratanasov/sdlc-sandbix
/plugin install loop-graph@sdlc-sandbix
```

## Commands

```
loop-eval graph docs/loops/<name>.md
loop-eval run   docs/loops/<name>.md docs/loops/runs/<name>.<run-id>.jsonl
brain-index                                   # BRAIN_INDEX_OUT, BRAIN_INDEX_EXCLUDE, BRAIN_INDEX_PYTHON
```

## Loop and trace format, in short

A loop is a markdown file with the sections Goal and input, State, Actions, Observation,
Verification, Stop and escalation, Evidence and Budget (`- budget <name>: <int>` lines), and one
mermaid `flowchart` with one edge per line (`a --> b`, `a -->|label| b`). Terminals are `done`,
`failed`, `escalated`. `done` must be reachable only through a node whose name starts with `verify`.

A trace has one JSON object per line with exactly the keys `step`, `node`, `to` (null on the
terminal), `label` (the exact edge label), `actor`, `role` (advisor, producer, runner, verifier,
lead), `evidence` (items `{kind: command|file|commit|report|decision, ref, exit_code}`) and `spent`
(cumulative budget counters). `done` needs a verifier record at a `verify*` node with command
evidence exit 0, and the verifier cannot be an actor that produced work.

## Limits

- `loop-eval` is a port of a Python evaluator from another project. It was checked against that
  reference on 80 inputs (identical output on all of them). Where the Python version crashes (a list
  used as a node name, a non-object last record) this one reports a violation and exits 1 instead.
- The three agents have not been tried on live tasks yet. The evaluator stops them only when their
  trace breaks a rule; it does not check that the work in the trace was really done. The lead still
  re-runs the success command.
- `brain-index` needs Python 3 and network access to PyPI (it installs `graphifyy==0.9.100` into a
  throw-away venv). Without model keys it parses code only; Markdown and data files give no symbols.
- There is no linter yet for `docs/memory/`; the second-brain skill lists what to check by hand.

## Tests

```
cd plugins/loop-graph && npm test
```
