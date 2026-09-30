---
name: learning-guidance-orchestrator
description: Orchestrate a complete learning-guidance session in a forced ordering — intent and target level → knowledge relations → one assessment turn → teaching and learning path → scenario-based resources → optional verified research handoff — for any learner who wants a study plan, a learning path, prerequisite diagnosis, practice or exam-prep guidance, or a structured MathSight Basic receipt. Use when a learner asks "teach me", "plan my study", "what's my path", "assess me first", "give me resources for exam/实战", or otherwise wants guided learning rather than a one-shot explanation. Delegates to the build-knowledge-relations skill for the CourseGraph, the deterministic `math-research basic` engine for the path and receipt, discover-learning-resources for resources, and build-adaptive-learning-handbook for a substantial Feishu learning document. Never treats research-readiness teaching as original research; the verified knowledge→research handoff activates only after explicit user confirmation.
---

# Learning Guidance Orchestrator

Force a learning session to run in the order that actually produces a usable
path and resources, instead of collapsing into a single hand-written
explanation. The recurring failure this skill exists to prevent: a learner
asks a math question and receives a competent but context-free lecture — no
assessment of their existing mastery, no knowledge graph to locate the topic,
no structured path, and no resources that fit how they will use the material.

This orchestrator owns the **ordering** and the **handoffs** between three
deterministic back-ends and one human-assisted step. It does **not** replace
them, edit their receipts, or invent its own mastery numbers.

## Load only the current learning stage

A concrete request to generate, translate or repair an already stated Lean proof
routes to `lean-proof-workflow`; it does not activate this learning session or
require a new learner diagnosis. For actual tutoring, keep the existing one-turn
assessment and stage ordering. Load the assessment protocol only for Stage 2,
scenario resources only for Stage 4, and handbook contracts only for a document
handoff with the required receipt. A request to learn Lean is still learning;
research-readiness study does not activate original research.

## Core boundary

- **Order is mandatory.** Never emit a learning path before Stage 2 assessment
  evidence exists; never emit resources before Stage 3 produces a path. A bare
  explanation with no assessment/path/resources is a **routing failure**, not
  an acceptable learning-guidance deliverable.
- **Paths require an activated graph.** A `draft` / `proposed` / unreviewed
  CourseGraph must never yield a knowledge-system path. With no activated
  graph, fall back to the legacy formula plan and label it as such — never
  present a formula plan as a knowledge-system path.
- **A self-report is not mastery.** "我会了" / "我理解了" from the model or the
  learner is a signal, not evidence. Only typed `Observation`s (built from real
  or "会/不会" answers and bound to CourseGraph concept IDs) update mastery.
- **Fail closed on missing capability.** No GLM key → no discovery (only
  deterministic `validate`). No activated graph → legacy plan with disclaimer.
  No Tavily/Serper key → graph-only resources, never fabricated links.
- **Research gates stay separate.** This skill never invokes Aletheia debate,
  `qva-mathematical-value`, `research-significance-assessor`, or the commander
  loop during learning. The knowledge→research bridge in Stage 5 is dormant
  until explicit user confirmation; after confirmation it hands a read-only,
  checksum-bound Basic context to `alephora-learning-research` rather than
  silently continuing as tutoring (see
  [references/knowledge-to-research-hook.md](references/knowledge-to-research-hook.md)).
- **Only one assessment turn.** Put the missing target-level choice and all
  2–4 diagnostic items in the learner's first guided-learning reply. The very
  next learner message advances to explanation/path/resources whether the
  answers are complete, partial, self-reported, or explicitly skipped. Never
  impose a second quiz or self-test round before teaching.

## The forced workflow (Stages 0–5)

Read [references/assessment-protocol.md](references/assessment-protocol.md)
before Stage 2 and
[references/scenario-resources.md](references/scenario-resources.md) before
Stage 4. Do not reorder or skip stages.

### Stage 0 — Intent and scope

