# Python research budget policy

`research-budget/v1` is parsed by `BudgetPolicy` with unknown fields rejected.
Create a JSON object containing these fields after determining the actual
authorized amount and the provider pricing contract:

| Field | Value |
|---|---|
| `schema_version` | `research-budget/v1` |
| `currency` | One ISO currency code, e.g. `USD` or `CNY` |
| `limit_microunits` | Positive integer, authorized total for this ledger |
| `database` | SQLite path, relative to policy file or absolute |
| `prices` | List of exact host/model price snapshots below |
| `authorization_reference` | Existing user authorization or approved run record; supply it for new policies |
| `opening_balances` | Prior spent/reserved/unknown exposure when adopting a new ledger; default `[]` for a genuinely new run |

Each price entry has `provider`, `host` (hostname only), `model`, `source` (official
page or account-contract reference), timezone-aware `checked_at` and `valid_until`,
nonnegative decimal strings `input_per_million`, `cached_input_per_million`,
`output_per_million`, and `reasoning_billing="included_in_output"`.

Required positive integer bounds are `max_request_bytes`,
`max_billed_input_tokens`, and `max_output_tokens`. The input ceiling must cover
the model's full possible billed input, including schema/framing, under the
applicable context limit. It is a reservation bound, not a token estimate.
Use conservative official bounds and the highest rate applicable throughout the
validity period. A larger request is rejected, not truncated. Tool-using or
multi-generation requests need an instrumented adapter and are not covered by
these single-generation Python calls.

Changing the cap or currency of an existing database is rejected. A fresh dated
price snapshot may share the existing ledger; each reservation keeps its own
snapshot and policy hash. Preserve the database across process restarts and all
participating clients. Separate databases are separate caps and must not be
presented as one global budget. The SDK's returned usage is a usage-derived
charge at the snapshot rate, not a reconciled provider invoice.

## Existing exposure and resume

Each opening balance has a unique `id`, `scope` (`case`, `claim`, `stage`), exact
`provider` and `model`, `state` (`settled`, `reserved`, or `unknown`), integer
`amount_microunits`, and `evidence_reference`. Use actual charges for settled
items and a positive conservative upper bound for outstanding holds. These
entries are inserted atomically only into a ledger with no prior attempts and
receive attempt IDs `opening:<id>`. Reopening does not import them twice.

Authorization reference and opening entries are immutable after initialization.
Preserve them in later price snapshots. Existing v1 ledgers can be opened with
empty opening balances without changing prior attempt records. Do not edit
SQLite balances by hand, remove a database or change its path to reset exposure.

Every attempt retains its price snapshot, request hash, scope and reported
usage. The event journal records reservations, finishes and reconciliations in
the same transaction as the corresponding balance change. Request prompts and
credentials are not persisted in this ledger. SQLite uses `BEGIN IMMEDIATE`
and `synchronous=FULL` on the shared local database. Separate files, remote
hosts and uninstrumented tools do not share an atomic allowance.

## Reconcile an outstanding hold

Only use billing evidence already checked against the actual Provider bill or
request-specific nonbilling confirmation. Save a JSON object with:

| Field | Value |
|---|---|
| `schema_version` | `research-budget-reconciliation/v1` |
| `attempt_id` | Exact outstanding attempt ID from the ledger |
| `provider`, `model`, `currency` | Exact attempt identity and ledger currency |
| `actual_microunits` | Verified nonnegative integer charge; zero requires explicit nonbilling evidence |
| `evidence_reference` | Locatable billing record or Provider confirmation, including the item/request identifier |

Apply it with `uv run python -m math_research_pipeline.research_budget <policy.json>
--reconcile <receipt.json>` (one command line). The controller preserves the
receipt content, file hash and previous state. Reapplying the identical receipt
is idempotent; changed receipts cannot rewrite already settled or overrun items.
Only `reserved`/`unknown` holds are eligible. A charge above its reservation
records an overrun and blocks further calls. Receipt validation is local binding,
not independent authentication of the billing claim.

## Read the result

`settled_microunits` is resolved cost at the saved rates or reconciled charge;
`reserved_microunits` is in-flight exposure (including abandoned processes);
`unknown_microunits` is retained uncertain exposure; `overrun_microunits` retains
the greater of reservation and reported charge. `held_microunits` sums the last
three, `exposure_microunits` adds settled charges, and `available_microunits` is
the nonnegative difference from the cap. Unknown exposure is already included
in held exposure: do not add it a second time.

`cases` rolls totals up by case → claim → stage, with leaf attempt IDs.
`attempts` and `events` contain the detailed receipt trail. No allowance is
released merely because a process exits or a reservation is old. Request
duration and transport error type are recorded where available; compiler
duration remains in the actual Lean verifier receipt.

Test fixtures use synthetic prices. Never copy them into a production policy.
