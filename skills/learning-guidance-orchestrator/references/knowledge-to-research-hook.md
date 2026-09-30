# Knowledge → Research Bridge (explicitly activated, checksum-bound)

This orchestrator's Stage 5 mentions research/publishing only as a
**non-activating prompt**. Learning and research are deliberately separate
workflows in this project (see the project `AGENTS.md`, "Basic mathematics
learning" vs "Aletheia" sections), and this hook is the seam between them.

## Current state: the bridge is wired at the handoff boundary

`src/math_research_pipeline/basic_research_dock.py` already defines a
**read-only, one-directional** snapshot of a Basic `LearnerState` plus the
active CourseGraph frontier, with a checksum so the research side can detect
tampering. Its module contract (basic_research_dock.py):

- *" snaps a compact, deterministic snapshot … so a future research-side
  component (e.g. the research commander loop) can read it **without** ever
  editing the source of truth."*
- The dump is read-only; any mutation is flagged by `verify_research_context`.
- It imports no Aletheia or research-program symbol — the dependency
  direction is **Basic → snapshot**, never Basic → Research.

The orchestrator now seals the completed `LearningSessionReceipt v1` together
with this Basic snapshot by running
`scripts/activate_research_bridge.py`. The result is a
`learning-research-handoff-v1` artifact with independent receipt, Basic-context,
and whole-handoff checksums. The artifact is the input seam consumed by the
`alephora-learning-research` skill; it is not itself a research program,
novelty verdict, proof, or permission for paid Provider calls.

## What this orchestrator does at Stage 5

Exactly this, nothing more:

> 如果你想把"会用同胚判据"升级为"研究 / 发表一个新结果"，那是另一条路：需要走
> Aletheia 十轮对抗 + 设计门禁 A–J + 人工发布。请明确说"我要进入研究"再切换；本
> 学习会话不会自动进入研究流程。

This means:

- **Do not** build a new research snapshot merely because a learner selected
  `research_readiness`. Preserve the `research_context` already emitted by a
  knowledge-system Basic plan, if one exists, and seal it only after explicit
  transition confirmation.
- **Do not** invoke `math-adversarial-debate`,
  `research-significance-assessor`, `qva-mathematical-value`, the
  `commander` loop, or `math-research program`. None of those are learning
  tools.
- **Do not** describe a learning receipt as a research result, a novelty
  finding, or a step toward publication.

## Activating the bridge (only on explicit user request)

When original-result/publication intent appears, explain the boundary and ask
for the second explicit transition phrase. Activate only after the user says
`我要进入研究`, `开始研究`, or `进入原创研究`. Then the transition is:

1. **Stop the learning session.** Make the boundary explicit.
2. **Switch regimes.** Research work is governed by the Aletheia rules in
   `AGENTS.md`: ten genuine cross-Provider debate rounds (GLM proponent,
   DeepSeek critic, distinct response IDs), literature audits at rounds 1/5/10,
   a durable objection ledger, design gates A–J enforced by
   `scripts/audit_research_design.py --strict`, and an explicit human release
   gate before any paper is downloadable.
3. **Seal the handoff** into a workspace-rooted JSON path. Pass the completed
   learning receipt and the Basic v2 plan if available:

   ```bash
   python3 {baseDir}/scripts/activate_research_bridge.py \
     --receipt <learning-session-receipt.json> \
     --basic-plan <basic-plan-v2.json> \
     --intent <evidence_research|original_research> \
     --confirmation "<the learner's explicit transition words>" \
     --out <workspace-rooted-learning-research-handoff.json>
   ```

   In legacy mode omit `--basic-plan`; the receipt is still sealed and the
   handoff explicitly records `basic_context_status=unavailable_legacy`.
4. **Load `alephora-learning-research` and pass the handoff path/checksum.**
   Evidence/literature intent routes to its evidence-research mode. New theorem,
   original result, novelty, proof-release, or publication intent routes to
   publication-first/Aletheia mode. Read every mode-specific reference that
   skill requires before substantive work.
5. **Never inherit a learning claim as research evidence.** The research side
   may use the topic, prerequisites, frontier and weak points to propose a
   bounded question; it must not treat a mastery value, model explanation, or
   completed exercise as a proof or novelty result.

Until the user explicitly asks to activate the bridge, Stage 5 is the single
sentence above and no handoff artifact or research code runs. After activation,
the transition is auditable and research execution remains subject to its own
authorization, Provider, literature, design-gate, and human-release rules.

## Why the separation matters

Learning rewards the learner's understanding and routinely over-claims
("掌握了", "理解了") at low cost. Research rewards only verified, novel, and
non-trivial results and is gated to prevent exactly the kind of optimism that
learning mode depends on. Routing a learning conclusion straight into a paper
would bypass every design gate (A–J) this project adopted after the
2026-08-04 Node-A failure. The seam is therefore one-way and human-confirmed.