Collect, in the same compact turn as Stage 2 diagnostics, the five things the
rest of the chain needs. Ask only for what is missing; if the message already
carries it, proceed:

- **topic** — the concept / problem area (e.g. "代数拓扑中的同胚").
- **goal** — an *observable* learning target the learner will be able to do
  (e.g. "判断两个空间是否同胚并说明判据").
- **scenario** — one of `concept_building` / `practice` / `exam_prep` /
  `real_world_application`. This drives resource ranking in Stage 4. Default
  to `concept_building` only if the learner gives no signal.
- **time / deadline** — optional; affects retrieval schedule and pace.
- **target_level** — one of `foundation` / `undergraduate` / `graduate` /
  `advanced` / `research_readiness`. Ask this explicitly whenever the learner
  has not stated how deep they want to go. A compact Chinese selector is enough:
  `入门直觉 / 本科系统 / 研究生理论 / 高阶专题 / 论文阅读准备`.

State back the captured intent in one line before proceeding. Do not spend a
separate conversational turn on these questions: target-level selection and
observable-goal capture and Stage 2 diagnostics belong in the same reply. A
topic-only request such as “我想学超几何级数” must therefore ask both “你想
学到什么可观察程度？” and the compact depth selector before listing the
diagnostic items. If the learner answers the
diagnostics but omits the selector, infer the least ambitious level supported
by the demonstrated work, label it `inferred`, and let the learner correct it
without delaying the explanation.

### Stage 1 — Knowledge relations (path enabler)

The activated CourseGraph is the prerequisite for a knowledge-system path.

1. **Look for an activated graph.** Check the learner's `data/coursegraphs/`
   (Feishu bot: `bots/feishu-public-bot/data/coursegraphs/`) and any graph the
   learner supplies. Activation = `graph_status == "active"` **and**
   `hard_pass == True` (run `coursegraph_tool.py receipt` to confirm).
2. **No activated graph?** Invoke the `build-knowledge-relations` skill to
   build one — GLM discovery requires explicit learner authorization (it is a
   paid call) and emits `draft` until a human review approves it. **Do not**
   treat a draft graph as activated. If the learner declines graph building,
   proceed to Stage 2/3 in legacy mode and label every output "无知识图谱，
   配方式计划（仅供参考）".
3. **Report graph state.** One line: `图谱：<id> v<x> · status=<active|draft> ·
   hard_pass=<bool> · 节点 N / 边 M`. Nothing more in this stage.

### Stage 2 — Assess before explaining (mandatory)

Read [references/assessment-protocol.md](references/assessment-protocol.md)
in full. Emit 2–4 short diagnostic items bound to the knowledge frontier
returned by the activated graph (or, in legacy mode, to stated prerequisites).

- Build each item with a **structured `concept_id`** taken from the receipt's
  `knowledge_frontier[i].concept_id` field (basic_learning.py:842-864). This
  binding is what lets the answer update the right mastery slot.
- Offer the **会/不会** shortcut ("会" = I can do this, "不会" = I cannot) and
  the full answer path. The shortcut is acceptable evidence at a lower
  confidence; a fully worked answer is stronger.
- Treat an aggregate negative such as `都不会` / `都不太会` / `都不知道` as
  one explicit negative answer for **each** diagnostic item asked in the
  immediately preceding assessment turn. Expand it into the 2–4 original
  `(question_id, concept_id)` bindings with `verdict=不会`; it is valid
  low-confidence evidence, not an unanswered or skipped assessment.
- **Stop and wait exactly once.** This is the only diagnostic wait in a guided
  learning session. On the learner's next message, map every real answer you
  have and advance to Stage 3 immediately. Missing answers are `unobserved`;
  partial/self-reported answers retain their lower evidence strength. Do not
  ask a second diagnostic batch, require self-test answers, or withhold teaching.

### Stage 3 — Learning path and plan

Map the answers to typed `Observation`s with the bundled script, then run the
deterministic engine:

