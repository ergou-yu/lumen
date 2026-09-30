---
name: research-budget-controller
description: Configure and inspect an authorized monetary budget for Python research or Lean generation calls across providers in MathResearch. Use before a cost-bounded run or to explain reservations, unknown costs and budget stops; this skill does not grant spending authorization or control unrelated website or Gateway accounts.
---

# Research Budget Controller

The enforcement lives in `src/math_research_pipeline/research_budget.py` and
`llm.py`. Use one policy/SQLite database for every participating Provider, retry,
case, claim and stage sharing the authorized cap. Creating a fresh database is a
new allowance, not a way to resume an exhausted one.

Start with the existing authorization reference, amount and currency; exact
Provider/model identities; price snapshots and request bounds; the case, claim
or node, and stage; and already spent, reserved and unknown exposure. Reuse a
previously authorized allowance without requesting it again. Skill invocation
does not authorize a paid run or a larger cap. If a required input is missing,
prepare the concrete policy and explain that gap before dispatching paid work.

Run commands from the MathResearch project containing the Python module. On this
installation it is `/Users/yuvdediannao/Documents/MathResearch`.

Read [references/policy.md](references/policy.md) when setting up the policy. Obtain
current prices from official sources or an explicit account price agreement;
bind exact hosts/models and a finite validity interval. Never infer a price from
a similar model or combine currencies without a recorded conversion agreement.
No production prices or amounts are supplied by this skill.

Set `MATH_RESEARCH_BUDGET_POLICY` to the absolute policy path. For direct Python
clients also set `MATH_RESEARCH_BUDGET_CASE`, `MATH_RESEARCH_BUDGET_CLAIM`, and
`MATH_RESEARCH_BUDGET_STAGE`. Commander fills those three from its current case
and target. Every request needs explicit `max_output_tokens`. Show the ledger:

```bash
uv run python -m math_research_pipeline.research_budget <policy.json>
```

The policy is opt-in; unset does not mean a zero cost or a globally enforced cap.
The existing website's OpenAI/Gateway monthly ledger is separate. Do not claim
this local Python ledger includes website spending. Its common currency amounts
are micro-units: one million micro-units equals one currency unit.

Each HTTP attempt reserves the configured worst-case input ceiling plus output
cap before dispatch, under a SQLite write transaction. Successful responses
settle before content parsing, so malformed replies still consume money.
Timeouts, cancellations, missing/inconsistent usage, and unrecognized returned
model names preserve exposure. Never refund them on a timer or as zero-cost
errors. An observed bound overrun blocks further dispatch. Inspect provider
billing evidence before using the explicit reconciliation operation described in
the policy reference. It hashes and binds a supplied receipt; it does not
authenticate a bill or establish nonbilling from a network error.

When first adopting the ledger for an existing run, import all prior exposure
with `opening_balances`; repeated starts must preserve the same entries. If an
unknown liability has no defensible upper bound, the remaining allowance cannot
be established: keep paid execution stopped until it can be reconciled. Never
write a zero hold for an unknown amount.

Report settled, reserved, unknown and overrun exposure separately, with the
remaining allowance and exact blocking reason. The summary includes case →
claim → stage totals and attempt IDs. A retry is a new attempt and must reserve
again after the previous attempt has been settled or retained as unknown.

Reasoning is counted once inside output tokens for the supported billing
contract. Preserve raw usage, cache hit/miss counts and exact model provenance.
For other reasoning billing schemes, stop until an explicit adapter exists.

OpenClaw's internal model/tool retries currently expose no enforceable shared
reservation hook. Monetary-budget mode blocks that autopilot path before its
first review. Use the instrumented Python clients for bounded work; do not
label Gateway aggregate usage a provider billing receipt. Compilation remains
local and its real duration is in Lean compiler receipts.

The legacy synchronous GLM driver accepts `--budget-policy` and `--claim-id`,
also honors the policy environment variable, and disables hidden SDK retries.
Its same-provider review remains distinct from the Aletheia release workflow.
Uninstrumented external tools/services are outside this ledger: connect an
adapter before including them in a capped run. Money accounting does not replace
research, formal-verification or release gates.
