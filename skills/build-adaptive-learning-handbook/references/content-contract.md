# Adaptive handbook content contract

## Required in every profile

1. State the observable learning goal, diagnostic evidence, and current ability boundary.
2. Show prerequisites and dependencies, distinguishing demonstrated, weak, and unobserved concepts.
3. Explain each core concept through motivation, precise definition, boundary or tempting confusion, positive example, and counterexample.
4. Include step-by-step worked examples linked to weak points. Each key example identifies unknowns/data/conditions, explains the selected plan, distinguishes an intuition check from a strict justification, and closes with result verification plus an alternative route or transfer use.
5. Include graded practice with a hint and complete answer for every exercise; solutions must implement the same concrete solve-check-review loop rather than merely naming its stages.
6. Give a 4–6 stage path with completion evidence and diagnostic traceability.
7. End with retrieval/retest actions and resources carrying unmodified origins.
8. Encode every mathematical expression as typed native-formula markup: `[[INLINE_MATH]]...[[/INLINE_MATH]]` inside prose or a standalone `[[DISPLAY_MATH]]...[[/DISPLAY_MATH]]` line. Use LaTeX fractions, superscripts, subscripts, matrices, cases, and `aligned` derivations inside those tags; never simulate them with Unicode superscripts or slash fractions.

## Profile additions

- `exam_compact`: tested objective map, high-yield methods, common traps, and a timed mini-set.
- `advanced_theory`: theorem dependency, assumptions, proof strategy, what the theorem does not imply, and canonical constructions.
- `research_readiness`: reading order, prerequisite gaps, proof techniques to acquire, literature-reading questions, and a fixed non-activating research boundary.

## Publication gates

Reject before upload when any condition holds:

- a generated section is only an outline or misses its required semantic markers;
- a section still fails its semantic or typed-math gate after the initial generation plus four bounded local repairs;
- exercises and solutions are not paired;
- the number of exercise/prompt/answer triples differs from the spec, a marker body is too short, or the section does not end exactly with `【本节完成】`;
- a non-practice chapter silently appends exercises, or Markdown headings/separators survive into prose;
- any raw `$...$`, `\\frac`, `\\pi`, `\\begin`, or `\\(...\\)` LaTeX survives outside typed math tags;
- a math tag is unbalanced, contains unsafe/unsupported commands, spans physical lines, or a display tag shares its line with prose;
- a loss-guarded math-only normalization changes prose, drops formula words, leaves an unknown/nested typed tag, or does not pass the same section gate afterward;
- a denominator power is written ambiguously as `\frac{a}{b}^{n}` instead of `\frac{a}{\left(b\right)^{n}}`;
- formula-like Unicode/plain text survives outside typed math tags, including superscripts, subscripts, partial derivatives, integrals, arrows, membership relations, or slash-style multi-term fractions;
- the deterministic renderer's `<latex>` count differs from the typed math count, or remote Feishu fetch does not return the same number of native `<latex>` nodes;
- diagnosis evidence, learner answers, frontier/path fields, goals, weak points, or any other deterministic document field bypasses the final native-LaTeX normalization pass;
- a non-exam handbook contains generic `高中` or `高考` framing;
- path stages do not link to actual diagnostic question IDs;
- a resource lacks `origin`, or generated prose invents a URL;
- GLM response IDs are absent for successful model-generated sections;
- the separate GLM 5.2 verdict-only quality pass is absent, switches Provider/model, rewrites an already contract-valid section, or reports an unresolved issue;
- the final cross-section GLM 5.2 audit is absent, or it finds a formula, chart-domain, dimension, example, theorem-condition, answer, or cross-section consistency error that is not repaired locally;
- the Feishu Draft Profile Check does not report `assessment.status=passed`.
