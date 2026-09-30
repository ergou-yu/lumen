# Adaptive depth policy

The deterministic builder selects one profile. Do not select by topic name alone.

| Profile | Selection | Emphasis |
|---|---|---|
| `exam_compact` | `scenario=exam_prep`, demonstrated mastery is strong, and the goal is bounded | Tested objectives, compact method map, worked examples, traps, timed practice |
| `concept_systematic` | Default, including weak or mixed prerequisites | Mental model, definitions, examples/counterexamples, dependency repair, guided practice |
| `advanced_theory` | `target_level` is `graduate` or `advanced`, without original-research intent | Theorem relations, assumptions, proof ideas, canonical constructions, transfer |
| `research_readiness` | Explicitly preparing to read papers or develop research prerequisites | Definition/theorem map, proof techniques, reading sequence, readiness gaps, non-activating research bridge |

The number of GLM sections is derived from the selected profile and evidence complexity:

- `exam_compact`: compact core plus worked and timed practice sections.
- `concept_systematic`: split core explanation when there are several weak points.
- `advanced_theory`: add theorem/proof and canonical-construction sections.
- `research_readiness`: add proof-technique, reading-map, and readiness-gap sections.

These are semantic envelopes, not fixed word quotas. The validator applies only minimum completeness floors and never pads a document to a target length.

If the request asks for a new theorem, originality, novelty, a publishable result, or paper release, classify it as `original_research` and stop. The user must explicitly activate the separate research workflow.