```bash
# Build the observations file from 会/不会 or full answers:
python3 {baseDir}/scripts/assess_to_observations.py \
  --graph <activated-graph.json> \
  --answers <answers.json> \
  --out <workspace-rooted-observations.json>

# Then the engine:
uv run math-research basic \
  --knowledge-system \
  --graph <activated-graph.json> \
  --goal-id <goal concept_id> \
  --observations <workspace-rooted-observations.json> \
  --text
```

Present from the v2 receipt, in this order, never quoting numbers as fact
without their evidence binding:

- **前沿状态** — each frontier concept with `status` (blocked / in_progress /
  candidate) and `mastery_gap`. Mark `待诊断` when evidence is absent.
- **下一步 (PlanAction)** — the chosen action (teach / example / diagnostic /
  remediate / transfer / review) and why.
- **复测与迁移进度表** — retrieval schedule (`本轮迁移题 / 次日回忆 / 3–7 天
  混合练习 / 2–4 周累计应用`).
- **证据等级** — `observed` vs `unobserved`, with the explicit limitation line.
- **证书** — `certificate_id` only; never hand-edit or restate its checksums.

In legacy mode (no graph), run `uv run math-research basic --topic ... --goal
... --text` and present the six-stage MAPLE cycle plan with the disclaimer.

### Stage 4 — Scenario-based resources

Read [references/scenario-resources.md](references/scenario-resources.md).
Invoke the `discover-learning-resources` skill with the Stage 0 scenario:

```python
from math_research_pipeline.basic_resources import discover_resources_sync

result = discover_resources_sync(
    graph=plan_v2.graph,
    goal_concept_id=plan_v2.plan["goal_concept_id"],
    frontier_concept_ids=plan_v2.frontier_concept_ids,
    scenario="<concept_building|practice|exam_prep|real_world_application>",
)
```

Present per concept, strictly fewer than five each, with `origin`
(`图谱` vs `Web`) shown so a learner never confuses a web hit with a reviewed
resource. Never re-label `Web` as `图谱`. When a concept has no resources,
say so via the coverage note rather than padding.

### Stage 5 — Knowledge→research bridge

Close with one fixed, non-activating line. **Do not** trigger any research
code, debate, or `qva`/significance assessment:

> 如果你想把"会用同胚判据"升级为"研究 / 发表一个新结果"，那是另一条路：需要走
> Aletheia 十轮对抗 + 设计门禁 A–J + 人工发布。请明确说"我要进入研究"再切换；本
> 学习会话不会自动进入研究流程。

Hand-off details (read-only until explicit confirmation) live in
[references/knowledge-to-research-hook.md](references/knowledge-to-research-hook.md).

If the learner explicitly says `我要进入研究`, `开始研究`, or `进入原创研究`,
stop learning generation and activate that handoff exactly as the reference
specifies. An original theorem/result/publication request signals research
intent but still requires this second explicit transition confirmation before
activation. A choice of `research_readiness` or “研究级学习” alone is **not**
that confirmation.

### Feishu document handoff — after the one assessment turn

Delegate substantial Feishu learning sessions to the
`build-adaptive-learning-handbook` skill. Do not use `feishu_doc` to copy the
chat response into a document. A deployment may declare a standing learner
opt-in for proactive document delivery; the Alephora Feishu workspace does so.
In that deployment, a natural-language request to learn a substantial math
topic authorizes one adaptive handbook after the single assessment turn unless
the learner says `不要文档` / `只在聊天讲`.

- If Stage 2 answers do not exist yet, keep the document job pending, emit the
  target-level selector plus 2–4 diagnostic items, and stop once. A standing
  Feishu opt-in or explicit document request authorizes the later adaptive GLM
  calls; neither authorizes skipping assessment.
- On Turn 2, assemble `LearningSessionReceipt v1` from the observed
  diagnostic question/answer bindings, frontier, path, and provenance-preserving
  resources. Never reconstruct evidence from a generic learner profile.
