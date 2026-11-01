---
name: loop-graph
description: Design, write and check an agent loop or workflow as a reviewable contract (goal, state, nodes, edges, budgets, terminals) in docs/loops, judged by the deterministic loop-eval evaluator. Use before any multi-step or multi-agent task, a retry loop, or a long-running job, and when a recorded run must be accepted or rejected.
---

# Loop graph

Turn a task into a small loop contract in `docs/loops/<name>.md` that a human can review without
running anything, and that `loop-eval` (deterministic, no model) can accept or reject.
Start from the plugin's `templates/loop.md`; a worked example is `examples/agent-round.md` with its
trace `examples/agent-round.example.jsonl` (both next to `bin/`, so `$(dirname "$(command -v loop-eval)")/..`).

## Principles
1. **Think before building.** State the goal, assumptions and open questions first. A decision that
   belongs to the owner (license, scope, anything irreversible or outward-facing) becomes an
   `escalated` exit, not a guess.
2. **Simplest structure that works.** One bounded task with local feedback is a plain loop. Use a
   graph only for explicit routing, joins, parallel branches, interruption or durable resume.
3. **Surgical.** The loop touches only the files its nodes own. Name the owner of every shared file.
4. **Goal-driven.** Every loop has a success command with an expected result. A model saying "done"
   is an observation, never acceptance evidence.

## Procedure
1. Write the one-sentence goal and the success command. No command means the goal is not ready:
   split it or add a human review node.
2. Choose plain loop or graph; justify it in one line under the title.
3. Fill the seven sections, in order (the evaluator requires these headings): Goal and input, State,
   Actions, Observation, Verification, Stop and escalation, Evidence.
4. Add `## Budget` with one `- budget <name>: <integer>` line per limit. Every retry cycle needs one.
   A requested limit is not a budget: the controller counts it, and recovery attempts count too.
5. Draw one ```mermaid block (`flowchart LR`). Terminals are `done`, `failed`, `escalated` and have no
   exits; every other node has an exit, is reachable from the first node and can reach a terminal.
6. The maker never accepts. Acceptance is a `verify*` node run by someone else: a command with an
   exit code, an independent reviewer, or a named human.
7. Checkpoints: what is persisted, by whom, where (files in git, not chat), and what happens when a
   node reruns after a resume. Prefer idempotent steps with a stable id per external effect.
8. `loop-eval graph docs/loops/<name>.md` until it prints `PASS`. Then walk each terminal by hand
   from the start and name the evidence that proves it.

## Contract shape
```
# Loop: <name>
Structure: <plain loop | graph>, because <one line>.
## Goal and input        ## State        ## Actions        ## Observation
## Verification          ## Stop and escalation            ## Evidence
## Budget
- budget rework: 2
(mermaid, one edge per line; full file in templates/loop.md)
           plan --> work ; work --> verify ; verify -->|pass| done ; verify -->|fail| rework
           rework -->|yes| work ; rework -->|budget spent| escalated ; verify -->|unsafe| failed
```
Write one edge per line: `a --> b` or `a -->|label| b`, optionally with a shape (`a[Text]`, `b{Text}`).
Chains such as `a --> b --> c` are not read as edges.

## The evaluator
- `loop-eval graph <loop.md>`: G0 structure (sections, Budget, graph shape, a budgeted cycle) plus
  S1 every edge out of a branching node is labelled; S2 budgets are positive and every retry (back)
  edge is labelled; S3 `done` is reachable only through a `verify*` node; S4 a `failed` or
  `escalated` exit exists.
- `loop-eval run <loop.md> <trace.jsonl>`: R0 the graph must pass first and the trace must parse;
  R1 an unbroken chain of steps from the first node to a terminal; R2 each step is a real edge with
  its exact label; R3 counters are budgets, never go down, stay within budget, and every retry edge
  increases one; R4 `done` needs an earlier `verify*` record by a `verifier` with command evidence
  `exit_code` 0, and no actor is both producer/runner and verifier; R5 evidence items are well formed;
  R6 known keys, roles and a non-empty actor; R7 `escalated` carries `decision` evidence; R8 `failed`
  carries evidence.
- Exit 0 PASS, 1 FAIL (one line per violation, rule id first), 2 usage. Same input, same verdict.

Trace record (one JSON object per line, exactly these keys):
`{"step":1,"node":"plan","to":"work","label":"","actor":"loop-runner","role":"runner",
"evidence":[{"kind":"command","ref":"npm test","exit_code":0}],"spent":{"rework":0}}`.
Roles: advisor, producer, runner, verifier, lead. Evidence kinds: command (needs an integer
`exit_code`), file, commit, report, decision. `spent` is cumulative. The terminal record has `"to":null`.

## The three loop agents
- `loop-advisor` (read-only): turns a task or a failed run into a design brief.
- `loop-producer`: writes `docs/loops/<name>.md` until `loop-eval graph` passes; never edits the evaluator.
- `loop-runner`: executes the loop, records the trace in `docs/loops/runs/<name>.<run-id>.jsonl`, and
  cannot accept its own work.

Sequence: advisor brief, producer contract, `graph` PASS, runner trace, `run` PASS, then the lead
re-runs the real success command itself. The lead (orchestrating session) is the only writer of shared
files. When a loop fails the evaluator, fix the loop or the run, never the evaluator.

## Pitfalls
- "Keep trying until done": no budget, no exit. Every cycle needs a counted budget and an `escalated` edge.
- A verify node the producer runs itself (R4 rejects the trace when the actor matches).
- Unlabelled branches: the runner cannot say which edge it took, and R2 compares labels exactly.
- A diagram with no executable meaning, or topology that changes at run time with no policy.
- Verifying in a copy of the working tree: build the check copy from `git archive HEAD` plus only the
  producer's files, or another agent's unfinished work fails (or passes) the check.
- Committing unverified work to quiet an "uncommitted changes" hook.
- New tests that were never mutation-checked: break the code once on purpose and watch one fail.
