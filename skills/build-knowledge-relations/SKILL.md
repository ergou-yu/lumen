---
name: build-knowledge-relations
description: Build evidence-backed directed knowledge graphs from curricula, textbooks, notes, question banks, research plans, and learning histories. Use when Codex needs to discover or audit prerequisites, part-of links, equivalences, supports, contradictions, diagnostic links, or transfer links; create versioned CourseGraph packages; apply the MAPLE-Loop patent C1-C8 workflow; or use GLM to propose knowledge relations without treating model output as verified truth.
---

# Build Knowledge Relations

Construct a versioned CourseGraph in which every active edge has a defined meaning, bounded weight, traceable evidence, review state, and validation record. Treat GLM as a candidate generator only.

## Learning relations versus proof dependencies

CourseGraph `prerequisite` means learning readiness; `supports` means pedagogical
or methodological support. Even an active `equivalent_to` edge is not a verified
Lean theorem. Keep the learning graph and the proof-artifact dependency map in
separate schemas. A research handoff may cite a graph as background only; proof
dependencies must name exact declarations, complete assumptions, source/version
bindings and actual verification receipts. Graph review cannot close a proof
obligation or set `machine_verified`.

## Core boundary

- Never publish an LLM relation directly as truth.
- Separate semantic similarity from dependency strength. `edge_weight` means dependency strength and must remain in `[0, 1]`.
- Fail closed on missing evidence, unknown endpoints, invalid types, prerequisite cycles, or an incomplete certificate.
- Keep proposed, behavior-validated, reviewer-approved, challenged, and retired states distinct.
- Preserve graph versions so previous decisions can be replayed.

Read [references/patent-coursegraph.md](references/patent-coursegraph.md) before implementing or auditing an engine, changing schemas, or deciding whether an edge may become active.

## Configure GLM securely

When the user asks for a key-entry window or GLM is not configured, run:

```bash
python3 scripts/configure_glm_key.py
```

On macOS this opens a hidden-input native dialog. It validates the key with a minimal GLM request, then writes only to `${MATH_AI_SECRETS_FILE:-~/.config/math-ai/credentials.env}` with mode `0600`. Never ask the user to paste a key into chat, print the key, place it in source code, or commit the credentials file.

The verified high-quality default is `glm-5.3`, with mandatory thinking enabled for relation discovery. Before replacing it with a future model, check the official Zhipu model catalog and make a live minimal request with the user's account. Never silently downgrade to `glm-4-flash` or another legacy fallback. If the configured model is unavailable, stop with the provider error and let the user choose a supported model.

To upgrade the model attached to an already-saved private key without reopening the dialog, run:

```bash
python3 scripts/configure_glm_key.py --reuse-saved-key --model glm-5.3
```

Restart an already-running application server after configuration so environment-backed providers reload the secret.

In AutoClaw or a Feishu bot workspace, use that runtime's own `ZHIPU_API_KEY` environment binding or run deterministic `validate`. Do not read or copy another agent's credential file. A channel without an independent provider credential may validate candidate graphs but must not claim that it made a live GLM discovery request.

## Discovery workflow

1. Collect source material and assign a stable `source_id` to each document.
2. Extract candidate concepts, skills, theorems, formulas, representations, misconceptions, resources, and research tasks.
3. Merge aliases while preserving the original labels and source citations.
4. Ask GLM for candidate edges using only the seven supported relation types.
5. Verify every quoted evidence span against the supplied source text.
6. Normalize endpoints, merge duplicate edges, reject self-links, and constrain weights to `[0, 1]`.
7. Detect cycles in the `prerequisite` subgraph. Do not auto-publish a graph with a cycle.
8. Compute transitive reduction; retain removed indirect relations in the audit record.
9. Use behavior evidence when available. Lower or challenge an edge when mastery of its source does not improve target performance.
10. Emit an immutable graph version and a decision certificate. Publish only after the relevant review gate passes.

For MathSight Basic learning, feed only an accepted graph version into the learning frontier. Proposed edges may select diagnostic questions, but they may not block a learner path or become mastery evidence.

## Run discovery

Prepare JSON with `course_id`, `documents`, optional `candidate_nodes`, and optional `behavior_evidence`. See the input example in the patent reference.

