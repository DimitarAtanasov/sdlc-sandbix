# sdlc-sandbix

Sandbox marketplace for the AI SDLC plugin framework.

## Plugins

- **[orchestration-engine](plugins/orchestration-engine/)** - the Automated
  Orchestration Engine: computes the Complexity Vector & Magnitude from
  local repo/git state and routes every task through the 3-level execution
  matrix (pipeline strategy, model tier, token cap, 3-way decision) before
  any LLM is invoked. Includes a `/orchestrate` skill and a `PreToolUse`
  hook that auto-gates the spec/eval, tech-design, tech-design-eval,
  implementation, documentation, and testing agent calls that follow.

## Install (works entirely from the Claude Code mobile/web app - no local CLI needed)

```
/plugin marketplace add dimitaratanasov/sdlc-sandbix
/plugin install orchestration-engine@sdlc-sandbix
```

Then just describe a task and say "orchestrate this" - the engine handles the
rest from your phone: complexity analysis, pipeline routing, model tier
selection, and gating the downstream SDLC agents.

## specs/

Optional: drop your spec docs (`.md`) here, or under `docs/specs/`, so the
orchestration engine's H-factor (Historical Uncertainty Density) can measure
how closely a new task description matches what's already specified, instead
of falling back to its neutral default.
