---
name: orchestrate
description: Compute the complexity vector [S, D, H] and magnitude M for a task and start a gated pipeline run - returns the level, pipeline strategy, model tier, token cap and 3-way decision (draft / ask clarification / decline). This is the routing step of /sdlc; use it alone when the user only wants to know how complex a task is or how it would be routed.
---

# Orchestrate (routing only)

For the full flow - intake, pipeline, verification, delivery, retro - use `/sdlc`.
Use this skill when the user just wants the routing decision.

```
orchestrate "<task description verbatim>"        # add --files a.cs,b.cs, --json or --hotfix
```

The wording matters: it feeds the H-factor spec-similarity check. The command prints the
vector, magnitude and decision, and starts a fresh pipeline run for this session (an
unfinished earlier run is logged as abandoned).

| Level | Meaning |
|---|---|
| 1 (M < 15) | design/eval skipped; only `draft` is allowed; Tier 3 model; 5,000-token cap |
| 2 (15-70) | full sequential pipeline; Tier 2 model; dynamic cap; H > 40 forces the first step to ask |
| 3 (> 70) | isolation loop: spec-eval and tech-design-eval need several independent approvals; Tier 1 model; DECLINE if D is above the ceiling |

Report the level, model tier and decision in three lines. On DECLINE explain what information
would make the task safe; only the **user** may lift it with a reason:
`sdlc-lifecycle override --reason "<their reason>"`.

## Notes

- Uses the real `git diff` plus untracked files when code exists (the framework's own `.sdlc/`
  files are ignored); before that it estimates from the task text.
- H uses TF-cosine similarity against `specs/**/*.md` (or `docs/specs/`). A spec sharing almost no
  vocabulary with the task is unrelated (neutral 0.5), not evidence of ambiguity.
- A decision stays valid for `decisionTtlHours` (default 6) after the **last activity** on the run.
- State is per session. Token caps are advisory: Claude Code has no per-subagent hard limit.