```bash
python3 scripts/coursegraph_tool.py discover \
  --input /absolute/path/course-input.json \
  --output /absolute/path/course-graph.json
```

Use `--model` or `--base-url` only when the configured GLM deployment differs from the defaults. The command reads `ZHIPU_API_KEY` or `BIGMODEL_API_KEY` from the process environment or the private credentials file.

## Validate an existing graph

Run deterministic validation without an API call:

```bash
python3 scripts/coursegraph_tool.py validate \
  --input /absolute/path/course-graph-candidate.json \
  --request /absolute/path/course-input.json \
  --output /absolute/path/course-graph-validated.json
```

`--request` is mandatory when the candidate does not embed its original evidence-bearing request. The validator accepts temporary node IDs such as `N01`, normalizes them to stable `k_*` IDs, and resolves every edge through that alias map. It also preserves `retired` edges separately from active edges.

Candidate/model `reviewer_status` values are always ignored. Without an independent review the
validated graph remains `draft`. To activate reviewed edges, pass
`--review /absolute/path/course-graph-review.json`; the review must use
`coursegraph-human-review-v1`, bind the exact candidate checksum, name the human reviewer, carry
`human_attestation=true`, and decide every edge with a rationale. The validator records the review
checksum in its decision certificate. Never generate that attestation on a human's behalf.

After validation, generate the only reportable receipt:

```bash
python3 scripts/coursegraph_tool.py receipt \
  --input /absolute/path/course-graph-validated.json \
  --output /absolute/path/course-graph-receipt.json
```

Inspect `integrity_ok`, `hard_pass`, `errors`, `warnings`, `cycles`, relation counts, evidence coverage, and review counts from the receipt. A successful command does not mean the graph is pedagogically true; it means the structural, evidence, and certificate-integrity gates passed.

## Mandatory fail-closed handoff

- Never write, copy, summarize, or repair `validation`, `decision_certificate`, `hard_pass`, evidence coverage, checksums, or relation counts by hand.
- Never edit a validated graph or receipt. Change the candidate or request, then rerun `validate` and `receipt`.
- Treat a nonzero `validate` or `receipt` exit, `hard_pass=false`, or `integrity_ok=false` as a blocking failure. Report the exact validator errors and stop; do not replace them with a narrative success claim.
- Report counts only from the receipt file. Do not count table rows mentally.
- Distinguish the AutoClaw/chat model from the CourseGraph relation generator. If the outer agent used GLM but the relation CLI used only deterministic validation, report both facts.
- Keep the candidate, evidence-bearing request, validated graph, and receipt as four separate artifacts. Never overwrite the candidate with validator output or vice versa.

## Relation semantics

- `prerequisite`: source mastery materially enables target learning or execution; directed.
- `part_of`: source is a constituent of target; directed.
- `equivalent_to`: source and target express the same mathematical object or proposition under the stated scope; symmetric.
- `supports`: source provides useful but non-required evidence or technique for target; directed.
- `contradicts`: source conflicts with target under a shared scope; symmetric unless evidence specifies direction.
- `diagnoses`: source task or misconception provides evidence about target knowledge; directed.
- `transfers_to`: competence at source can transfer to target under stated conditions; directed.

Do not substitute `supports` or semantic similarity for `prerequisite` merely to make a path connected.

## Review and publication

- Keep model-only edges as `proposed` or `needs_review`; never accept a model-supplied review state.
- Allow `behavior_validated` only when sample size and measured uplift meet the configured policy.
- Require a reviewer for high-impact prerequisite, contradiction, and diagnosis edges.
- Set the graph status to `draft` whenever any hard error, prerequisite cycle, unverified evidence, or unapproved direct edge remains.
- Export active CoursePackages with nodes, edges, aliases, evidence index, schema manifest, signature, and version metadata.
- Feed only an accepted CourseGraphVersion into frontier selection, adaptive question generation, or rolling path planning.

## Output handoff

Report the graph version, node and direct-edge counts, proposed/review counts, removed transitive edges, evidence coverage, cycles, and exact output paths by reading the deterministic receipt. If blocked, name the failed gate, link the failed validated artifact, and keep the graph in draft state.
