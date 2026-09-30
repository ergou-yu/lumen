# DeepSeek Harness sources and capability boundary

## Provenance

The official repository is <https://github.com/deepseek-ai/deepseek-harness>. It is developed by DeepSeek AI, licensed under MIT, published as `@deepseek-ai/dsh`, and explicitly marked Developer Preview with compatibility-breaking changes expected.

Mirroria reviewed commit `47f943859bef60e4160492346772ded9b24f765a`, whose CLI package version is `0.1.0-rc.5`. Pin both commit and version in audit evidence; do not treat this snapshot as a stable API promise.

The similarly named <https://github.com/HenryZ838978/deepseek-harness> is a distinct community project by Henry Zhang / ModelBest. Its C1-C10 rules may supplement API protocol tests but do not define the official `dsh` runtime.

## Primary sources

| Area | Primary source | Audit use |
| --- | --- | --- |
| Official identity, package, maturity | <https://github.com/deepseek-ai/deepseek-harness> | DeepSeek AI ownership, `npx @deepseek-ai/dsh web`, Developer Preview, MIT. |
| Architecture and events | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md> | Plugin tree, durable session log, live agent events, guarded tool pipeline, jobs, UI/event integration. |
| Capability seams | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md> | Service definitions/providers/consumers, approval/sandbox, filesystem, subprocess, LSP, subagent and related boundaries. |
| Tool catalog | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md> | Plan mode, todo, file/shell, jobs, LSP, skill, goal, subagent, session-query and web tool schemas. |
| Generated config catalog | <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md> | Compaction, permission presets, session telemetry OTEL, Codex/Claude hooks and provider config. |
| Official license | <https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE> | MIT. |
| Thinking/tool lifecycle | <https://api-docs.deepseek.com/guides/thinking_mode/> | Thinking control and internal round-trip of tool-call `reasoning_content`. |
| Rate limits and isolation | <https://api-docs.deepseek.com/quick_start/rate_limit/> | 429 behavior, non-identifying `user_id`, keep-alive comments, long waits. |
| Error handling | <https://api-docs.deepseek.com/quick_start/error_codes/> | Transient versus terminal status classes. |
| Context cache | <https://api-docs.deepseek.com/guides/kv_cache> | Prefix cache and reported hit/miss usage fields. |
| Supplemental C1-C10 | <https://github.com/HenryZ838978/deepseek-harness/blob/main/README.md> | Additional wire-protocol regression cases only; never official runtime provenance. |

## Official capability catalog

These are verified upstream capabilities, not proof that Mirroria runs them:

| Capability group | Upstream examples | Mirroria 3.5 status |
| --- | --- | --- |
| Plan and todo | `@deepseek-ai/dsh-plan-mode`, `@deepseek-ai/dsh-tool-todo` | `catalogued-not-runtime-bound` |
| Permissions, approval, sandbox | `@deepseek-ai/dsh-permission-presets` and approval/sandbox seams | `catalogued-not-runtime-bound` |
| Sessions and compaction | append-only session log, persistence/query/fork/resume, basic compaction, tool-result pruning | `catalogued-not-runtime-bound` |
| Tools, jobs, LSP | guarded registry, `job_*`, `lsp` | `catalogued-not-runtime-bound` |
| Skills, goals, subagents | filesystem skill provider, goal lifecycle, in-process/ACP/Codex/Claude/dsh SDK providers | `catalogued-not-runtime-bound` |
| Telemetry and hooks | `@deepseek-ai/dsh-session-telemetry-otel`, Codex and Claude Code hook bridges | `catalogued-not-runtime-bound` |

## Mirroria-native capability

The current adapter does not install, import, or launch `@deepseek-ai/dsh`. It uses the existing DeepSeek API Key through Relay and implements these capabilities locally:

- DeepSeek API request/history/context/tool schema guards.
- SSE aggregation and provider usage normalization.
- Public plan and public trace.
- Observable evidence receipt and delivery gate.
- Bounded, side-effect-aware retry.
- Public work summary without hidden reasoning.

Tool execution remains owned by Relay's approval and sandbox layer. A future official-runtime integration must change the integration status only after process/package, configuration, events, permissions, and end-to-end behavior are independently verified.

## Compatibility decision

Current DeepSeek API documentation requires an assistant tool-call message's `reasoning_content` in later requests for that conversation. Mirroria preserves it internally for tool-call messages and strips non-tool reasoning from public turns. Private reasoning never enters public events, logs, evidence, or summaries.
