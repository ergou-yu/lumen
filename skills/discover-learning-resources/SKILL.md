---
name: discover-learning-resources
description: Discover learnable resources anchored on a CourseGraph for a MathSight Basic learning plan. Use when a learner (or the Feishu `!basic` bot) needs resources attached to a learning path — walk prerequisite/supports/transfers_to/part_of relations 1–2 hops from the goal and frontier, merge CourseGraph resource links with optional Tavily/Serper web fallback, and cap each concept at strictly fewer than five resources. Fails closed when no API key is configured; never fabricates web resources.
---

# Discover Learning Resources

Attach **learnable resources** to a MathSight Basic plan's learning path.
Walk the CourseGraph to find related concepts, then collect resources for
each one from the graph itself and, when configured, from web search. This
closes the gap where the bot emits a learning path but no resources to study
along it.

## Scope of retrieval

This is learning-resource retrieval after a Basic path exists. A Lean worker
looking for an exact fixed-version declaration should inspect its toolchain and
library through `lean-proof-workflow`; do not load a learner assessment, build a
handbook, or relabel web teaching resources as formal proof dependencies.

## When to use

- The Feishu `!basic` command (or any caller) builds a v2 plan on an
  **activated** CourseGraph and wants resources attached to the path.
- A reviewer asks "what can I actually read for these concepts?"

## Hard contract

- **Only on an activated graph.** `graph_status == "active"` and
  `hard_pass == True`. Draft graphs or graphs with outstanding review may
  *diagnose* but must not publish learnable resources as if reviewed.
- **One cap per concept, strictly < 5.** `max_per_concept` defaults to 4.
  Duplicate URLs are collapsed before truncation, so the cap never wastes a
  slot on the same link twice.
- **`origin` is load-bearing.** `graph` resources come from the
  CourseGraph; `web` resources come from live search and are **not**
  reviewer-approved. Never re-label a web hit as graph evidence, and never
  cite a web hit as approved teaching material.
- **Fail closed on configuration.** When no Tavily/Serper key is present,
  `provider_used = "none"` and `web_enabled = False`. The caller may still
  receive graph-only resources; it must never receive fabricated links.
- **Fail closed on network.** A provider error is recorded in
  `DiscoveryResult.errors` and the concept keeps its graph resources only.
  Soft failures never raise.
- **Read-only.** Discovery never mutates a CourseGraphVersion, registers no
  edge, and changes no audit trail. It consumes the graph in place.

## Relation semantics (what counts as "related")

The discovery walks **four** of the seven CourseGraph relations
(definitions inherited verbatim from `build-knowledge-relations`):

- `prerequisite` — source mastery materially enables target. The strongest
  signal that a resource for the source helps the learner reach the goal.
- `part_of` — source is a constituent of target. Component concepts are
  relevant study material.
- `supports` — source provides useful but non-required technique. The
  canonical edge for "related but optional" resources.
- `transfers_to` — competence at source transfers to target. Useful for
  transfer/迁移 practice material.

Excluded on purpose:

- `equivalent_to` — handled upstream via alias resolution; double-counting
  would not add resources.
- `contradicts` — a conflicting object is not learning material.
- `diagnoses` — a misconception/diagnostic edge identifies what a learner
  gets *wrong*, not what to read.

Only edges whose `reviewer_status` is in `{"reviewer_approved", "active",
"behavior_validated"}` are walked. A `proposed` / `needs_review` edge must
not silently widen the resource net. The walk uses the inverse direction
too (`A supports B` makes B's concepts relevant to A's goal); this is an
intentional **relevance** expansion, not a semantic claim about dependency.

## What counts as a "link"

The CourseGraph schema has **no dedicated URL field**. A link lives in a
node's `evidence_sources`, under whichever of `source_id` / `url` / `link`
is an HTTP(S) string. Non-link evidence (book quotes, page numbers) is
ignored — a learner cannot *open* it. If your graph was built without
HTTP(S) links in `evidence_sources`, graph resources will be empty and the
web fallback carries the load.

## Resource discovery contract

Given an activated `CourseGraph`, a `goal_concept_id`, and this round's
`frontier_concept_ids`:

1. **Collect related concepts.** Seeds = `{goal} ∪ frontier`. BFS up to
   `hops=2` (default) along the four walked relations, active edges only.
   Seeds are included at `hops=0, relation="seed"` so each concept's
   inclusion is auditable.
2. **Graph resources per concept.** First the node's own HTTP(S)
   `evidence_sources`; then any `resource`-typed neighbour linked by an
   active `supports` / `part_of` edge. All tagged `origin="graph"`.
