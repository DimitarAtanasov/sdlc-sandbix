# sdlc-agents

The six pipeline agents for the AI SDLC framework, aimed at ServiceNow scripted REST APIs,
Kafka integrations and .NET services.

| Agent | Step | Access | Output |
|---|---|---|---|
| `spec-eval-agent` | spec + evaluation | read/write | `specs/<slug>.md`, verdict approve/revise |
| `tech-design-agent` | tech design | read/write, project memory | `docs/design/<slug>.md` |
| `tech-design-eval-agent` | design evaluation | **read-only** | findings by severity, verdict |
| `implementation-agent` | implementation | read/write/Bash, project memory | code + verification |
| `documentation-agent` | documentation | read/write/Bash | updated docs from the real diff |
| `testing-agent` | testing | read/write/Bash | tests + real results |

Each agent evaluates its local state and ends with one decision block
(`draft` / `ask_clarification` / `decline`; see the contract in each file). The
`orchestration-engine` plugin records it and enforces sequential gating, level policy and model tier.
The agents also work standalone; without the engine the decision block is simply their report format.

The agents default to `model: sonnet`; the engine's gate overrides the model per complexity level.