- Give the learner a concise diagnosis and begin the first explanation in the
  chat. If 2–4 diagnostic items have real answers, call the typed
  `build_adaptive_learning_handbook` tool once in the same turn. If fewer than
  two were answered, keep the document pending and say which receipt evidence
  is missing, but do not issue a second entrance quiz or delay teaching; later
  optional retrieval answers may complete the receipt. Do not wait for answers
  to the new self-test when the existing receipt is already valid.
- The standing Feishu opt-in is already document authorization. Never ask the
  learner to say `要文档`, reconfirm generation, or remember a command after a
  valid receipt exists. Only an explicit `不要文档` / `只在聊天讲` opts out.
- Report only that
  the job started; the tool sends the real URL and provider receipt after its
  semantic and Feishu parse checks pass.
- Treat a Turn-2 final answer with 2–4 observed answers but no
  `build_adaptive_learning_handbook` acknowledgement as a routing failure. In
  the Alephora Feishu deployment the Gateway finalization gate must revise that
  answer before delivery; a promise to create a document later is insufficient.
- `research_readiness` remains learning. Original-result, novelty, proof-release,
  or publication intent must stop here and require one of the explicit
  `我要进入研究` / `开始研究` / `进入原创研究` transitions.

## Interactivity without a session store

The bot runtime is one-shot (`basic.py main(argv) -> str`, no per-user
state). Drive a multi-turn session from **conversation memory** instead:

- **Turn 1:** Stage 0 target-level selector + Stage 1 + Stage 2 diagnostic
  items in one reply. End asking for one combined answer (会/不会 per item is
  allowed).
- **Turn 2:** Parse whatever the learner supplied; build `answers.json`; run
  Stage 3 + Stage 4; present diagnosis + path + first explanation + resources.
  In the Feishu standing-opt-in deployment, also start the adaptive document
  now when 2–4 real diagnostic answers make the receipt valid; otherwise keep
  it pending without another pre-teaching gate. Advance Stage 2 across turns
  by keeping the `(question → concept_id)` binding in your working memory for
  this conversation.
- **Later turns:** Continue teaching/retesting. Never re-ask answered questions
  merely to manufacture a receipt and never make a second pre-teaching quiz a
  gate.

Never rely on a `REQUIRES_CONTEXT` session or message-id re-entry; it does
not exist.

## Delegation contract (what this orchestrator owns vs. delegates)

- **Owns:** Stage ordering, the concept_id↔question binding emitted in
  Stage 2, the answers→observations handoff, the scenario parameter, and the
  Stage 5 hook wording. It also owns the factual handoff fields in a requested
  `LearningSessionReceipt v1`.
- **Delegates (never bypasses):** graph construction/validation/receipt →
  `build-knowledge-relations`; mastery state, path, certificate, retrieval
  schedule → `math-research basic`; resource discovery →
  `discover-learning-resources`; detailed document specification, generation,
  validation, and upload → `build-adaptive-learning-handbook`.
- **Edits nothing produced by back-ends:** no `provider_used`, `origin`,
  tier, cap, checksum, or certificate field is ever rewritten. Relabeling
  any of these is a hard failure.

## Anti-collapse checklist (run before delivering)

Before sending the final learning reply, confirm each item. If any fails,
rewrite the reply rather than ship:
1. Assessment evidence exists (or the path is explicitly labeled `unobserved`).
2. A path was produced (PlanAction in v2, or a clearly-labelled legacy plan).
3. Resources were attempted and each is tagged with `origin`.
4. No mastery/uncertainty number is quoted as fact without its evidence binding.
5. Unless the learner explicitly activated the bridge, the Stage 5 line is the
   only research mention and no Aletheia/qva/debate code ran. If the bridge was
   activated, a verified read-only handoff receipt exists and learning mode has
   stopped before research execution.

## Report outcomes

Report, compactly: the activated graph state (or its absence), the evidence
level (`observed`/`unobserved`), the frontier status summary, the next
PlanAction, the resource coverage note, and the next retrieval task. Keep the
research bridge to the single non-activating line above.
