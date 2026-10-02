# sdlc-sandbix

Sandbox marketplace for the AI SDLC plugin framework.

## Plugins

- **[orchestration-engine](plugins/orchestration-engine/)** - the Automated
  Orchestration Engine: computes the Complexity Vector & Magnitude from
  local repo/git state and routes every task through the 3-level execution
  matrix (pipeline strategy, model tier, token cap, 3-way decision) before
  any LLM is invoked. Includes a `/orchestrate` skill, hooks that gate and record
  every pipeline agent call, run history, and `/agent-architect` to design or
  audit the agent team from real run data.

- **[sdlc-agents](plugins/sdlc-agents/)** - the six pipeline agents (spec-eval, tech-design,
  tech-design-eval, implementation, documentation, testing) for ServiceNow scripted REST, Kafka
  and .NET work. Each reports a draft / ask_clarification / decline decision the engine enforces.

## Install (works entirely from the Claude Code mobile/web app - no local CLI needed)

```
/plugin marketplace add dimitaratanasov/sdlc-sandbix
/plugin install orchestration-engine@sdlc-sandbix
/plugin install sdlc-agents@sdlc-sandbix
```

Then describe a task and run `/orchestrate <task>`: the engine analyses complexity, picks the
pipeline, model tier and token cap, and gates and records every pipeline agent that follows.

## specs/

Optional: drop your spec docs (`.md`) here, or under `docs/specs/`, so the
orchestration engine's H-factor (Historical Uncertainty Density) can measure
how closely a new task description matches what's already specified, instead
of falling back to its neutral default.