3. **Web fallback (optional).** Only if a Tavily **or** Serper key is set.
   The query is `"<concept label> <goal label> 数学 <scenario cues>"` (zh) or
   `"<concept label> <goal label> <en scenario cues>"`. The cues are chosen by
   the `scenario` parameter (see the next section); the default
   `concept_building` reproduces the legacy query `数学 讲解 教程 例题` /
   `mathematics tutorial explanation`. Preferred `include_domains`:
   math.stackexchange.com, mathoverflow.net, khanacademy.org, arxiv.org,
   ams.org, brilliant.org. Each concept is fetched only if it has fewer graph
   resources than the cap; the per-call budget is `2 × remaining window`.
4. **Merge and rank.** Graph resources first, web filling remaining slots,
   then de-duplicate by URL and rank by tier
   (`primary > scholarly > community > other`), with `graph` beating `web`
   at equal tier, with a scenario-boost sub-rank inside each `(tier, origin)`
   group, and a stable URL tiebreak. Truncate to `max_per_concept`.

## Scenario (purpose) dimension

`scenario` is a **ranking-only** input — it biases *what kind* of material
surfaces for one concept without ever changing how much surfaces or how it is
provenanced. One of:

| scenario | surfaces | zh cues | en cues |
|---|---|---|---|
| `concept_building` (default) | exposition, intuition, textbook material | 数学 讲解 教程 例题 | mathematics tutorial explanation |
| `practice` | problem sets and worked solutions | 数学 练习 习题 题解 | mathematics practice exercises solutions |
| `exam_prep` | past papers, mark schemes, common trap items | 数学 真题 考研 期末 模拟 | mathematics exam "past papers" "mark scheme" |
| `real_world_application` | engineering cases and applied uses (实战) | 数学 应用 实例 工程 案例 | mathematics application engineering example |

The scenario touches exactly two deterministic places, both in
`src/math_research_pipeline/basic_resources.py`:

- the web query cues in `_build_query`;
- a scenario-boost sub-rank inside `_rank_and_cap`.

**Red line (must hold for every scenario):** the boost only reorders records
within an equal `(tier, origin)` group. It can never (a) lift a web hit above
a same-tier graph link, (b) change `source_tier`, (c) change `origin`, (d)
raise the per-concept cap, or (e) fabricate a result when no key/network is
present. A scenario that does any of these is a contract violation, not a
preference. `concept_building` is the default so callers that ignore the
parameter behave byte-identically to the pre-scenario implementation.

`deduplicate_sources` from `search.py` is reused on the web records before
they enter the merge, so provider-side duplicates never survive.

## Running it

The canonical entry points live in
`src/math_research_pipeline/basic_resources.py`:

```python
from math_research_pipeline.basic_resources import discover_resources_sync

result = discover_resources_sync(
    graph=plan_v2.graph,                       # activated CourseGraph
    goal_concept_id=plan_v2.plan["goal_concept_id"],
    frontier_concept_ids=plan_v2.frontier_concept_ids,
    hops=2,
    max_per_concept=4,
    language="zh",
    scenario="exam_prep",   # concept_building | practice | exam_prep | real_world_application
)
# result.related_concepts / result.by_concept / result.coverage_note
# result.provider_used / result.web_enabled / result.errors
```

`discover_resources` is the async form; `discover_resources_sync` wraps the
whole pipeline in a single `asyncio.run` so the provider's `search` and
`aclose` share one event loop. The Feishu bot (`!basic`) calls the sync
form because bot scripts are synchronous `main(argv) -> str`.

To enable web fallback, export either `TAVILY_API_KEY` (default) or
`SERPER_API_KEY`. To check whether a key is visible without issuing a
search, read `settings.tavily_api_key` / `settings.serper_api_key`; both
default to `None` and `Settings()` constructs with no environment.

## Feishu bot output contract

`bots/feishu-public-bot/scripts/basic.py` appends a `📚 学习资源` block to
the v2 plan **only** when the graph is active and passed `hard_pass`.
Form:

```
📚 学习资源（每知识点 ≤4 条；<coverage_note>）
— <label>（目标/前沿 | <relation>·<hops>跳）
  1. <title> — <url> （图谱|Web·<tier>）
  ...
```

When there are no resources at all, it emits one explanatory line containing
the coverage note, never an empty section. When discovery itself raises
(the contract says it should not), it degrades to
`📚 学习资源发现跳过：<reason>`.

## Mandatory fail-closed handoff

- Do **not** hand-edit `provider_used`, `web_enabled`, `origin`, tier
  labels, or the per-concept cap. They are the provenance a reviewer relies
  on.
- Do **not** present web resources as proof of mastery or as an approved
  CourseGraph artifact.
- If `provider_used == "none"` but web resources appear in the output, stop
  — that is a bug in the merge step, not a feature.
- If a concept exceed the cap, stop — the truncation step failed and the
  output violates the user-facing promise.
- Report the coverage note verbatim to the user; it states how many
  concepts have resources, how many do not, and whether web search ran.
