# orchestration-engine

The Automated Orchestration Engine for the AI SDLC framework (spec/eval ->
tech-design -> tech-design-eval -> implementation -> documentation ->
testing). Runs deterministic static analysis on a task before any LLM is
invoked, then routes it through the 3-level execution matrix.

## What it computes

**Complexity Vector** `C = [S, D, H]`:

- `S` Structural Mutation Score - `1.5*deltaLines + 10*fileCount`, from a
  live `git diff`/untracked-file scan when implementation has started, or a
  text-length estimate when the task is still just a description.
- `D` Dependency & Coupling Depth - sum of inbound references (`git grep`
  hits on each file's basename elsewhere in the repo) and outbound
  dependencies (import/using/require-like lines) across the target files.
- `H` Historical Uncertainty Density - `2*gitChurn30d + 50*cosineDistanceToSpecs`,
  where the cosine distance is a deterministic TF-cosine similarity against
  `specs/**/*.md` (no embeddings/LLM call).

**Magnitude** `M = sqrt(0.4*S^2 + 0.4*D^2 + 0.2*H^2)`, mapped to:

| Level | M range | Pipeline | Model tier | Token cap |
|---|---|---|---|---|
| 1: Micro-Task | M < 15 | Skip Design/Eval, immediate execution | Tier 3 (fast/cheap) | 5,000 hard cap |
| 2: Standard | 15 <= M <= 70 | Full pipeline, sequential gating | Tier 2 (balanced) | dynamic 50k-150k |
| 3: Macro Arch | M > 70 | Isolation loop, forced multi-cycle eval | Tier 1 (deep reasoning) | max context window |

Model tiers default to Claude's `opus`/`sonnet`/`haiku` (the closest local
equivalents to the spec's o-series/Gemini-Reasoning examples) and are
overridable via plugin user config.

## Usage

From any session (including phone/web), just say what you want built and
ask Claude to run `/orchestrate`, or invoke it directly:

```
/orchestrate Add a u_priority_override field to the NeedIt scripted REST API and validate it server-side
```

This prints the vector/magnitude/decision and persists it so the bundled
`PreToolUse` hook (`hooks/hooks.json` -> `scripts/enforce-gate.js`) can
automatically gate and route the `Agent` tool calls that follow: it denies
calls to skipped pipeline steps, denies everything under a Level 3 Decline
Gate, and fills in the mandated model tier when one wasn't set.

You can also run the CLI directly (it's on `PATH` as `orchestrate` while the
plugin is enabled):

```
orchestrate --json "Refactor the Kafka consumer offset handling"
```

## Known v1 limitations

- The enforcement hook keys off a single `last-decision.json` in the
  plugin's data directory (not per-session), so two SDLC tasks worked
  concurrently in different sessions will share/overwrite each other's
  routing decision. Re-run `/orchestrate` at the start of each task.
- `D`'s "Inbound References" uses a basename text search (`git grep -l`),
  not a real symbol-level dependency graph across .NET solutions, Kafka
  schemas, and SN scripts - it's a fast proxy, not exact coupling analysis.
- The H-factor's spec-similarity check is TF-cosine, not embeddings; it's
  intentionally cheap and deterministic so the gate stays LLM-free, but
  it will miss paraphrased similarity that an embedding model would catch.
- The formula weights cosine distance heavily (`50x`), so a short task with
  no overlap with any file in `specs/` scores H=50 and yields to
  *Ask Clarification* at Level 2 even when it's trivial. Add relevant specs
  to `specs/` (or tune the weights) to reduce those false ambiguity flags.
