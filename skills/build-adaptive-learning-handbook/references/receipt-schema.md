# LearningSessionReceipt v1

Pass one JSON object with the following load-bearing fields:

```json
{
  "schema_version": 1,
  "topic": "流形",
  "observable_goal": "能从局部坐标、切空间与切丛三个层次解释光滑流形，并完成典型计算",
  "scenario": "concept_building",
  "deadline": null,
  "target_level": "graduate",
  "target_level_source": "explicit",
  "research_intent": "learning",
  "evidence_level": "observed",
  "diagnostic_items": [
    {
      "question_id": "q1",
      "concept_id": "legacy:topology-basis",
      "question": "……",
      "answer": "……",
      "verdict": "correct",
      "evidence_kind": "worked"
    }
  ],
  "knowledge_frontier": [
    {
      "concept_id": "legacy:tangent-bundle",
      "label": "切丛",
      "status": "in_progress",
      "blocked_by": ["legacy:tangent-space"]
    }
  ],
  "weak_points": ["切向量的坐标无关定义"],
  "learning_path": [
    {
      "stage": "从局部坐标到切空间",
      "objective": "能比较导子、曲线速度和坐标表示",
      "concepts": ["切向量", "坐标变换"],
      "completion_evidence": "独立完成同一点两张坐标图下的变换计算",
      "evidence_links": ["q2"]
    }
  ],
  "resources": [
    {
      "title": "资源标题",
      "url": "https://example.org/resource",
      "origin": "Web",
      "source_tier": "scholarly",
      "concept_id": "legacy:tangent-space"
    }
  ]
}
```

Rules:

- `scenario` is one of `concept_building`, `practice`, `exam_prep`, `real_world_application`.
- `target_level` is one of `foundation`, `undergraduate`, `graduate`, `advanced`, `research_readiness`.
- `target_level_source` is `explicit` when the learner selected it and
  `inferred` only when the learner skipped the selector but their worked
  diagnostic answers support the chosen level. Surface an inferred level in
  the handbook so it is correctable.
- `research_intent` is one of `learning`, `research_readiness`, `original_research`.
- Supply 2–4 answered diagnostic items. `会/不会` is allowed but must be labeled `evidence_kind=self_report`; a worked answer uses `worked`.
- Use exact CourseGraph concept IDs when an active graph exists. In legacy mode, use stable session-local IDs prefixed with `legacy:`; do not pretend they are activated graph nodes.
- Supply 4–6 learning-path stages. Every stage must link to at least one real diagnostic `question_id`.
- Preserve resource `origin` and `source_tier`. Never turn a Web resource into a graph resource.
- Do not pass secrets, provider keys, or raw private source documents.
