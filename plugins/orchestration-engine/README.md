# orchestration-engine

The conductor behind the AI SDLC framework. One command, `/sdlc <task>`, takes a request from intake
to a verified draft PR; deterministic code (not prompts) decides what may run, in what order, with
which model, and when the work counts as done.

```
intake -> route (complexity score) -> spec-eval -> tech-design -> tech-design-eval
       -> implementation -> documentation | testing -> verify -> deliver (draft PR) -> retro
```

## What enforces what

| Concern | Mechanism |
|---|---|
| Is the task small or large? | **Complexity vector** `[S, D, H]` from git/repo state, no LLM (below) |
| Which model, token budget, steps? | **3-level matrix**: Level 1 skips design/eval (haiku, 5k cap); Level 2 full pipeline (sonnet, 50-150k); Level 3 isolation loop (opus) |
| Agent steps run in order, no skipping | `PreToolUse` gate on `Agent`: sequential stages, skipped steps denied, model filled in |
| Each step ends in draft / ask / decline | **State machine** fed by the agent's `<decision>` block (`SubagentStop`), policy applied on top |
| "Done" means verified | `sdlc-verify` runs the repo's checks and hashes the exact code; **delivery is refused** unless that hash is current and passing; a `Stop` hook blocks "done" while work is unverified |
| Humans stay in control | Decline gate, ask-clarification, a logged **override** only the user can authorize, draft PR, **never merges** |
| The pipeline learns | Run **history** and a capped, human-approved **lessons** file, both in the repo (`.sdlc/`) |

### Complexity vector

`S = 1.5*deltaLines + 10*files` (real `git diff` + untracked files, else a text estimate; `.sdlc/` ignored).
`D` = inbound references (`git grep` of the file's basename) + outbound imports. `H = 2*churn30d + 50*cosineDistanceToSpecs`
(TF-cosine against `specs/`; an unrelated spec counts as neutral 0.5, not as ambiguity). `M = sqrt(0.4S^2 + 0.4D^2 + 0.2H^2)`.
Level 1: M < 15, Level 2: 15-70, Level 3: > 70. Weights, ceiling and models are configurable.

### The state machine

Per step the agent reports `draft`, `ask_clarification` or `decline`; review steps (`spec-eval`, `tech-design-eval`, `testing`)
add `verdict: approve|revise`. Policy applied by the engine:

- Level 1: only `draft` (ask/decline coerced). Level 2-3: low-confidence `draft` becomes `ask_clarification`. Level 2 with `H > 40`: the first step must ask once.
- `revise` from `tech-design-eval` sends `tech-design` back; `revise` from `testing` sends `implementation` back (testing finding bugs is not a halt).
- Re-approving a step resets downstream steps that consumed its old output.
- Level 3: spec-eval and tech-design-eval need `minEvalCycles` (2) *independent* approvals (a revise resets the count).
- An exhausted revision loop asks the user (and restarts the budget) instead of halting.
- `decline` (or the Level 3 decline gate, `D > ceiling`) halts the run; `sdlc-lifecycle override --reason "..."` lifts it and is logged.
- A review step that never reports a verdict is **not** approved by default: it asks for a human look (Level 1 auto-approves by design).

## Commands

| | |
|---|---|
| `/sdlc <task>` | the whole flow; say "hotfix" for urgent fixes (design/eval skipped, testing + verify mandatory) |
| `/orchestrate <task>` | routing only |
| `/pipeline-status` | where the run stands |
| `/retro` | patterns from history and PR reviews -> proposed lessons / agent changes |
| `/agent-architect` | design or audit the agent team from run data |
| `/sdlc-setup` | one-time repo setup (`.claude/settings.json`, `.sdlc/verify.json`, `.sdlc/lessons.md`) |
| bins on `PATH` | `orchestrate`, `sdlc-lifecycle`, `sdlc-verify`, `sdlc-history`, `sdlc-lessons`, `sdlc-setup` |

### Verification: `.sdlc/verify.json`

```json
{ "commands": [
  { "name": "unit", "cmd": "dotnet test --nologo", "required": true, "timeoutSec": 900 },
  { "name": "ATF",  "manual": true, "note": "Run the NeedIt ATF suite on the dev instance" } ] }
```
`manual` checks cannot run in a container and are reported as **unverified here** in the PR. With no config the engine
autodetects `npm test` / `dotnet test`; with nothing at all it says "NOT CONFIGURED" - never a pass.

### Lessons: `.sdlc/lessons.md`

At most 20 one-line rules / 2 KB. `sdlc-lessons add "<rule>" --why "<evidence>"` edits the file in the working tree, so the change
rides in the PR and merging is the approval. The file is injected into each session at start and appended to every pipeline agent's prompt.

### History: `.sdlc/history.jsonl`

Every finished (completed / halted / abandoned) run is logged with per-step attempts, revisions and clarifications. `sdlc-history summary`
turns it into rates and signals (rubber-stamp review steps, frequent blockers); steps need 5 runs before they are judged. It lives in the
repo so it survives ephemeral web containers.

## Hooks (`hooks/hooks.json`)

| Event | Script | Job |
|---|---|---|
| `SessionStart` | `session-start.js` | exports session id / data dir / config to the Bash tool; injects lessons |
| `PreToolUse` Agent | `enforce-gate.js` | gate + model tier + lessons appended to the agent's prompt |
| `SubagentStop` | `record-step.js` | apply the decision block (blocks once if missing); resolves generic agents |
| `PostToolUse` Agent | `post-agent.js` | tells the conductor the next action, per step |
| `Stop` | `stop-gate.js` | verification before done; never blocks questions, halts, completion, the delivery checkpoint, or twice in a turn |

State is per session under the plugin data dir, written under a cross-process lock so parallel subagents cannot overwrite each other.
Decisions expire `decisionTtlHours` (6) after the last activity.

## Config

`tier1Model`/`tier2Model`/`tier3Model`, `declineDHardCeiling` (60), `decisionTtlHours` (6), `sdlcAgentPattern`, `churnWeight` (2),
`specDistanceWeight` (50), `minEvalCycles` (2), `maxEvalCycles` (4), `minConfidence` (0.5), `requireDecisionBlock` (true), `injectLessons` (true).

## Tests

`npm test` here (Node >= 20, no dependencies): 70 tests - matrix, cosine check, state machine, concurrency, hooks, verification, stop gate,
delivery, lessons, setup. Also exercised live in headless Claude Code runs (gate deny/allow, forced decision block, a full six-step pipeline with a real
test command, Stop-gate blocking).

## Known limits

- Token caps are advisory (Claude Code has no per-subagent hard limit). `D` coupling is a basename text search, not a symbol graph; cosine similarity is lexical.
- Generic agents (`general-purpose`) running two pipeline steps *in parallel* cannot be told apart; use named agents or `sdlc-lifecycle record`.
- ServiceNow ATF and other environment-bound checks cannot run in a container; they are listed as unverified, not skipped silently.
- `/sdlc-setup` writes the documented `.claude/settings.json` shape, which was not verified in a trust-gated session; the manual `/plugin` commands are the fallback.
- Nested `claude -p` runs inherit the parent's `CLAUDE_ENV_FILE`; avoid nesting sessions for real work.
