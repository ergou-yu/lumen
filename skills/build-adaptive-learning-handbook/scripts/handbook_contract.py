#!/usr/bin/env python3
"""Deterministic contracts for adaptive evidence-backed learning handbooks."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from copy import deepcopy
from pathlib import Path
from typing import Any

SCENARIOS = {"concept_building", "practice", "exam_prep", "real_world_application"}
TARGET_LEVELS = {"foundation", "undergraduate", "graduate", "advanced", "research_readiness"}
TARGET_LEVEL_SOURCES = {"explicit", "inferred"}
RESEARCH_INTENTS = {"learning", "research_readiness", "original_research"}
PROFILES = {"exam_compact", "concept_systematic", "advanced_theory", "research_readiness"}
ORIGINS = {"graph", "web", "图谱", "Web", "教材", "teacher", "user"}
VERDICTS = {"会", "不会", "correct", "incorrect", "yes", "no", "partial"}
EVIDENCE_KINDS = {"worked", "self_report", "scored", "teacher_observation"}

ORIGINAL_RESEARCH_RE = re.compile(r"原创|新定理|新结果|可发表|发表|创新性|novel|publish", re.I)
RESEARCH_READY_RE = re.compile(r"读论文|阅读论文|研究准备|研究级学习|research.?readiness", re.I)
RAW_LATEX_RE = re.compile(r"\$|\\(?:frac|pi|begin|end|left|right|vee|wedge|mathbb)|\\\(|\\\)")
MATH_SPAN_RE = re.compile(
    r"\[\[(INLINE|DISPLAY)_MATH\]\](.+?)\[\[/\1_MATH\]\]"
)
MATH_TAG_RE = re.compile(r"\[\[/?(?:INLINE|DISPLAY)_MATH\]\]")
ANY_TYPED_TAG_RE = re.compile(r"\[\[/?(?:INLINE|DISPLAY)_[A-Z_]+\]\]", re.I)
UNSAFE_LATEX_RE = re.compile(
    r"\\(?:href|url|includegraphics|input|include|write|html|class|style|require|def|newcommand)\b",
    re.I,
)
PLAIN_MATH_RE = re.compile(
    r"[∂∫∮∑∏√∞≠≡≤≥→↦≅∈∉⊂⊆∪∩∘∧∨≈±×÷ℝℤℚℂ]"
    r"|[α-ωΑ-Ω]"
    r"|[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ⁻⁺ᵐⁱʲᵏ₀₁₂₃₄₅₆₇₈₉ₚᵢⱼₖ]"
    r"|(?<!\w)[A-Za-z][A-Za-z0-9_']*\s*\^"
)
URL_RE = re.compile(r"https?://", re.I)
OUTLINE_ONLY_RE = re.compile(r"^(?:[-*•]\s*[^\n]+\n?){3,}$", re.M)
END_MARKER = "【本节完成】"
MARKDOWN_NOISE_RE = re.compile(r"(?m)^\s*(?:#{1,6}\s+|-{2,}\s*$)")
SELF_CORRECTION_RE = re.compile(
    r"(?:需要?|需)注意符号[^。【】]{0,100}(?:严格地|正确的?)",
    re.S,
)
TOPIC_SUFFIX_RE = re.compile(r"(?:考试)?复习|学习手册|学习文档|详细手册")
TOPIC_COMPOSITE_SEPARATOR_RE = re.compile(r"\s*(?:以及|与|、)\s*")
TOPIC_SYMBOLIC_NOUN_RE = re.compile(
    r"([A-Za-z\u4e00-\u9fff·.'’ -]{2,48}?)([α-ωΑ-Ωϕ])\s*(函数|映射|分布)"
)
TOPIC_SYMBOL_ALIASES = (
    (r"\varphi", "φ"),
    (r"\phi", "φ"),
    (r"\varepsilon", "ε"),
    (r"\epsilon", "ε"),
    (r"\vartheta", "θ"),
    (r"\theta", "θ"),
    (r"\varrho", "ρ"),
    (r"\rho", "ρ"),
    (r"\varsigma", "ς"),
    (r"\sigma", "σ"),
    (r"\lambda", "λ"),
    (r"\Gamma", "Γ"),
    (r"\gamma", "γ"),
    (r"\Delta", "Δ"),
    (r"\delta", "δ"),
    (r"\Theta", "Θ"),
    (r"\Lambda", "Λ"),
    (r"\Omega", "Ω"),
    (r"\omega", "ω"),
    (r"\Pi", "Π"),
    (r"\pi", "π"),
    (r"\Sigma", "Σ"),
    (r"\zeta", "ζ"),
    (r"\eta", "η"),
    (r"\kappa", "κ"),
    (r"\mu", "μ"),
    (r"\nu", "ν"),
    (r"\tau", "τ"),
    (r"\chi", "χ"),
    (r"\psi", "ψ"),
)


class ContractError(ValueError):
    """Raised when a receipt/spec/document would violate a hard contract."""


def _has_ambiguous_fraction_power(latex: str) -> bool:
    def group_end(start: int) -> int | None:
        if start >= len(latex) or latex[start] != "{":
            return None
        depth = 0
        for index in range(start, len(latex)):
            depth += latex[index] == "{"
            depth -= latex[index] == "}"
            if depth == 0:
                return index + 1
        return None

    cursor = 0
    while True:
        start = latex.find(r"\frac{", cursor)
        if start < 0:
            return False
        numerator_end = group_end(start + len(r"\frac"))
        denominator_end = group_end(numerator_end) if numerator_end is not None else None
        if denominator_end is not None and re.match(r"\^\{[2-9]\}", latex[denominator_end:]):
            return True
        cursor = start + len(r"\frac")


def validate_math_markup(text: str, *, section_id: str) -> list[str]:
    """Require typed, safe math spans and reject pseudo-math in prose."""
    issues: list[str] = []
    for match in MATH_SPAN_RE.finditer(text):
        kind, latex = match.group(1), match.group(2).strip()
        if (
            not latex
            or "\n" in latex
            or latex.count("{") != latex.count("}")
            or "[[" in latex
            or "]]" in latex
        ):
            issues.append(f"malformed_math:{section_id}")
        if "$" in latex or UNSAFE_LATEX_RE.search(latex):
            issues.append(f"unsafe_latex:{section_id}")
        if _has_ambiguous_fraction_power(latex):
            issues.append(f"ambiguous_fraction_power:{section_id}")
        if kind == "DISPLAY":
            line_start = text.rfind("\n", 0, match.start()) + 1
            line_end = text.find("\n", match.end())
            if line_end < 0:
                line_end = len(text)
            if text[line_start:line_end].strip() != match.group(0):
                issues.append(f"display_math_not_standalone:{section_id}")

    prose = MATH_SPAN_RE.sub("", text)
    if MATH_TAG_RE.search(prose) or ANY_TYPED_TAG_RE.search(prose):
        issues.append(f"malformed_math:{section_id}")
    if RAW_LATEX_RE.search(prose):
        issues.append(f"raw_latex:{section_id}")
    if PLAIN_MATH_RE.search(prose):
        issues.append(f"plaintext_math:{section_id}")
    return sorted(set(issues))


def math_markup_profile(text: str) -> dict[str, int]:
    matches = list(MATH_SPAN_RE.finditer(text))
    inline = sum(match.group(1) == "INLINE" for match in matches)
    display = sum(match.group(1) == "DISPLAY" for match in matches)
    return {"inline": inline, "display": display, "total": inline + display}


def _text(value: Any, field: str, *, minimum: int = 1, maximum: int = 8_000) -> str:
    if not isinstance(value, str):
        raise ContractError(f"{field} must be a string")
    value = value.strip()
    if len(value) < minimum or len(value) > maximum:
        raise ContractError(f"{field} length must be {minimum}..{maximum}")
    if "\x00" in value:
        raise ContractError(f"{field} contains NUL")
    return value


def _list(value: Any, field: str, *, minimum: int = 0, maximum: int = 100) -> list[Any]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ContractError(f"{field} must contain {minimum}..{maximum} items")
    return value


def _infer_mastery(items: list[dict[str, Any]]) -> str:
    positive = sum(item["verdict"] in {"会", "correct", "yes"} for item in items)
    worked = sum(item["evidence_kind"] in {"worked", "scored", "teacher_observation"} for item in items)
    if positive == len(items) and worked >= max(1, len(items) - 1):
        return "strong"
    if positive <= len(items) // 2:
        return "weak"
    return "mixed"


def validate_receipt(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ContractError("receipt must be an object")
    data = deepcopy(raw)
    if data.get("schema_version") != 1:
        raise ContractError("schema_version must be 1")
    data["topic"] = _text(data.get("topic"), "topic", minimum=2, maximum=120)
    data["observable_goal"] = _text(
        data.get("observable_goal"), "observable_goal", minimum=6, maximum=600
    )
    scenario = _text(data.get("scenario"), "scenario", maximum=64)
    if scenario not in SCENARIOS:
        raise ContractError(f"unsupported scenario: {scenario}")
    data["scenario"] = scenario
    target_level = str(data.get("target_level") or "").strip()
    if target_level not in TARGET_LEVELS:
        raise ContractError(f"unsupported target_level: {target_level}")
    data["target_level"] = target_level
    target_level_source = str(data.get("target_level_source") or "").strip()
    if target_level_source not in TARGET_LEVEL_SOURCES:
        raise ContractError(
            "target_level_source must be explicit or inferred; ask the learner's desired depth"
        )
    data["target_level_source"] = target_level_source
    combined_intent = f"{data['observable_goal']} {data['topic']}"
    research_intent = str(data.get("research_intent") or "learning").strip()
    if ORIGINAL_RESEARCH_RE.search(combined_intent):
        research_intent = "original_research"
    elif research_intent == "learning" and RESEARCH_READY_RE.search(combined_intent):
        research_intent = "research_readiness"
    if research_intent not in RESEARCH_INTENTS:
        raise ContractError(f"unsupported research_intent: {research_intent}")
    if research_intent == "original_research":
        raise ContractError(
            "research_transition_required: ask the user to explicitly say "
            "我要进入研究 / 开始研究 / 进入原创研究"
        )
    data["research_intent"] = research_intent
    if data.get("evidence_level") != "observed":
        raise ContractError("evidence_level must be observed before handbook generation")

    diagnostics = _list(data.get("diagnostic_items"), "diagnostic_items", minimum=2, maximum=4)
    normalized_diagnostics: list[dict[str, Any]] = []
    question_ids: set[str] = set()
    for index, raw_item in enumerate(diagnostics, 1):
        if not isinstance(raw_item, dict):
            raise ContractError(f"diagnostic_items[{index}] must be an object")
        item = deepcopy(raw_item)
        item["question_id"] = _text(item.get("question_id"), f"diagnostic_items[{index}].question_id", maximum=80)
        if item["question_id"] in question_ids:
            raise ContractError(f"duplicate diagnostic question_id: {item['question_id']}")
        question_ids.add(item["question_id"])
        item["concept_id"] = _text(item.get("concept_id"), f"diagnostic_items[{index}].concept_id", maximum=180)
        item["question"] = _text(item.get("question"), f"diagnostic_items[{index}].question", minimum=4, maximum=1_500)
        item["answer"] = _text(item.get("answer"), f"diagnostic_items[{index}].answer", minimum=1, maximum=4_000)
        item["verdict"] = _text(item.get("verdict"), f"diagnostic_items[{index}].verdict", maximum=32)
        if item["verdict"] not in VERDICTS:
            raise ContractError(f"unsupported verdict: {item['verdict']}")
        item["evidence_kind"] = _text(
            item.get("evidence_kind"), f"diagnostic_items[{index}].evidence_kind", maximum=64
        )
        if item["evidence_kind"] not in EVIDENCE_KINDS:
            raise ContractError(f"unsupported evidence_kind: {item['evidence_kind']}")
        normalized_diagnostics.append(item)
    data["diagnostic_items"] = normalized_diagnostics
    data["mastery_summary"] = _infer_mastery(normalized_diagnostics)

    frontier = _list(data.get("knowledge_frontier"), "knowledge_frontier", minimum=1, maximum=30)
    normalized_frontier: list[dict[str, Any]] = []
    for index, raw_node in enumerate(frontier, 1):
        if not isinstance(raw_node, dict):
            raise ContractError(f"knowledge_frontier[{index}] must be an object")
        node = deepcopy(raw_node)
        node["concept_id"] = _text(node.get("concept_id"), f"knowledge_frontier[{index}].concept_id", maximum=180)
        node["label"] = _text(node.get("label") or node.get("concept"), f"knowledge_frontier[{index}].label", maximum=160)
        node["status"] = str(node.get("status") or "candidate").strip()
        if node["status"] not in {"blocked", "in_progress", "candidate", "demonstrated", "unobserved"}:
            raise ContractError(f"unsupported frontier status: {node['status']}")
        blocked_by = node.get("blocked_by") or []
        if not isinstance(blocked_by, list):
            raise ContractError(f"knowledge_frontier[{index}].blocked_by must be an array")
        node["blocked_by"] = [str(value).strip() for value in blocked_by if str(value).strip()]
        normalized_frontier.append(node)
    data["knowledge_frontier"] = normalized_frontier

    weak_points = data.get("weak_points") or []
    data["weak_points"] = [
        _text(value, "weak_points[]", maximum=240) for value in _list(weak_points, "weak_points", maximum=12)
    ]

    learning_path = _list(data.get("learning_path"), "learning_path", minimum=4, maximum=6)
    normalized_path: list[dict[str, Any]] = []
    for index, raw_stage in enumerate(learning_path, 1):
        if not isinstance(raw_stage, dict):
            raise ContractError(f"learning_path[{index}] must be an object")
        stage = deepcopy(raw_stage)
        for field, minimum in (("stage", 2), ("objective", 6), ("completion_evidence", 6)):
            stage[field] = _text(stage.get(field), f"learning_path[{index}].{field}", minimum=minimum, maximum=600)
        stage["concepts"] = [
            _text(value, f"learning_path[{index}].concepts[]", maximum=160)
            for value in _list(stage.get("concepts"), f"learning_path[{index}].concepts", minimum=1, maximum=8)
        ]
        links = [
            _text(value, f"learning_path[{index}].evidence_links[]", maximum=80)
            for value in _list(stage.get("evidence_links"), f"learning_path[{index}].evidence_links", minimum=1, maximum=4)
        ]
        unknown = sorted(set(links) - question_ids)
        if unknown:
            raise ContractError(f"learning_path[{index}] references unknown diagnostic ids: {unknown}")
        stage["evidence_links"] = links
        normalized_path.append(stage)
    data["learning_path"] = normalized_path

    resources = _list(data.get("resources"), "resources", minimum=1, maximum=24)
    normalized_resources: list[dict[str, Any]] = []
    for index, raw_resource in enumerate(resources, 1):
        if not isinstance(raw_resource, dict):
            raise ContractError(f"resources[{index}] must be an object")
        resource = deepcopy(raw_resource)
        resource["title"] = _text(resource.get("title"), f"resources[{index}].title", maximum=300)
        resource["url"] = _text(resource.get("url"), f"resources[{index}].url", maximum=2_000)
        if not resource["url"].startswith(("https://", "http://")):
            raise ContractError(f"resources[{index}].url must be http(s)")
        resource["origin"] = _text(resource.get("origin"), f"resources[{index}].origin", maximum=64)
        if resource["origin"] not in ORIGINS:
            raise ContractError(f"unsupported resource origin: {resource['origin']}")
        resource["source_tier"] = _text(
            resource.get("source_tier") or "other", f"resources[{index}].source_tier", maximum=80
        )
        resource["concept_id"] = _text(
            resource.get("concept_id") or normalized_frontier[0]["concept_id"],
            f"resources[{index}].concept_id",
            maximum=180,
        )
        normalized_resources.append(resource)
    data["resources"] = normalized_resources
    if data.get("deadline") is not None:
        data["deadline"] = _text(str(data["deadline"]), "deadline", maximum=160)
    return data


def choose_profile(receipt: dict[str, Any]) -> str:
    if receipt["research_intent"] == "research_readiness" or receipt["target_level"] == "research_readiness":
        return "research_readiness"
    if receipt["target_level"] in {"graduate", "advanced"}:
        return "advanced_theory"
    if receipt["scenario"] == "exam_prep" and receipt["mastery_summary"] == "strong":
        return "exam_compact"
    return "concept_systematic"


def _section(
    section_id: str,
    title: str,
    purpose: str,
    markers: list[str],
    min_chars: int,
    max_tokens: int,
    *,
    expected_exercise_count: int = 0,
) -> dict[str, Any]:
    return {
        "id": section_id,
        "title": title,
        "purpose": purpose,
        "required_markers": [*markers, END_MARKER],
        "min_chars": min_chars,
        "max_tokens": max_tokens,
        # Five bounded generation attempts (initial + four local repairs) keep
        # transient model-format mistakes inside the affected section instead
        # of failing the whole document and relying on an outer job replay.
        "retry_limit": 4,
        "expected_exercise_count": expected_exercise_count,
    }


def build_spec(raw_receipt: dict[str, Any]) -> dict[str, Any]:
    receipt = validate_receipt(raw_receipt)
    profile = choose_profile(receipt)
    sections = [
        _section(
            "orientation",
            "全局心智模型与完成标准",
            "把主题、诊断和可观察目标组织成一个可操作的全局模型",
            ["【总览】", "【与诊断的关系】", "【完成标准】"],
            650,
            1500,
        ),
        _section(
            "concept-foundations",
            "核心概念：定义、边界与反例",
            "解释前沿概念并修复诊断暴露的薄弱点",
            ["【动机】", "【精确定义】", "【边界与易混】", "【正例】", "【反例】"],
            1200 if profile != "exam_compact" else 800,
            3200,
        ),
        _section(
            "worked-examples",
            "逐步例题与方法迁移",
            "给出至少两个与薄弱点直接对应的完整例题",
            ["【例题1】", "【解答1】", "【例题2】", "【解答2】", "【迁移说明】"],
            1100 if profile != "exam_compact" else 800,
            3200,
        ),
        _section(
            "graded-practice",
            "分层练习、提示与完整解答",
            "提供由基础到迁移的练习并逐题配对提示和完整解答",
            ["【练习1】", "【提示1】", "【解答1】", "【练习2】", "【提示2】", "【解答2】"],
            1500 if profile != "exam_compact" else 1000,
            4200,
            expected_exercise_count=4,
        ),
        _section(
            "misconception-repair",
            "常见误区、修复与复测",
            "把误区写成可诊断、可修复、可复测的学习动作",
            ["【误区1】", "【修复】", "【复测】"],
            650,
            1400,
        ),
    ]
    if profile in {"concept_systematic", "advanced_theory", "research_readiness"} and len(receipt["weak_points"]) >= 2:
        sections.insert(
            2,
            _section(
                "dependency-repair",
                "前置依赖修复",
                "逐项补齐多个薄弱点并说明它们如何支撑目标",
                ["【缺口1】", "【为什么会阻塞】", "【修复步骤】", "【验证任务】"],
                850,
                1800,
            ),
        )
    if profile in {"advanced_theory", "research_readiness"}:
        sections.insert(
            -2,
            _section(
                "theorem-proof-map",
                "定理关系与证明技术",
                "说明定理依赖、成立条件、证明策略及不能推出的结论",
                ["【定理关系】", "【成立条件】", "【证明思路】", "【不能推出什么】"],
                1200,
                2500,
            ),
        )
        sections.insert(
            -2,
            _section(
                "canonical-constructions",
                "典型构造与高阶迁移",
                "通过典型构造把定义、定理和计算连接起来",
                ["【构造1】", "【逐步分析】", "【结构意义】", "【迁移任务】"],
                950,
                2100,
            ),
        )
    if profile == "research_readiness":
        sections.insert(
            -1,
            _section(
                "reading-readiness",
                "论文阅读准备路线",
                "给出阅读目标、缺口、定理地图、证明技术和研究边界",
                ["【阅读目标】", "【前置缺口】", "【定理地图】", "【证明技术】", "【研究边界】"],
                1200,
                2500,
            ),
        )
    minimum_chars = {
        "exam_compact": 3_800,
        "concept_systematic": 6_000,
        "advanced_theory": 8_500,
        "research_readiness": 10_000,
    }[profile]
    return {
        "schema_version": 1,
        "profile": profile,
        "provider": "zai",
        "model": "glm-5.2",
        "topic": receipt["topic"],
        "observable_goal": receipt["observable_goal"],
        "minimum_generated_chars": minimum_chars,
        "sections": sections,
        "receipt": receipt,
    }


def validate_section(section: dict[str, Any], text: str, *, profile: str) -> list[str]:
    issues: list[str] = []
    if not isinstance(text, str) or len(text.strip()) < int(section["min_chars"]):
        issues.append(f"section_too_short:{section['id']}")
        return issues
    marker_positions: list[int] = []
    for marker in section["required_markers"]:
        if marker not in text:
            issues.append(f"missing_marker:{section['id']}:{marker}")
        else:
            marker_positions.append(text.index(marker))
        if text.count(marker) > 1:
            issues.append(f"duplicate_marker:{section['id']}:{marker}")
    if len(marker_positions) == len(section["required_markers"]) and marker_positions != sorted(marker_positions):
        issues.append(f"marker_order:{section['id']}")
    if not text.rstrip().endswith(END_MARKER):
        issues.append(f"incomplete_ending:{section['id']}")
    for index, marker in enumerate(section["required_markers"][:-1]):
        start = text.find(marker)
        next_marker = section["required_markers"][index + 1]
        end = text.find(next_marker, start + len(marker)) if start >= 0 else -1
        if start >= 0 and end >= 0:
            segment = text[start + len(marker) : end].strip()
            if "解答" in marker:
                minimum = 120
            elif "例题" in marker or "练习" in marker:
                minimum = 24
            elif "提示" in marker:
                minimum = 30
            else:
                minimum = 60
            if len(segment) < minimum:
                issues.append(f"marker_content_too_short:{section['id']}:{marker}")
    issues.extend(validate_math_markup(text, section_id=section["id"]))
    if URL_RE.search(text):
        issues.append(f"invented_inline_url:{section['id']}")
    if profile != "exam_compact" and re.search(r"高中|高考", text):
        issues.append(f"high_school_drift:{section['id']}")
    if OUTLINE_ONLY_RE.fullmatch(text.strip()):
        issues.append(f"outline_only:{section['id']}")
    if MARKDOWN_NOISE_RE.search(text):
        issues.append(f"markdown_noise:{section['id']}")
    if SELF_CORRECTION_RE.search(text):
        issues.append(f"self_correcting_contradiction:{section['id']}")
    if section["id"] == "graded-practice":
        exercises = set(re.findall(r"【练习(\d+)】", text))
        hints = set(re.findall(r"【提示(\d+)】", text))
        answers = set(re.findall(r"【解答(\d+)】", text))
        expected_count = int(section.get("expected_exercise_count") or 0)
        expected = {str(index) for index in range(1, expected_count + 1)}
        if exercises != expected or hints != expected or answers != expected:
            issues.append("unpaired_exercises")
    elif section["id"] in {
        "orientation",
        "concept-foundations",
        "dependency-repair",
        "theorem-proof-map",
        "reading-readiness",
    } and re.search(r"【练习\d+】|^\s*练习(?:\d+)?[：:]", text, re.M):
        issues.append(f"unexpected_practice_block:{section['id']}")
    return issues


def _canonicalize_topic_symbols(value: str) -> str:
    """Map native and LaTeX spellings of title-level symbols to one form."""
    canonical = unicodedata.normalize("NFKC", value).replace("ϕ", "φ")
    for latex, symbol in TOPIC_SYMBOL_ALIASES:
        canonical = canonical.replace(latex, symbol)
    return canonical


def _normalized_topic_anchor(value: str) -> str:
    """Normalize harmless presentation differences without erasing semantics."""
    canonical = _canonicalize_topic_symbols(MATH_TAG_RE.sub("", value))
    # English titles frequently vary only by possessive spelling, for example
    # ``Euler's totient function`` versus ``Euler totient function``.
    canonical = re.sub(r"(?i)(?<=[a-z])['’ʼ]s(?=[^a-z]|$)", "", canonical)
    return re.sub(
        r"[\s'’ʼ`´\-‐‑–—_/·，,；;：:。.（）()\[\]{}]+",
        "",
        canonical,
    ).casefold()


def _topic_anchor_groups(topic: str) -> list[tuple[str, ...]]:
    """Return alternative anchor groups; every member of one group must match.

    Parenthetical labels are alternative surface forms, while a composite title
    such as ``诺特环与准素分解`` denotes two required concepts.  Representing
    both cases explicitly prevents a literal-title false negative without
    weakening the topic-drift gate to a one-word substring check.
    """
    core_topic = TOPIC_SUFFIX_RE.sub("", topic).strip()
    variants = [value for value in (topic, core_topic) if len(value.strip()) >= 2]
    groups: list[tuple[str, ...]] = []

    def add_group(values: list[str] | tuple[str, ...]) -> None:
        normalized = tuple(
            anchor
            for anchor in (_normalized_topic_anchor(value) for value in values)
            if len(anchor) >= 2 or re.fullmatch(r"[α-ωΑ-Ω]", anchor)
        )
        if normalized and normalized not in groups:
            groups.append(normalized)

    for value in variants:
        add_group([value])

        # Symbol-named functions are routinely written with the symbol in a
        # native formula node rather than inside the Chinese prose name.  For
        # ``欧拉φ函数`` require both the conventional prose name ``欧拉函数``
        # and the canonical symbol ``φ`` somewhere in the generated document.
        # Requiring both keeps ``欧拉定理`` or a stray ``φ`` from satisfying
        # the topic gate on its own.
        symbolic_value = _canonicalize_topic_symbols(value)
        for name, symbol, noun in TOPIC_SYMBOLIC_NOUN_RE.findall(symbolic_value):
            add_group([f"{name.strip()}{noun}", symbol])

        # A bilingual or synonym label in parentheses may legitimately use
        # either surface form throughout the document.
        for outer, inner in re.findall(
            r"([^（）()]{2,})[（(]([^（）()]{2,})[）)]", value
        ):
            add_group([outer])
            add_group([inner])

        # A compound learning topic is conjunctive: all meaningful components
        # must occur, though they need not be adjacent in generated prose.
        components = [
            component.strip()
            for component in TOPIC_COMPOSITE_SEPARATOR_RE.split(value)
            if len(component.strip()) >= 2
        ]
        if len(components) >= 2:
            add_group(components)

    return groups


def validate_generated_document(spec: dict[str, Any], generated: dict[str, str], response_ids: dict[str, str]) -> list[str]:
    issues: list[str] = []
    if spec.get("profile") not in PROFILES:
        return ["invalid_profile"]
    for section in spec["sections"]:
        section_id = section["id"]
        text = generated.get(section_id, "")
        issues.extend(validate_section(section, text, profile=spec["profile"]))
        if text and not response_ids.get(section_id):
            issues.append(f"missing_response_id:{section_id}")
    combined = "\n".join(generated.values())
    if len(combined) < int(spec["minimum_generated_chars"]):
        issues.append("document_below_semantic_floor")
    topic = str(spec["topic"])
    normalized_document = _normalized_topic_anchor(combined)
    anchor_groups = _topic_anchor_groups(topic)
    if not any(
        all(anchor in normalized_document for anchor in group)
        for group in anchor_groups
    ):
        issues.append("topic_not_anchored")
    return sorted(set(issues))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()
    receipt_path = Path(args.receipt).expanduser().resolve()
    spec = build_spec(json.loads(receipt_path.read_text(encoding="utf-8")))
    encoded = json.dumps(spec, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        Path(args.out).expanduser().resolve().write_text(encoded, encoding="utf-8")
    else:
        print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
