#!/usr/bin/env python3
"""Build a checksum-bound learning→research handoff after explicit confirmation.

This script does not execute research.  It freezes the learning receipt and,
when available, the Basic engine's read-only research context so the research
skill can consume them without rewriting learning evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

SCHEMA_VERSION = "learning-research-handoff-v1"
INTENTS = {"evidence_research", "original_research"}
EXPLICIT_TRANSITION_RE = re.compile(
    r"我要进入研究|开始研究|进入原创研究",
    re.I,
)


class BridgeError(ValueError):
    """Raised when a learning→research handoff would be unauditable."""


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _checksum(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def build_handoff(
    *,
    receipt: Mapping[str, Any],
    transition_intent: str,
    explicit_confirmation: str,
    basic_plan: Mapping[str, Any] | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Return a sealed handoff; never mutate the supplied receipt or plan."""
    if receipt.get("schema_version") != 1:
        raise BridgeError("LearningSessionReceipt schema_version must be 1")
    if not str(receipt.get("topic") or "").strip():
        raise BridgeError("LearningSessionReceipt topic is required")
    if transition_intent not in INTENTS:
        raise BridgeError(f"unsupported transition_intent: {transition_intent}")
    confirmation = str(explicit_confirmation or "").strip()
    if not EXPLICIT_TRANSITION_RE.search(confirmation):
        raise BridgeError("explicit research transition confirmation is required")

    context: dict[str, Any] | None = None
    context_checksum = ""
    context_status = "unavailable_legacy"
    if basic_plan is not None:
        candidate = basic_plan.get("research_context")
        expected = str(basic_plan.get("research_context_checksum") or "")
        if candidate:
            if not isinstance(candidate, dict) or not expected:
                raise BridgeError("Basic research context and checksum must be supplied together")
            actual = _checksum(candidate)
            if actual != expected:
                raise BridgeError("Basic research context checksum mismatch")
            context = json.loads(json.dumps(candidate, ensure_ascii=False))
            context_checksum = expected
            context_status = "verified"

    frozen_receipt = json.loads(json.dumps(dict(receipt), ensure_ascii=False))
    body = {
        "schema_version": SCHEMA_VERSION,
        "transition_intent": transition_intent,
        "explicit_confirmation": confirmation,
        "created_at": created_at or datetime.now(timezone.utc).isoformat(),
        "learning_session_receipt": frozen_receipt,
        "learning_receipt_checksum": _checksum(frozen_receipt),
        "basic_research_context": context,
        "basic_research_context_checksum": context_checksum,
        "basic_context_status": context_status,
        "boundary": {
            "learning_evidence_is_read_only": True,
            "mastery_is_not_a_research_result": True,
            "research_gates_are_not_satisfied_by_this_handoff": True,
        },
    }
    return {**body, "handoff_checksum": _checksum(body)}


def verify_handoff(value: Mapping[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if value.get("schema_version") != SCHEMA_VERSION:
        errors.append("schema_version mismatch")
    receipt = value.get("learning_session_receipt")
    if not isinstance(receipt, dict) or value.get("learning_receipt_checksum") != _checksum(receipt):
        errors.append("learning receipt checksum mismatch")
    context = value.get("basic_research_context")
    if context is not None and value.get("basic_research_context_checksum") != _checksum(context):
        errors.append("Basic research context checksum mismatch")
    body = {key: item for key, item in value.items() if key != "handoff_checksum"}
    if value.get("handoff_checksum") != _checksum(body):
        errors.append("handoff checksum mismatch")
    return (not errors), errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--intent", required=True, choices=sorted(INTENTS))
    parser.add_argument("--confirmation", required=True)
    parser.add_argument("--basic-plan")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    receipt = json.loads(Path(args.receipt).read_text(encoding="utf-8"))
    plan = (
        json.loads(Path(args.basic_plan).read_text(encoding="utf-8"))
        if args.basic_plan
        else None
    )
    handoff = build_handoff(
        receipt=receipt,
        transition_intent=args.intent,
        explicit_confirmation=args.confirmation,
        basic_plan=plan,
    )
    target = Path(args.out).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(handoff, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)
    print(json.dumps({"ok": True, "path": str(target), "checksum": handoff["handoff_checksum"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
