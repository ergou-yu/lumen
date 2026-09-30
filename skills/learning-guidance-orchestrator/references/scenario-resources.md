# Scenario-Based Resources

Resource discovery (the `discover-learning-resources` skill /
`discover_resources(_sync)` in basic_resources.py) selects and ranks
resources. Without a scenario it defaults to `concept_building` query cues
("讲解 / 教程 / 例题"), which is why it cannot tell exam prep from
real-world use. The scenario is a **ranking-only signal**; it never touches
provenance fields (`origin`, `source_tier`, cap, checksums).

## The four scenarios

| scenario | when to pick it | query intent | ranking bias |
|---|---|---|---|
| `concept_building` | learner is first acquiring the concept; needs intuition + worked exposition | "讲解 / 直觉 / 为什么" | primary and scholarly expository sources (textbook chapters, lecture notes) over bare problem sets |
| `practice` | learner understands the concept and needs to consolidate with problems | "练习 / 习题 / 题解" | community problem sets and worked solutions; tier `community` weighted up within the cap |
| `exam_prep` | fixed assessment, time-bounded; needs past papers, mark schemes, common trap items | "真题 / 考研 / 期末 / 模拟" | official/past-paper and exam-board sources first; items that expose common mistakes boosted |
| `real_world_application` | learner wants where this is actually used (实战), not exam drill | "应用 / 工程实例 / 案例" | applied/engineering sources and case studies; pure drill de-prioritised |

Choose the scenario from Stage 0 intent, not from the topic. "同胚" with goal
"应付期末" → `exam_prep`; the same topic with goal "做几何建模能用上" →
`real_world_application`.

## How the scenario changes discovery (engine contract)

The scenario threads through `discover_resources_sync(..., scenario=...)` and
changes two places only:

1. **Web query cues** in `_build_query` (basic_resources.py:392). Each
   scenario has a zh cue set and an en cue set; the goal+concept base is
   invariant. `concept_building` keeps the legacy "数学 讲解 教程 例题" so
   failures stay backward-compatible.
2. **Ranking sort key** in `_rank_and_cap` (basic_resources.py:328). A
   scenario preference map promotes resources whose title/snippet/domain
   match the scenario intent — but only **within an equal `(tier, origin)`
   group**. The hard rule stands: a `graph`-origin reviewed CourseGraph link
   always beats a `web` hit at the same tier, and the provenance fields are
   never rewritten.

This keeps the existing fail-closed contract intact (cap strictly < 5 per
concept; `origin` and `source_tier` load-bearing; fail closed on no key / no
network; read-only on the graph) while letting the same concept surface
different material for different uses.

## What never changes with scenario

- The per-concept cap (strictly < 5). Scenario never raises it.
- `origin` labels. A web hit is never relabeled `图谱` regardless of scenario.
- `source_tier`. Provenance is the reviewer's chain of custody.
- The graph walk (prerequisite / part_of / supports / transfers_to, ≤ 2 hops,
  active edges only).
- Fail-closed behaviour: no key → graph only; provider error → that concept
  keeps its graph resources.

## Reporting to the learner

Show the scenario with the resource block so the learner can see *why* these
particular resources surfaced and ask for a different scenario:

```
📚 学习资源（场景：考试复习；每知识点 ≤4 条；<coverage_note>）
— <concept label>（<relation>·<hops>跳）
  1. <title> — <url> （图谱|Web·<tier>）
```

If the chosen scenario returns weak coverage, offer to re-run with a
neighbouring scenario (e.g. `exam_prep` → `practice`), not to relax the cap.
