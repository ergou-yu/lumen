# Assessment Protocol

The Stage 2 assessment is the load-bearing step that separates a real
learning-guidance session from a context-free lecture. Its job is to turn the
learner's current mastery into **typed `Observation`s bound to CourseGraph
concept IDs**, so the deterministic engine can compute the frontier and the
next action from evidence rather than from a guess.

## Binding a diagnostic item to a concept_id

Use the v2 receipt's `knowledge_frontier` payload (basic_learning.py:842-864)
as the source of structured concept IDs. Each entry already carries:

```
knowledge_frontier[i] = {
  "concept":      <human label>,
  "concept_id":   <stable graph id, e.g. "k_homeomorphism_def">,
  "type":         <concept|skill|...>,
  "relation":     "target" | "prerequisite",
  "mastery_gap":  <0..1, or "待诊断" if unobserved>,
  "status":       "blocked" | "in_progress" | "candidate",
  "blocked_by":   [<concept_id>, ...],
  ...
}
```

For each diagnostic item you emit, **record the `(item_id, concept_id)`
pair in your working memory** for this conversation. This pair is what lets
Turn 2 build a correct `answers.json` regardless of the order the learner
replies in or which items they skip.

Do **not** rely on parsing `concept_id=` substrings out of the free-text
`diagnostic_questions` list (`_build_diagnostic_questions` returns plain
strings with ids embedded in prose). The clean handle is the structured
`knowledge_frontier` entry, used by position or by explicit mapping.

## Choosing 2–4 items

Prefer **frontier concepts with `mastery_gap` > 0** in this priority:

1. `blocked` nodes — assess whether the blocker is real (a blocked node that
   the learner actually knows should be unblocked by evidence, not by hand).
2. the `target` (goal) node — a single high-information item at the goal.
3. one or two `candidate` prerequisite nodes — the nearest unassessed
   prerequisites that the path would otherwise assume.

Never emit more than four items in one turn; an assessment longer than the
explanation defeats its purpose.

This protocol permits **one assessment turn only**. Put the target-level
selector and all chosen items in that first reply. On the learner's next
message, advance to teaching even if only some items were answered or the
learner chose the 会/不会 shortcut. Record unanswered items as unobserved; do
not issue a replacement quiz, an “advanced check”, or a self-test gate before
the explanation.

## Item design

Each item should be answerable in under two minutes and should distinguish a
learner who has the prerequisite from one who does not:

- Ask for a **minimal example** ("给出一个必须使用前置概念 X 的最小例子，并解释
  为何不能跳过"), not a definition recital.
- Ask for a **judgment + correction** when a known misconception is active
  ("判断并修正这句话：…"), to expose the specific error.
- Ask for a **representation transfer** ("把题面换一种表征再写一遍，说明哪些
  条件不变"), to test transfer not recall.

Include, visibly, the shortcut: *"能答就答；忙的话每题回'会/不会'也行。"* The
shortcut is acceptable evidence at lower confidence — it is not a refusal.

## The 会/不会 protocol

When the learner answers "会" / "不会" (or "会做" / "不会做", "yes" / "no"):

- **Record `verdict` = "会" | "不会"** for that `item_id` and `concept_id`.
- These map to `is_correct = True / False` with **lower confidence and
  evidence quality** than a worked answer, because a self-judged "会" is
  coarser than a demonstrated solution. `assess_to_observations.py` encodes
  this: 会/不会 → `confidence=0.65, evidence_quality=0.65` (above the
  downweight gate QUALITY_DOWNWEIGHT=0.65 in basic_state.py so the posterior
  still moves, but below a full worked answer's 0.85).
- If the learner answers with reasoning or a worked solution, record
  `verdict` = "correct" | "incorrect" and, if available, the partial score;
  these map to `confidence=0.85, evidence_quality=0.85`.

When the learner replies with one aggregate negative — `都不会`, `都不太会`,
`全不会`, `一个都不会`, or `都不知道` — apply `verdict="不会"` separately to
every item from the immediately preceding assessment turn. Preserve each
original `question_id` and `concept_id`. This yields 2–4 real, low-confidence
negative observations; do not misclassify it as one generic answer or as zero
answers.

A learner who says only "我全会" with no per-item breakdown: record it as a
single `goal`-level observation at `confidence=0.5, evidence_quality=0.5`
(the cold-start / downweight regime) — never as item-level mastery. Tell the
learner the evidence is coarse and the path will be labelled `unobserved`.

## answers.json — the Turn 2 handoff

Write a JSON array of answer objects to a workspace-rooted path the engine
can read. Each object:

```json
{
  "question_id":   "q1",
  "concept_id":    "<exact graph concept_id from knowledge_frontier>",
  "verdict":       "会",
  "partial_score": 0.0,
  "confidence":    0.65,
  "evidence_quality": 0.65,
  "misconception_signals": {"sign-error": 0.6}
}
```

- `verdict` ∈ {"会", "不会", "correct", "incorrect", "yes", "no"}.
- `partial_score`, `confidence`, `evidence_quality`, `misconception_signals`,
  `strategy_signals` are all optional; sensible defaults come from the
  verdict mapping.
- `concept_id` must be a real node in the activated CourseGraph; a misspelled
  id fails closed (duplicate `question_id` also fails closed).

`assess_to_observations.py` validates every `concept_id` against the graph
and emits the `--observations` JSON array the engine consumes.

## What this step is not

- Not a quiz for its own sake — every item must map to a frontier concept
  whose mastery the path depends on.
- Not a gate on the learner — any answer (including a skip) progresses the
  session; the only failure is pretending to have evidence you do not have.
- Not a multi-round entrance exam — after one answer opportunity, teach from
  the evidence available and move any further questions into optional retrieval
  practice rather than another pre-teaching barrier.
- Not a model-evaluated test — the model does not grade the learner; the
  learner's own verdict becomes the evidence at a calibrated confidence.
