#!/usr/bin/env python3
"""Discover and validate evidence-backed CourseGraph relations with GLM."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import ssl
import sys
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

NODE_TYPES = {
    "concept",
    "skill",
    "theorem",
    "formula",
    "representation",
    "misconception",
    "resource",
    "research_task",
}
RELATION_TYPES = {
    "prerequisite",
    "part_of",
    "equivalent_to",
    "supports",
    "contradicts",
    "diagnoses",
    "transfers_to",
}
REVIEW_STATES = {
    "proposed",
    "needs_review",
    "behavior_validated",
    "reviewer_approved",
    "active",
    "challenged",
    "retired",
}
DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
DEFAULT_MODEL = "glm-5.3"
PROMPT_VERSION = "maple-coursegraph-c1-c8-v2"
RECEIPT_SCHEMA = "coursegraph-validation-receipt-v1"
REVIEW_SCHEMA = "coursegraph-human-review-v1"


def read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Input JSON must be an object")
    return payload


def write_json(path: Path | None, payload: Mapping[str, Any]) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if path is None:
        sys.stdout.write(text)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def sha256_json(payload: Any) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def normalize_label(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def stable_node_id(label: str) -> str:
    return "k_" + hashlib.sha256(normalized_text(label).encode("utf-8")).hexdigest()[:12]


def stable_edge_id(source_id: str, target_id: str, relation: str) -> str:
    raw = f"{source_id}|{relation}|{target_id}"
    return "e_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    result: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = bytes(value[1:-1], "utf-8").decode("unicode_escape")
        result[name.strip()] = value
    return result


def provider_settings(args: argparse.Namespace) -> tuple[str, str, str]:
    configured_path = os.environ.get("MATH_AI_SECRETS_FILE", "").strip()
    secret_path = (
        Path(configured_path).expanduser()
        if configured_path
        else Path.home() / ".config" / "math-ai" / "credentials.env"
    )
    saved = parse_env_file(secret_path)
    key = (
        os.environ.get("ZHIPU_API_KEY")
        or os.environ.get("BIGMODEL_API_KEY")
        or saved.get("ZHIPU_API_KEY")
        or saved.get("BIGMODEL_API_KEY")
        or ""
    )
    model = args.model or os.environ.get("ZHIPU_MODEL") or saved.get("ZHIPU_MODEL") or DEFAULT_MODEL
    base_url = (
        args.base_url
        or os.environ.get("ZHIPU_BASE_URL")
        or saved.get("ZHIPU_BASE_URL")
        or DEFAULT_BASE_URL
    )
    return key.strip(), model.strip(), base_url.rstrip("/")


def https_context() -> ssl.SSLContext:
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def document_index(request: Mapping[str, Any]) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for index, raw in enumerate(request.get("documents") or []):
        if not isinstance(raw, dict):
            continue
        source_id = normalize_label(raw.get("source_id") or raw.get("id") or f"source-{index + 1}")
        content = str(raw.get("content") or "")
        if source_id and content:
            result[source_id] = {
                "title": normalize_label(raw.get("title") or source_id),
                "source_type": normalize_label(raw.get("source_type") or "material"),
                "content": content,
            }
    return result


def candidate_node_labels(request: Mapping[str, Any]) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for item in request.get("candidate_nodes") or []:
        if isinstance(item, str):
            label, node_type = normalize_label(item), "concept"
        elif isinstance(item, dict):
            label = normalize_label(item.get("label") or item.get("name"))
            node_type = normalize_label(item.get("type") or "concept")
        else:
            continue
        if label:
            result.append((label, node_type if node_type in NODE_TYPES else "concept"))
    return result


def build_prompt(request: Mapping[str, Any]) -> str:
    docs = document_index(request)
    compact_docs = [
        {
            "source_id": source_id,
            "title": data["title"],
            "source_type": data["source_type"],
            "content": data["content"][:16000],
        }
        for source_id, data in docs.items()
    ]
    candidates = [label for label, _ in candidate_node_labels(request)]
    schema = {
        "nodes": [
            {
                "label": "string",
                "type": (
                    "concept|skill|theorem|formula|representation|misconception|"
                    "resource|research_task"
                ),
                "aliases": ["string"],
                "evidence": [{"source_id": "string", "quote": "verbatim source span"}],
            }
        ],
        "edges": [
            {
                "source": "exact node label",
                "target": "exact node label",
                "relation": (
                    "prerequisite|part_of|equivalent_to|supports|contradicts|diagnoses|transfers_to"
                ),
                "weight": 0.0,
                "confidence": 0.0,
                "scope": "conditions under which the relation holds",
                "evidence": [{"source_id": "string", "quote": "verbatim source span"}],
                "reason": "concise evidence-bound explanation",
            }
        ],
    }
    return "\n".join(
        [
            "You are the candidate relation miner for a MAPLE-Loop CourseGraph.",
            "Return JSON only. Do not use Markdown fences.",
            "Treat every edge as a proposal, not verified truth.",
            "Use only the allowed node and relation types in the schema.",
            (
                "For prerequisite, source must be learned before or materially enable target; "
                "weight is dependency strength, not text similarity."
            ),
            (
                "For equivalent_to, require genuine interchangeability under the stated scope; "
                "a formula that helps determine a graph is not automatically equivalent to "
                "that graph."
            ),
            (
                "For part_of, source must be an actual constituent of target; a skill used to "
                "operate on a representation is not part of that representation."
            ),
            (
                "Only emit an edge when its weight is greater than 0.05. Omit zero-strength or "
                "merely speculative links."
            ),
            (
                "Every edge must cite at least one verbatim quote from the supplied source_id. "
                "Do not invent quotes or sources."
            ),
            (
                "Avoid self edges, duplicate edges, and prerequisite cycles. Prefer direct "
                "prerequisites over transitive shortcuts."
            ),
            f"Course ID: {normalize_label(request.get('course_id') or 'course')}",
            f"Candidate nodes: {json.dumps(candidates, ensure_ascii=False)}",
            "Required response schema:",
            json.dumps(schema, ensure_ascii=False),
            "Source documents:",
            json.dumps(compact_docs, ensure_ascii=False),
        ]
    )


def call_glm(prompt: str, key: str, model: str, base_url: str, timeout: int) -> dict[str, Any]:
    request_payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "Produce a strict evidence-bound CourseGraph JSON object.",
            },
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 8192,
    }
    normalized_model = model.casefold()
    if normalized_model.startswith(("glm-4.7", "glm-5")):
        request_payload["thinking"] = {"type": "enabled"}
    if normalized_model.startswith(("glm-5.2", "glm-5.3")):
        request_payload["reasoning_effort"] = "max"
    body = json.dumps(request_payload).encode("utf-8")
    request = Request(
        f"{base_url}/chat/completions",
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout, context=https_context()) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        raise RuntimeError(f"GLM request failed: HTTP {exc.code} - {detail}") from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError(f"GLM request failed: {exc}") from exc

    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("GLM response did not contain message content") from exc
    if isinstance(content, list):
        content = "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
    return parse_model_json(str(content))


def parse_model_json(content: str) -> dict[str, Any]:
    text = content.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise RuntimeError("GLM response was not valid JSON") from exc
        try:
            payload = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"GLM response was not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("GLM response JSON must be an object")
    return payload


def evidence_list(
    raw: Any, docs: Mapping[str, Mapping[str, str]]
) -> tuple[list[dict[str, Any]], list[str]]:
    result: list[dict[str, Any]] = []
    warnings: list[str] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        source_id = normalize_label(item.get("source_id") or item.get("source"))
        quote = normalize_label(item.get("quote") or item.get("span") or item.get("verbatim_span"))
        source = docs.get(source_id)
        verified = bool(
            source and quote and normalized_text(quote) in normalized_text(source["content"])
        )
        if source_id and quote:
            result.append({"source_id": source_id, "quote": quote, "verified": verified})
        if not verified and source_id:
            warnings.append(f"unverified evidence span in {source_id}")
    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for item in result:
        unique[(item["source_id"], item["quote"])] = item
    return list(unique.values()), warnings


def as_probability(value: Any, field: str, errors: list[str], context: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        errors.append(f"{context}: {field} is not numeric")
        return 0.0
    if not 0 <= number <= 1:
        errors.append(f"{context}: {field} must be between 0 and 1")
    return max(0.0, min(1.0, number))


def behavior_lookup(request: Mapping[str, Any]) -> dict[tuple[str, str], tuple[float, int]]:
    result: dict[tuple[str, str], tuple[float, int]] = {}
    for item in request.get("behavior_evidence") or []:
        if not isinstance(item, dict):
            continue
        source = normalized_text(normalize_label(item.get("source")))
        target = normalized_text(normalize_label(item.get("target")))
        try:
            lift = float(item.get("performance_lift"))
            sample = int(item.get("sample_size"))
        except (TypeError, ValueError):
            continue
        if source and target:
            result[(source, target)] = (lift, sample)
    return result


def prerequisite_cycles(edges: Sequence[Mapping[str, Any]]) -> list[list[str]]:
    adjacency: dict[str, list[str]] = {}
    for edge in edges:
        if edge.get("relation") == "prerequisite":
            adjacency.setdefault(str(edge["source_node"]), []).append(str(edge["target_node"]))
    visiting: set[str] = set()
    visited: set[str] = set()
    stack: list[str] = []
    cycles: list[list[str]] = []

    def visit(node: str) -> None:
        if node in visiting:
            try:
                start = stack.index(node)
            except ValueError:
                start = 0
            cycle = stack[start:] + [node]
            if cycle not in cycles:
                cycles.append(cycle)
            return
        if node in visited:
            return
        visiting.add(node)
        stack.append(node)
        for target in adjacency.get(node, []):
            visit(target)
        stack.pop()
        visiting.remove(node)
        visited.add(node)

    for source in list(adjacency):
        visit(source)
    return cycles


def has_alternate_path(
    edges: Sequence[Mapping[str, Any]], source: str, target: str, skip: int
) -> bool:
    adjacency: dict[str, list[str]] = {}
    for index, edge in enumerate(edges):
        if index == skip or edge.get("relation") != "prerequisite":
            continue
        adjacency.setdefault(str(edge["source_node"]), []).append(str(edge["target_node"]))
    pending = list(adjacency.get(source, []))
    seen: set[str] = set()
    while pending:
        current = pending.pop()
        if current == target:
            return True
        if current in seen:
            continue
        seen.add(current)
        pending.extend(adjacency.get(current, []))
    return False


def transitive_reduction(
    edges: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    indirect_indexes = {
        index
        for index, edge in enumerate(edges)
        if edge.get("relation") == "prerequisite"
        and has_alternate_path(edges, str(edge["source_node"]), str(edge["target_node"]), index)
    }
    direct = [edge for index, edge in enumerate(edges) if index not in indirect_indexes]
    indirect = [
        {**edge, "direct": False} for index, edge in enumerate(edges) if index in indirect_indexes
    ]
    return direct, indirect


def normalize_graph(
    request: Mapping[str, Any],
    candidate: Mapping[str, Any],
    model: str,
    trust_review_states: bool = False,
    review_record: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    docs = document_index(request)
    raw_graph = candidate.get("graph") if isinstance(candidate.get("graph"), dict) else candidate
    raw_nodes = raw_graph.get("nodes") if isinstance(raw_graph, dict) else []
    raw_edges = raw_graph.get("edges") if isinstance(raw_graph, dict) else []
    if trust_review_states and isinstance(raw_graph, dict):
        raw_edges = [
            *(raw_edges if isinstance(raw_edges, list) else []),
            *(
                raw_graph.get("indirect_edges")
                if isinstance(raw_graph.get("indirect_edges"), list)
                else []
            ),
            *(
                raw_graph.get("retired_edges")
                if isinstance(raw_graph.get("retired_edges"), list)
                else []
            ),
        ]

    node_specs: list[dict[str, Any]] = []
    for label, node_type in candidate_node_labels(request):
        node_specs.append({"label": label, "type": node_type, "aliases": [], "evidence": []})
    for raw in raw_nodes if isinstance(raw_nodes, list) else []:
        if isinstance(raw, str):
            node_specs.append({"label": raw, "type": "concept", "aliases": [], "evidence": []})
        elif isinstance(raw, dict):
            node_specs.append(raw)

    nodes_by_label: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(node_specs):
        label = normalize_label(raw.get("label") or raw.get("name"))
        if not label:
            errors.append(f"node[{index}]: missing label")
            continue
        node_type = normalize_label(raw.get("type") or "concept")
        if node_type not in NODE_TYPES:
            errors.append(f"node {label}: unsupported type {node_type}")
            node_type = "concept"
        key = normalized_text(label)
        evidence, evidence_warnings = evidence_list(
            raw.get("evidence") or raw.get("evidence_sources"), docs
        )
        warnings.extend(f"node {label}: {item}" for item in evidence_warnings)
        aliases = [
            normalize_label(item) for item in raw.get("aliases") or [] if normalize_label(item)
        ]
        existing = nodes_by_label.get(key)
        if existing:
            existing["aliases"] = sorted(
                set(existing["aliases"] + aliases + ([label] if label != existing["label"] else []))
            )
            existing["evidence_sources"] = merge_evidence(existing["evidence_sources"], evidence)
            continue
        nodes_by_label[key] = {
            "concept_id": stable_node_id(label),
            "label": label,
            "type": node_type,
            "aliases": sorted(set(aliases)),
            "evidence_sources": evidence,
        }

    nodes_by_id = {node["concept_id"]: node for node in nodes_by_label.values()}
    nodes_by_ref: dict[str, dict[str, Any]] = {}
    for node in nodes_by_label.values():
        for ref in (node["concept_id"], node["label"], *node["aliases"]):
            if normalize_label(ref):
                nodes_by_ref[normalized_text(str(ref))] = node
    # Preserve temporary/source IDs (for example N01) as aliases while still
    # emitting stable k_* IDs. This makes deterministic validation compatible
    # with hand-authored or model-authored candidate graphs.
    for raw in node_specs:
        if not isinstance(raw, dict):
            continue
        label = normalize_label(raw.get("label") or raw.get("name"))
        node = nodes_by_label.get(normalized_text(label))
        if not node:
            continue
        for ref in (raw.get("concept_id"), raw.get("node_id"), raw.get("id")):
            if normalize_label(ref):
                nodes_by_ref[normalized_text(str(ref))] = node

    behavior = behavior_lookup(request)
    merged_edges: dict[tuple[str, str, str], dict[str, Any]] = {}
    retired_edges: dict[tuple[str, str, str], dict[str, Any]] = {}
    for index, raw in enumerate(raw_edges if isinstance(raw_edges, list) else []):
        if not isinstance(raw, dict):
            errors.append(f"edge[{index}]: edge must be an object")
            continue
        source_label = normalize_label(
            raw.get("source") or raw.get("source_label") or raw.get("source_node")
        )
        target_label = normalize_label(
            raw.get("target") or raw.get("target_label") or raw.get("target_node")
        )
        relation = normalize_label(raw.get("relation"))
        context = f"edge {source_label or '?'} -[{relation or '?'}]-> {target_label or '?'}"
        source = nodes_by_ref.get(normalized_text(source_label)) or nodes_by_id.get(source_label)
        target = nodes_by_ref.get(normalized_text(target_label)) or nodes_by_id.get(target_label)
        if not source or not target:
            errors.append(f"{context}: endpoint missing from nodes")
            continue
        if source["concept_id"] == target["concept_id"]:
            errors.append(f"{context}: self edge is not allowed")
            continue
        if relation not in RELATION_TYPES:
            errors.append(f"{context}: unsupported relation")
            continue
        supplied_status = (
            normalize_label(raw.get("reviewer_status") or "") if trust_review_states else ""
        )
        is_retired = supplied_status == "retired"
        weight_default = 0.0 if is_retired else 0.5
        weight = as_probability(
            raw.get("weight", raw.get("edge_weight", weight_default)), "weight", errors, context
        )
        if not is_retired and weight <= 0.05:
            errors.append(f"{context}: weight must be greater than 0.05 for an emitted edge")
        confidence = as_probability(raw.get("confidence", 0.5), "confidence", errors, context)
        evidence, evidence_warnings = evidence_list(
            raw.get("evidence") or raw.get("evidence_sources"), docs
        )
        warnings.extend(f"{context}: {item}" for item in evidence_warnings)
        verified_count = sum(1 for item in evidence if item.get("verified"))
        reviewer_status = supplied_status if trust_review_states else "proposed"
        if reviewer_status not in REVIEW_STATES:
            reviewer_status = "proposed"
        if verified_count == 0 and not is_retired:
            errors.append(f"{context}: no verified evidence")
            confidence = min(confidence, 0.45)
            reviewer_status = "needs_review"

        behavior_item = behavior.get(
            (normalized_text(source["label"]), normalized_text(target["label"]))
        )
        behavior_record = None
        if behavior_item and relation == "prerequisite" and not is_retired:
            lift, sample = behavior_item
            behavior_record = {"performance_lift": lift, "sample_size": sample}
            already_applied = trust_review_states and isinstance(raw.get("behavior_evidence"), dict)
            if already_applied:
                behavior_record = {
                    "performance_lift": float(
                        raw["behavior_evidence"].get("performance_lift", lift)
                    ),
                    "sample_size": int(raw["behavior_evidence"].get("sample_size", sample)),
                }
            elif sample >= 30 and lift >= 0.08:
                weight = min(1.0, weight + 0.10)
                if reviewer_status == "proposed":
                    reviewer_status = "behavior_validated"
            elif sample >= 30 and lift <= 0.02:
                weight = round(weight * 0.5, 6)
                reviewer_status = "needs_review"
                warnings.append(
                    f"{context}: behavior evidence does not support a strong dependency"
                )

        source_id, target_id = source["concept_id"], target["concept_id"]
        if relation in {"equivalent_to", "contradicts"} and source_id > target_id:
            source_id, target_id = target_id, source_id
            source, target = target, source
        edge_key = (source_id, target_id, relation)
        normalized = {
            "edge_id": stable_edge_id(source_id, target_id, relation),
            "source_node": source_id,
            "source_label": source["label"],
            "target_node": target_id,
            "target_label": target["label"],
            "relation": relation,
            "edge_weight": round(weight, 6),
            "semantic_confidence": round(confidence, 6),
            "scope": normalize_label(raw.get("scope")),
            "reason": normalize_label(raw.get("reason")),
            "evidence_sources": evidence,
            "behavior_evidence": behavior_record,
            "reviewer_status": reviewer_status,
            "valid_from_version": "pending",
            "direct": not is_retired,
        }
        if is_retired:
            normalized["reviewer_status"] = "retired"
            normalized["removal_reason"] = normalize_label(
                raw.get("removal_reason") or raw.get("reason") or raw.get("scope")
            )
            retired_edges[edge_key] = normalized
            continue
        existing = merged_edges.get(edge_key)
        if existing:
            existing["edge_weight"] = round(
                (existing["edge_weight"] + normalized["edge_weight"]) / 2, 6
            )
            existing["semantic_confidence"] = max(
                existing["semantic_confidence"], normalized["semantic_confidence"]
            )
            existing["evidence_sources"] = merge_evidence(
                existing["evidence_sources"], normalized["evidence_sources"]
            )
        else:
            merged_edges[edge_key] = normalized

    all_edges = sorted(
        merged_edges.values(),
        key=lambda item: (item["source_node"], item["relation"], item["target_node"]),
    )
    cycles = prerequisite_cycles(all_edges)
    if cycles:
        errors.append(f"prerequisite graph contains {len(cycles)} cycle(s)")
    direct_edges, indirect_edges = (
        transitive_reduction(all_edges) if not cycles else (all_edges, [])
    )
    if indirect_edges:
        warnings.append(
            f"removed {len(indirect_edges)} transitive prerequisite edge(s) from the direct graph"
        )

    retired_edge_list = sorted(
        retired_edges.values(),
        key=lambda item: (item["source_node"], item["relation"], item["target_node"]),
    )
    canonical = {
        "nodes": sorted(nodes_by_label.values(), key=lambda item: item["concept_id"]),
        "edges": direct_edges,
        "indirect_edges": indirect_edges,
        "retired_edges": retired_edge_list,
    }
    course_id = normalize_label(request.get("course_id") or candidate.get("course_id") or "course")
    graph_version = f"{course_id}@{sha256_json(canonical)[:12]}"
    for edge in direct_edges + indirect_edges + retired_edge_list:
        if edge["valid_from_version"] == "pending":
            edge["valid_from_version"] = graph_version
    hard_pass = not errors
    review_required_count = sum(
        edge["reviewer_status"] not in {"reviewer_approved", "active"} for edge in direct_edges
    )
    graph_status = "active" if hard_pass and review_required_count == 0 else "draft"
    now = datetime.now(UTC).isoformat()
    result: dict[str, Any] = {
        "course_id": course_id,
        "graph_version": graph_version,
        "graph_status": graph_status,
        "created_at": now,
        "request": embedded_request(request),
        "nodes": canonical["nodes"],
        "edges": direct_edges,
        "indirect_edges": indirect_edges,
        "retired_edges": retired_edge_list,
        "validation": {
            "hard_pass": hard_pass,
            "errors": sorted(set(errors)),
            "warnings": sorted(set(warnings)),
            "cycles": cycles,
            "evidence_coverage": round(
                sum(
                    1
                    for edge in direct_edges
                    if any(item.get("verified") for item in edge["evidence_sources"])
                )
                / max(1, len(direct_edges)),
                6,
            ),
            "review_required_count": review_required_count,
        },
    }
    if review_record is not None:
        result["review_record"] = dict(review_record)
    result["decision_certificate"] = {
        "certificate_id": "cert_"
        + sha256_json({"graph_version": graph_version, "input": request})[:16],
        "prompt_version": PROMPT_VERSION,
        "model": model,
        "input_checksum": sha256_json(request),
        "review_checksum": sha256_json(review_record) if review_record is not None else None,
        "graph_checksum": sha256_json(canonical),
        "source_ids": sorted(docs),
        "node_count": len(canonical["nodes"]),
        "direct_edge_count": len(direct_edges),
        "indirect_edge_count": len(indirect_edges),
        "retired_edge_count": len(retired_edge_list),
        "hard_pass": hard_pass,
        "graph_status": graph_status,
        "created_at": now,
    }
    return result


def apply_human_review(candidate: Mapping[str, Any], review: Mapping[str, Any]) -> dict[str, Any]:
    """Apply an explicit, candidate-bound human review to editable edges.

    Candidate/model supplied review states are never authority. The separate
    record must bind to the exact candidate checksum and decide every edge.
    This is an auditable attestation, not an identity-verification service.
    """

    if review.get("review_schema") != REVIEW_SCHEMA:
        raise ValueError(f"review_schema must be {REVIEW_SCHEMA}")
    if review.get("candidate_checksum") != sha256_json(candidate):
        raise ValueError("review candidate_checksum does not match the candidate")
    reviewer = review.get("reviewer")
    if not isinstance(reviewer, dict):
        raise ValueError("reviewer must be an object")
    for field in ("reviewer_id", "role", "reviewed_at"):
        if not normalize_label(reviewer.get(field)):
            raise ValueError(f"reviewer.{field} is required")
    if reviewer.get("human_attestation") is not True:
        raise ValueError("reviewer.human_attestation must be true")

    decisions = review.get("decisions")
    if not isinstance(decisions, list):
        raise ValueError("review decisions must be a list")
    decision_map: dict[tuple[str, str, str], Mapping[str, Any]] = {}
    for index, item in enumerate(decisions):
        if not isinstance(item, dict):
            raise ValueError(f"review decision[{index}] must be an object")
        key = (
            normalized_text(normalize_label(item.get("source_node"))),
            normalized_text(normalize_label(item.get("target_node"))),
            normalize_label(item.get("relation")),
        )
        if not all(key):
            raise ValueError(f"review decision[{index}] has an incomplete edge key")
        if key in decision_map:
            raise ValueError(f"duplicate review decision for {key}")
        decision = normalize_label(item.get("decision"))
        if decision not in {"approve", "challenge", "retire"}:
            raise ValueError(f"review decision[{index}] has unsupported decision {decision}")
        if not normalize_label(item.get("rationale")):
            raise ValueError(f"review decision[{index}] requires a rationale")
        decision_map[key] = item

    reviewed = copy.deepcopy(candidate)
    raw_graph = reviewed.get("graph") if isinstance(reviewed.get("graph"), dict) else reviewed
    raw_edges = raw_graph.get("edges") if isinstance(raw_graph, dict) else None
    if not isinstance(raw_edges, list):
        raise ValueError("candidate edges must be a list")
    used: set[tuple[str, str, str]] = set()
    status_by_decision = {
        "approve": "reviewer_approved",
        "challenge": "challenged",
        "retire": "retired",
    }
    for index, edge in enumerate(raw_edges):
        if not isinstance(edge, dict):
            raise ValueError(f"candidate edge[{index}] must be an object")
        key = (
            normalized_text(
                normalize_label(
                    edge.get("source") or edge.get("source_node") or edge.get("source_label")
                )
            ),
            normalized_text(
                normalize_label(
                    edge.get("target") or edge.get("target_node") or edge.get("target_label")
                )
            ),
            normalize_label(edge.get("relation")),
        )
        item = decision_map.get(key)
        if item is None:
            raise ValueError(f"candidate edge[{index}] has no human review decision")
        used.add(key)
        edge["reviewer_status"] = status_by_decision[normalize_label(item.get("decision"))]
        if edge["reviewer_status"] == "retired":
            edge["removal_reason"] = normalize_label(item.get("rationale"))
    unused = sorted(set(decision_map) - used)
    if unused:
        raise ValueError(f"review contains {len(unused)} decision(s) for unknown edges")
    return reviewed


def embedded_request(request: Mapping[str, Any]) -> dict[str, Any]:
    """Keep the evidence-bearing input needed for deterministic revalidation."""

    docs = document_index(request)
    return {
        "course_id": normalize_label(request.get("course_id") or "course"),
        "documents": [
            {
                "source_id": source_id,
                "title": data["title"],
                "source_type": data["source_type"],
                "content": data["content"],
            }
            for source_id, data in docs.items()
        ],
        "candidate_nodes": request.get("candidate_nodes") or [],
        "behavior_evidence": request.get("behavior_evidence") or [],
    }


def merge_evidence(
    left: Iterable[Mapping[str, Any]], right: Iterable[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for item in [*left, *right]:
        source_id = normalize_label(item.get("source_id"))
        quote = normalize_label(item.get("quote"))
        if source_id and quote:
            merged[(source_id, quote)] = {
                "source_id": source_id,
                "quote": quote,
                "verified": item.get("verified") is True,
            }
    return list(merged.values())


def discover(args: argparse.Namespace) -> int:
    request = read_json(Path(args.input))
    if not document_index(request):
        raise ValueError("Discovery input must contain at least one non-empty document")
    key, model, base_url = provider_settings(args)
    if not key:
        raise RuntimeError("GLM is not configured. Run scripts/configure_glm_key.py first.")
    prompt = build_prompt(request)
    candidate = call_glm(prompt, key, model, base_url, args.timeout)
    result = normalize_graph(request, candidate, model, trust_review_states=False)
    write_json(Path(args.output) if args.output else None, result)
    return 0 if result["validation"]["hard_pass"] else 2


def validate(args: argparse.Namespace) -> int:
    candidate = read_json(Path(args.input))
    if args.request:
        request = read_json(Path(args.request))
    elif isinstance(candidate.get("request"), dict):
        request = candidate["request"]
    else:
        request = {
            "course_id": candidate.get("course_id") or "course",
            "documents": candidate.get("documents") or [],
            "candidate_nodes": [],
            "behavior_evidence": candidate.get("behavior_evidence") or [],
        }
    review = read_json(Path(args.review)) if args.review else None
    reviewed_candidate = apply_human_review(candidate, review) if review is not None else candidate
    model = str(candidate.get("decision_certificate", {}).get("model") or "deterministic-validator")
    result = normalize_graph(
        request,
        reviewed_candidate,
        model,
        # Candidate/model states are not authority. Only the separate,
        # candidate-bound review record may approve an edge.
        trust_review_states=review is not None,
        review_record=review,
    )
    write_json(Path(args.output) if args.output else None, result)
    return 0 if result["validation"]["hard_pass"] else 2


def validation_receipt(graph: Mapping[str, Any]) -> dict[str, Any]:
    """Derive a tamper-evident receipt from validator output only."""

    validation = graph.get("validation") if isinstance(graph.get("validation"), dict) else {}
    certificate = (
        graph.get("decision_certificate")
        if isinstance(graph.get("decision_certificate"), dict)
        else {}
    )
    nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
    edges = graph.get("edges") if isinstance(graph.get("edges"), list) else []
    indirect_edges = (
        graph.get("indirect_edges") if isinstance(graph.get("indirect_edges"), list) else []
    )
    retired_edges = (
        graph.get("retired_edges") if isinstance(graph.get("retired_edges"), list) else []
    )
    canonical = {
        "nodes": nodes,
        "edges": edges,
        "indirect_edges": indirect_edges,
        "retired_edges": retired_edges,
    }
    integrity_errors: list[str] = []
    if not certificate:
        integrity_errors.append("decision_certificate is missing")
    if certificate.get("graph_checksum") != sha256_json(canonical):
        integrity_errors.append("graph checksum does not match decision_certificate")
    if certificate.get("node_count") != len(nodes):
        integrity_errors.append("node count does not match decision_certificate")
    if certificate.get("direct_edge_count") != len(edges):
        integrity_errors.append("direct edge count does not match decision_certificate")
    if certificate.get("indirect_edge_count") != len(indirect_edges):
        integrity_errors.append("indirect edge count does not match decision_certificate")
    if certificate.get("retired_edge_count", 0) != len(retired_edges):
        integrity_errors.append("retired edge count does not match decision_certificate")
    if certificate.get("hard_pass") is not validation.get("hard_pass"):
        integrity_errors.append("hard_pass does not match decision_certificate")
    if certificate.get("graph_status") != graph.get("graph_status"):
        integrity_errors.append("graph status does not match decision_certificate")
    request = graph.get("request") if isinstance(graph.get("request"), dict) else None
    if request is None:
        integrity_errors.append("embedded evidence request is missing")
    elif certificate.get("input_checksum") != sha256_json(request):
        integrity_errors.append("input checksum does not match embedded request")
    review_record = graph.get("review_record")
    expected_review_checksum = (
        sha256_json(review_record) if isinstance(review_record, dict) else None
    )
    if certificate.get("review_checksum") != expected_review_checksum:
        integrity_errors.append("review checksum does not match decision_certificate")

    relation_counts = {
        relation: sum(1 for edge in edges if edge.get("relation") == relation)
        for relation in sorted(
            {str(edge.get("relation")) for edge in edges if edge.get("relation")}
        )
    }
    reviewer_status_counts = {
        status: sum(1 for edge in edges if edge.get("reviewer_status") == status)
        for status in sorted(
            {str(edge.get("reviewer_status")) for edge in edges if edge.get("reviewer_status")}
        )
    }
    return {
        "receipt_schema": RECEIPT_SCHEMA,
        "integrity_ok": not integrity_errors,
        "integrity_errors": integrity_errors,
        "course_id": graph.get("course_id"),
        "graph_version": graph.get("graph_version"),
        "graph_status": graph.get("graph_status"),
        "model": certificate.get("model"),
        "node_count": len(nodes),
        "direct_edge_count": len(edges),
        "indirect_edge_count": len(indirect_edges),
        "retired_edge_count": len(retired_edges),
        "relation_counts": relation_counts,
        "reviewer_status_counts": reviewer_status_counts,
        "verified_evidence_span_count": sum(
            1
            for edge in edges
            for item in edge.get("evidence_sources") or []
            if item.get("verified") is True
        ),
        "evidence_coverage": validation.get("evidence_coverage"),
        "hard_pass": not integrity_errors and validation.get("hard_pass") is True,
        "errors": validation.get("errors") or [],
        "warnings": validation.get("warnings") or [],
        "cycles": validation.get("cycles") or [],
        "review_required_count": validation.get("review_required_count"),
        "certificate_id": certificate.get("certificate_id"),
        "graph_checksum": certificate.get("graph_checksum"),
        "input_checksum": certificate.get("input_checksum"),
        "review_checksum": certificate.get("review_checksum"),
    }


def receipt(args: argparse.Namespace) -> int:
    graph = read_json(Path(args.input))
    result = validation_receipt(graph)
    write_json(Path(args.output) if args.output else None, result)
    return 0 if result["integrity_ok"] and result["hard_pass"] else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    discover_parser = subparsers.add_parser("discover")
    discover_parser.add_argument("--input", required=True)
    discover_parser.add_argument("--output")
    discover_parser.add_argument("--model")
    discover_parser.add_argument("--base-url")
    discover_parser.add_argument("--timeout", type=int, default=90)

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--input", required=True)
    validate_parser.add_argument("--request", help="Original evidence-bearing discovery input JSON")
    validate_parser.add_argument(
        "--review",
        help="Candidate-bound human edge-review JSON; without it candidate states are ignored",
    )
    validate_parser.add_argument("--output")

    receipt_parser = subparsers.add_parser("receipt")
    receipt_parser.add_argument("--input", required=True)
    receipt_parser.add_argument("--output")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "discover":
            return discover(args)
        if args.command == "validate":
            return validate(args)
        return receipt(args)
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
