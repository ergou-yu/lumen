#!/usr/bin/env python3
"""Turn Stage 2 assessment answers into typed ``Observation`` JSON.

This is the missing link in the assessment round-trip (see
learning-guidance-orchestrator/references/assessment-protocol.md):

    diagnostic items (bound to knowledge_frontier concept_ids)
        -> learner answers ("会" / "不会" / worked solution)
        -> THIS SCRIPT
        -> ``--observations`` JSON consumed by ``math-research basic``
        -> updated LearnerState + frontier + PlanAction

The repo's existing ``_coerce_observations`` (basic_learning.py:498-551)
only turns the legacy ``--answered/--correct`` *aggregate* into Observations
bound to a single goal concept. It cannot map per-item "会/不会" answers back
to the right frontier concept_id. This script fills that gap.

Design constraints (mirrors the rest of the Basic engine):

- **Deterministic, stdlib-only, no network.** It must run inside any mirrored
  skill workspace that may not have the python package importable, so it
  validates ``concept_id`` against the raw CourseGraph JSON instead of
  importing ``load_course_graph``. Behaviour matches
  ``_validate_observation_bindings`` (basic_learning.py:597-619): every
  ``concept_id`` must be a real node; duplicate ``observation_id`` / question
  ids fail closed.
- **Verdict -> (is_correct, confidence, evidence_quality).** A self-judged
  会/不会 is coarser than a demonstrated solution, so it lands above the
  downweight gate ``QUALITY_DOWNWEIGHT=0.65`` (basic_state.py:52) but below a
  worked answer. The caller can override any field per answer.
- **Fail closed.** Unknown verdict, unknown field, missing concept_id, or a
  duplicate id raises (the CLI exits non-zero); never silently drops or
  fabricates an observation.

Output schema == the ``Observation`` dataclass JSON shape
(basic_state.py:75-97), so the file can be passed straight to
``uv run math-research basic --observations <out>``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

# Verdicts the learner may write. Split into two confidence tiers:
#   SHORTCUT — a self-judged "I can / I can't" (会/不会 or yes/no). Coarse but
#              acceptable evidence; lands at the QUALITY_DOWNWEIGHT=0.65 gate
#              so mastery still moves, just downweighted.
#   WORKED   — a demonstrated or evaluated outcome (correct/incorrect). Strong
#              evidence; updates mastery at full weight.
# Correct-side and incorrect-side are paired by index order in the two tuples.
_SHORTCUT_CORRECT = ("会", "会做", "会做出来", "yes")
_SHORTCUT_INCORRECT = ("不会", "不会做", "做不出来", "no")
_WORKED_CORRECT = ("correct", "true")
_WORKED_INCORRECT = ("incorrect", "false")

# Calibrated confidence/quality per tier (see basic_state.py QUALITY_* gates).
_SHORTCUT_CONFIDENCE = 0.65
_SHORTCUT_QUALITY = 0.65
_WORKED_CONFIDENCE = 0.85
_WORKED_QUALITY = 0.85

_AGGREGATE_NEGATIVE_RE = re.compile(
    r"(?:都不太会|都不会|全不会|一个都不会|都不知道|都不懂|完全不会)"
)

# Exact field set of the Observation dataclass (basic_state.py:75-97).
# Keeping this in sync lets load_observations accept our output verbatim.
_OBSERVATION_FIELDS = (
    "observation_id",
    "concept_id",
    "is_correct",
    "partial_score",
    "time_cost_ms",
    "hint_count",
    "confidence",
    "draft_features",
    "misconception_signals",
    "strategy_signals",
    "evidence_quality",
    "item_id",
    "item_version",
    "timestamp",
)


class AnswerError(ValueError):
    """Raised when an answer cannot become a valid Observation."""


def expand_aggregate_negative_answer(
    diagnostic_items: Sequence[Mapping[str, Any]],
    answer_text: str,
) -> list[dict[str, str]]:
    """Expand one aggregate negative over the preceding diagnostic bindings.

    ``都不会`` is not missing evidence.  It means that every item in the
    immediately preceding 2--4 item batch received the shortcut verdict
    ``不会``.  The function deliberately requires the original bindings so a
    generic negative can never be attached to invented concepts.
    """

    if not isinstance(answer_text, str) or not _AGGREGATE_NEGATIVE_RE.search(answer_text):
        raise AnswerError("aggregate answer is not a recognized all-negative response")
    if not 2 <= len(diagnostic_items) <= 4:
        raise AnswerError("aggregate negative requires the preceding 2-4 diagnostic items")

    expanded: list[dict[str, str]] = []
    seen_questions: set[str] = set()
    for index, item in enumerate(diagnostic_items):
        if not isinstance(item, Mapping):
            raise AnswerError(f"diagnostic item #{index} is not a JSON object")
        question_id = item.get("question_id")
        concept_id = item.get("concept_id")
        if not isinstance(question_id, str) or not question_id.strip():
            raise AnswerError(f"diagnostic item #{index} is missing question_id")
        if not isinstance(concept_id, str) or not concept_id.strip():
            raise AnswerError(f"diagnostic item #{index} is missing concept_id")
        question_id = question_id.strip()
        if question_id in seen_questions:
            raise AnswerError(f"duplicate diagnostic question_id {question_id!r}")
        seen_questions.add(question_id)
        expanded.append(
            {
                "question_id": question_id,
                "concept_id": concept_id.strip(),
                "verdict": "不会",
            }
        )
    return expanded


def extract_concept_ids(graph_json: Mapping[str, Any]) -> set[str]:
    """Return the set of concept_ids present in a CourseGraphVersion JSON.

    Nodes may carry the id under ``concept_id`` or ``id``; accept both so a
    slightly older graph version still validates. Non-string ids are ignored.
    """

    ids: set[str] = set()
    nodes = graph_json.get("nodes")
    if not isinstance(nodes, Sequence):
        return ids
    for node in nodes:
        if not isinstance(node, Mapping):
            continue
        cid = node.get("concept_id", node.get("id"))
        if isinstance(cid, str) and cid.strip():
            ids.add(cid.strip())
    return ids


def _verdict_to_outcome(verdict: Any) -> tuple[bool, float, float]:
    """Map a learner verdict to (is_correct, confidence, evidence_quality).

    Verdict normalisation is whitespace-insensitive and case-insensitive for
    the ASCII forms. An unknown verdict fails closed. The two tiers map to
    distinct evidence quality (see :data:`_SHORTCUT_QUALITY` /
    :data:`_WORKED_QUALITY`).
    """

    if not isinstance(verdict, str) or not verdict.strip():
        raise AnswerError(f"verdict is required and must be a string; got {verdict!r}")
    norm = verdict.strip()
    lower = norm.lower()

    if norm in _SHORTCUT_CORRECT or lower in _SHORTCUT_CORRECT:
        return True, _SHORTCUT_CONFIDENCE, _SHORTCUT_QUALITY
    if norm in _SHORTCUT_INCORRECT or lower in _SHORTCUT_INCORRECT:
        return False, _SHORTCUT_CONFIDENCE, _SHORTCUT_QUALITY
    if norm in _WORKED_CORRECT or lower in _WORKED_CORRECT:
        return True, _WORKED_CONFIDENCE, _WORKED_QUALITY
    if norm in _WORKED_INCORRECT or lower in _WORKED_INCORRECT:
        return False, _WORKED_CONFIDENCE, _WORKED_QUALITY
    raise AnswerError(
        f"unknown verdict {verdict!r}; expected one of "
        f"{list(_SHORTCUT_CORRECT) + list(_SHORTCUT_INCORRECT) + list(_WORKED_CORRECT) + list(_WORKED_INCORRECT)}"
    )


def build_observations_from_answers(
    answers: Sequence[Mapping[str, Any]],
    *,
    concept_ids: Iterable[str],
) -> list[dict[str, Any]]:
    """Build a list of ``Observation``-shaped dicts from Stage 2 answers.

    Each answer must carry ``question_id`` and ``concept_id``. ``verdict`` is
    mapped via :func:`_verdict_to_outcome`. Optional overrides
    (``partial_score``, ``confidence``, ``evidence_quality``,
    ``misconception_signals``, ``strategy_signals``, ``item_id``) are honoured
    when present and within the Observation contract's ranges.

    ``concept_ids`` is the set of ids valid for this graph; an answer whose
    concept_id is not in it fails closed (matches
    ``_validate_observation_bindings``). Duplicate ``question_id`` fails
    closed (Observation ids are replay keys).
    """

    valid = set(concept_ids)
    observations: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for index, answer in enumerate(answers):
        if not isinstance(answer, Mapping):
            raise AnswerError(f"answer #{index} is not a JSON object")

        unknown = set(answer) - {
            "question_id", "concept_id", "verdict",
            "partial_score", "confidence", "evidence_quality",
            "misconception_signals", "strategy_signals",
            "item_id", "item_version", "draft_features",
            "time_cost_ms", "hint_count", "timestamp",
        }
        if unknown:
            raise AnswerError(
                f"answer #{index} has unknown fields: {sorted(unknown)}"
            )

        question_id = answer.get("question_id")
        if not isinstance(question_id, str) or not question_id.strip():
            raise AnswerError(
                f"answer #{index} is missing a string question_id"
            )
        observation_id = question_id.strip()
        if observation_id in seen_ids:
            raise AnswerError(
                f"duplicate question_id {observation_id!r}; "
                "observations must be replayable"
            )
        seen_ids.add(observation_id)

        concept_id = answer.get("concept_id")
        if not isinstance(concept_id, str) or not concept_id.strip():
            raise AnswerError(
                f"answer #{index} ({observation_id!r}) is missing a string concept_id"
            )
        concept_id = concept_id.strip()
        if concept_id not in valid:
            raise AnswerError(
                f"answer #{index} ({observation_id!r}) concept_id "
                f"{concept_id!r} is not a node in this CourseGraph"
            )

        is_correct, confidence, evidence_quality = _verdict_to_outcome(answer.get("verdict"))

        # Optional overrides: trust the caller when they are explicit, but
        # validate ranges so we never produce an Observation the dataclass
        # __post_init__ would reject.
        confidence = _clamp(answer.get("confidence", confidence), 0.0, 1.0, "confidence")
        evidence_quality = _clamp(
            answer.get("evidence_quality", evidence_quality), 0.0, 1.0, "evidence_quality"
        )
        partial_score = _clamp(answer.get("partial_score", 1.0 if is_correct else 0.0), 0.0, 1.0, "partial_score")
        time_cost_ms = _nonneg_int(answer.get("time_cost_ms", 0), "time_cost_ms")
        hint_count = _nonneg_int(answer.get("hint_count", 0), "hint_count")

        obs: dict[str, Any] = {
            "observation_id": observation_id,
            "concept_id": concept_id,
            "is_correct": is_correct,
            "partial_score": partial_score,
            "time_cost_ms": time_cost_ms,
            "hint_count": hint_count,
            "confidence": confidence,
            "draft_features": dict(answer.get("draft_features", {})),
            "misconception_signals": _bounded_map(
                answer.get("misconception_signals", {}), -1.0, 1.0, "misconception_signals"
            ),
            "strategy_signals": _bounded_map(
                answer.get("strategy_signals", {}), -1.0, 1.0, "strategy_signals"
            ),
            "evidence_quality": evidence_quality,
            "item_id": str(answer.get("item_id", question_id)),
            "item_version": str(answer.get("item_version", "")),
            "timestamp": str(answer.get("timestamp", "")),
        }
        observations.append(obs)

    return observations


def _clamp(value: Any, low: float, high: float, name: str) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise AnswerError(f"{name} must be numeric; got {value!r}") from exc
    if not (low <= out <= high):
        raise AnswerError(f"{name}={out} out of range [{low}, {high}]")
    return out


def _nonneg_int(value: Any, name: str) -> int:
    try:
        out = int(value)
    except (TypeError, ValueError) as exc:
        raise AnswerError(f"{name} must be an integer; got {value!r}") from exc
    if out < 0:
        raise AnswerError(f"{name}={out} must be non-negative")
    return out


def _bounded_map(value: Any, low: float, high: float, name: str) -> dict[str, float]:
    if not isinstance(value, Mapping):
        raise AnswerError(f"{name} must be a JSON object mapping name -> weight")
    out: dict[str, float] = {}
    for key, raw in value.items():
        out[str(key)] = _clamp(raw, low, high, f"{name}[{key}]")
    return out


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Convert Stage 2 assessment answers into typed Observation JSON "
            "for `math-research basic --observations`."
        )
    )
    parser.add_argument("--graph", required=True, help="path to an activated CourseGraphVersion .json")
    parser.add_argument("--answers", required=True, help="path to answers.json (list of answer objects)")
    parser.add_argument("--out", help="write Observation JSON here (default: stdout)")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)

    try:
        graph_json = json.loads(Path(args.graph).read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"graph not found: {args.graph}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"graph JSON parse error: {exc}", file=sys.stderr)
        return 2
    if not isinstance(graph_json, Mapping):
        print("graph JSON must be an object with a 'nodes' list", file=sys.stderr)
        return 2

    try:
        answers_raw = json.loads(Path(args.answers).read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"answers not found: {args.answers}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"answers JSON parse error: {exc}", file=sys.stderr)
        return 2
    if isinstance(answers_raw, Mapping):
        if set(answers_raw) != {"aggregate_answer", "diagnostic_items"}:
            print(
                "aggregate answers JSON must contain exactly aggregate_answer and diagnostic_items",
                file=sys.stderr,
            )
            return 2
        try:
            answers_raw = expand_aggregate_negative_answer(
                answers_raw["diagnostic_items"], answers_raw["aggregate_answer"]
            )
        except AnswerError as exc:
            print(f"aggregate answer validation failed: {exc}", file=sys.stderr)
            return 2
    if not isinstance(answers_raw, list):
        print(
            "answers JSON must be a list of answer objects or an aggregate-answer object",
            file=sys.stderr,
        )
        return 2

    concept_ids = extract_concept_ids(graph_json)
    try:
        observations = build_observations_from_answers(answers_raw, concept_ids=concept_ids)
    except AnswerError as exc:
        print(f"answer validation failed: {exc}", file=sys.stderr)
        return 2

    payload = json.dumps(observations, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload + "\n", encoding="utf-8")
    else:
        sys.stdout.write(payload + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
