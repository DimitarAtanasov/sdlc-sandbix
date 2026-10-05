# sdlc-sandbix

Sandbox marketplace for the AI SDLC plugin framework.

## Plugins

- **[orchestration-engine](plugins/orchestration-engine/)** - the conductor. `/sdlc <task>` runs the whole flow: complexity
  routing, gated pipeline, deterministic verification, delivery as a draft PR, and a retro. Hooks enforce the rules; a
  capped human-approved lessons file and run history in `.sdlc/` make it learn.
- **[sdlc-agents](plugins/sdlc-agents/)** - the six pipeline agents (spec-eval, tech-design, tech-design-eval, implementation,
  documentation, testing) for ServiceNow scripted REST, Kafka and .NET work.

## Install (works entirely from the Claude Code mobile/web app - no local CLI needed)

```
/plugin marketplace add dimitaratanasov/sdlc-sandbix
/plugin install orchestration-engine@sdlc-sandbix
/plugin install sdlc-agents@sdlc-sandbix
```

Then, in the repo you want to work on, run `/sdlc-setup` once (commit what it writes), and from then on just
`/sdlc <describe the change>`. It asks only what it must, runs the agents in order, verifies the result, and
asks before opening a draft PR. Nothing is ever merged automatically.

## specs/

Optional: drop your spec docs (`.md`) here, or under `docs/specs/`, so the
orchestration engine's H-factor (Historical Uncertainty Density) can measure
how closely a new task description matches what's already specified, instead
of falling back to its neutral default.
