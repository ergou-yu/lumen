# MAPLE-Loop CourseGraph reference

This reference distills the CourseGraph requirements from the user's `通用技术交底7172012.pdf`. It is an implementation aid, not a substitute for the source patent when legal wording or claim scope matters.

## Contents

- C1-C8 construction sequence
- Supported graph schema
- Discovery input example
- Evidence rules
- Default behavior policy
- Graph publication package
- MAPLE-Loop handoff

## C1-C8 construction sequence

1. C1: Extract candidate nodes from curriculum standards, textbook structure, definitions, formulas, and examples.
2. C2: Merge synonymous nodes and assign stable `concept_id` values.
3. C3: Propose or annotate prerequisite edges and assign dependency strength in `[0, 1]`.
4. C4: Detect directed cycles in the prerequisite subgraph. Require review to relabel or remove at least one edge.
5. C5: Compute reachability and transitive reduction. Preserve direct prerequisites and auditable indirect prerequisites separately.
6. C6: Bind item Q-matrix rows, misconception prototypes, formulas, resources, and course evidence to nodes.
7. C7: Validate edge predictive power with historical response sequences. Lower or challenge an edge when source mastery does not improve target performance.
8. C8: Publish an immutable `CourseGraphVersion`; create a new version for every node or edge change.

## Supported graph schema

Node types:

- `concept`
- `skill`
- `theorem`
- `formula`
- `representation`
- `misconception`
- `resource`
- `research_task`

Edge types:

- `prerequisite`
- `part_of`
- `equivalent_to`
- `supports`
- `contradicts`
- `diagnoses`
- `transfers_to`

Every edge must include `source_node`, `target_node`, `relation`, `edge_weight`, `evidence_sources`, `reviewer_status`, and `valid_from_version`. Store semantic confidence separately from dependency weight.

Candidate graphs may use temporary node identifiers such as `N01`, but deterministic validation must resolve them to the immutable `concept_id` values emitted in the validated graph. Preserve retired edges in a separate audit collection; do not include them in active-edge counts, cycle checks, or evidence coverage.

## Discovery input example

```json
{
  "course_id": "middle-school-linear-function",
  "documents": [
    {
      "source_id": "textbook-8-14",
      "title": "一次函数",
      "source_type": "textbook",
      "content": "在平面直角坐标系中……斜率表示两个变量变化量的比。"
    }
  ],
  "candidate_nodes": ["平面直角坐标系", "变化量", "比例关系", "斜率", "一次函数图像"],
  "behavior_evidence": [
    {
      "source": "比例关系",
      "target": "斜率",
      "performance_lift": 0.12,
      "sample_size": 80
    }
  ]
}
```

## Evidence rules

- Require each model-proposed edge to cite at least one supplied `source_id` and a verbatim span that can be found in that source.
- Revalidate quotes against the original source documents. A candidate's own `verified: true` flag is never evidence.
- Reject emitted edges with zero or negligible weight; omission is safer than inventing a connection.
- Never accept a reviewer status supplied by the model itself.
- Cap confidence and set `needs_review` when evidence is missing or cannot be verified.
- Keep contradictory evidence instead of discarding it; route the edge to review.
- Treat historical performance as validation evidence, not proof of causality.
- Require scope text for `equivalent_to` and `contradicts` when the relation is conditional.

## Default behavior policy

The following are implementation defaults, not patent claims:

- With `sample_size >= 30` and `performance_lift >= 0.08`, increase the edge weight by at most `0.10` and mark `behavior_validated`.
- With `sample_size >= 30` and `performance_lift <= 0.02`, halve the edge weight and mark `needs_review`.
- With insufficient samples, leave the edge `proposed`.
- Never activate a graph containing a prerequisite cycle.

Adjust these thresholds only with a recorded `PolicyVersion` and validation data.

## Graph publication package

The patent's minimum reusable package includes:

- `graph_nodes.jsonl`
- `graph_edges.jsonl`
- `concept_alias.csv`
- `evidence_index.jsonl`
- `misconception_catalog.json`
- `strategy_rule_catalog.json`
- `schema_manifest.json`
- `package_signature`

For a smaller draft, a single JSON file may contain these objects, but retain their field boundaries so it can be expanded into the full package.

## MAPLE-Loop handoff

Only an accepted `CourseGraphVersion` may drive:

- target ancestor expansion and frontier scoring;
- prerequisite readiness and minimum-value gating;
- item retrieval and coverage-gap detection;
- active diagnostic questions for uncertain edges;
- rolling learning or research path planning;
- replayable `DecisionCertificate` records.

Keep relationship discovery upstream from LearnerState updates and never replace probabilistic state with free-form model advice.
