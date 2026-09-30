---
name: deepseek-harness-audit
description: Audit or implement a DeepSeek integration against the official DeepSeek Harness Developer Preview and current DeepSeek API rules. Use for dsh capability mapping, plan/todo, permissions, sessions/compaction, tools/jobs/LSP, skills/goals/subagents, OTEL/hooks, reasoning_content lifecycle, streaming, retries, evidence receipts, public traces, or release gates; never expose private reasoning.
---

# DeepSeek Harness Audit

Keep official `dsh` capabilities, DeepSeek API wire behavior, and Mirroria's local compatibility bridge distinct.

## Workflow

1. Read [references/protocol-sources.md](references/protocol-sources.md). Use official DeepSeek Harness sources for `dsh` architecture and capability claims, and official DeepSeek API documentation for provider wire behavior. Treat the HenryZ/ModelBest C1-C10 project only as a separate supplemental protocol reference.
2. Pin source, version, commit, maturity, and integration mode before testing. Official `dsh` is a Developer Preview; assume compatibility-breaking changes.
3. Label each capability as one of:
   - `runtime-connected`: the official `@deepseek-ai/dsh` process or package is demonstrably running.
   - `catalogued-not-runtime-bound`: an official capability is mapped but not executed.
   - `mirroria-native`: implemented by Relay without launching official `dsh`.
4. Never infer runtime integration from matching names or UI labels. Verify the process/package boundary, configuration, emitted provenance, and observable behavior.
5. Create only a public plan: objective, observable stages, allowed tool names, and evidence requirements. Do not record chain-of-thought or hidden reasoning.
6. Gate message history, context size, `max_tokens`, `user_id`, tool definitions, and the `/beta` plus tools incompatibility before an API request.
7. Treat tool calls as proposals. Validate tool name and arguments against a bounded schema; execute only through the host application's approval, allowlist, and sandbox.
8. Preserve tool-call `reasoning_content` only where required for subsequent API requests. Never emit it to events, logs, evidence, summaries, or UI.
9. Aggregate public SSE text and indexed parallel tool deltas. Ignore keep-alives and empty chunks. Post-validate completed tool calls.
10. Retry only transient transport, 408, 429, 500, 502, 503, and 504 failures; honor `Retry-After`. Never replay after a side effect, abort, or schema failure.
11. Record observable evidence only: HTTP status, request ID, model, finish reason, usage, output hash, public character count, tool count, and gate results.
12. Produce a public work summary with completed stages, evidence IDs, retry count, capability status, and remaining risks. Discussion alone is not delivery evidence.

## Release gates

- Identify `deepseek-ai/deepseek-harness` as the official MIT-licensed DeepSeek AI project and mark its Developer Preview status.
- Do not claim official sessions, compaction, tools, jobs, LSP, skills, goals, subagents, OTEL, or hooks are active unless a real upstream runtime/package boundary is verified.
- Do not claim local file, terminal, browser, or network authority from a catalog mapping. Host policy owns those capabilities.
- Do not expose `analysis`, `reasoning_content`, `thinking`, `thought`, `chain_of_thought`, credentials, cookies, or authorization headers.
- Do not accept unknown tools, invalid arguments, oversized context, invalid `user_id`, or tools on a `/beta` endpoint.
- Do not mark completion without an evidence receipt tied to observable output.
- Distinguish estimated cache reuse from provider-reported cache usage.

## Output

Report official `dsh` provenance and mapped capabilities, provider API rules, Mirroria-native implementation, tests, and live-runtime/API uncertainty separately. Cite the primary source nearest each claim.
