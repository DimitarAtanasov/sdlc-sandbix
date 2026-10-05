---
name: pipeline-status
description: Show the current AI SDLC pipeline run - complexity level, each step's status (pending, running, approved, needs_clarification, revise, declined, skipped), open clarification questions, and the next action. Use when the user asks where the SDLC pipeline stands or what is blocking it.
---

Run:

```
sdlc-lifecycle status
```

Report the level, which steps are approved, what is blocking the pipeline
(open questions or the halt reason), and the next action. If it says there is
no fresh orchestration decision, tell the user to run `/orchestrate "<task>"`.
