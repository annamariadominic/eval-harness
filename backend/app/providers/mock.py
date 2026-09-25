"""Deterministic offline provider for local development, demos, and tests.

The mock never calls the network. It produces plausible, *deterministic* outputs by reading the
prompt it receives, so the full pipeline (generation -> evaluators -> comparison) can be exercised
without API credits. Behaviour is a pure function of (model, messages, settings), which is what
makes runs reproducible and tests stable.

It recognises three kinds of request:

* **Judge requests** (``schema_name == "judgement"``): scores a ``<response>`` against a
  ``<reference>`` (key-fact recall) or against the ``<input>`` (grounding precision), depending on
  whether the ``<criteria>`` talk about faithfulness.
* **Extraction requests** (JSON requested by the system prompt or a response schema): pulls a
  company name, revenue, and fiscal year out of messy text.
* **Question answering** (everything else): picks the most relevant numbered passage
  (``[1] ...``) and answers from it.

Model names set a "skill" level. Lower skill means the model is sometimes distracted by the
wrong passage or figure. Prompt wording matters too — asking for citations adds them, asking to
use *only* the context suppresses unsupported embellishments, asking for raw JSON removes
markdown fences — so prompt changes produce real, explainable score differences.

Settings understood via ``ModelConfig.settings``:

* ``mock_failure_rate`` (0-1): probability that an attempt fails with a transient 503.
* ``mock_latency_scale`` (>=0): multiplier on simulated latency (0 disables sleeping).
"""

import asyncio
import hashlib
import json
import re
from collections import Counter
from typing import Any

from app.providers.types import GenerationResult, Message, ModelConfig, ProviderError

MODEL_SKILL: dict[str, float] = {"mock-small": 0.7, "mock-large": 0.9}
BASE_LATENCY_MS: dict[str, float] = {"mock-small": 180.0, "mock-large": 420.0}
DEFAULT_SKILL = 0.8
DEFAULT_LATENCY_MS = 250.0

STOPWORDS = frozenset(
    """a an the of in on at to for from by with and or but is are was were be been being it its
    this that these those as what which who whom how when where why did does do has have had
    their there they them than then so such not no into over under about per via our your you
    i we he she his her will would can could should may might also based provided context
    according answer question passage""".split()
)

EMBELLISHMENTS = (
    "This is broadly in line with wider industry expectations.",
    "Analysts generally view this as a strong signal for the coming year.",
    "The figure is likely to keep growing as the market matures.",
)

MONEY_RE = re.compile(
    r"(?:\$|USD\s?)\s?(\d[\d,]*(?:\.\d+)?)\s*(billion|bn|b|million|mn|m|thousand|k)?\b",
    re.IGNORECASE,
)
COMPANY_RE = re.compile(
    r"\b([A-Z][\w&'-]*(?:[ \t]+[A-Z][\w&'-]*){0,3}[ \t]+"
    r"(?:Inc|Corp|Corporation|Ltd|LLC|Group|Holdings|Industries|Labs|Systems|Technologies|GmbH|PLC))\b\.?"
)
YEAR_RE = re.compile(r"\b(?:fiscal(?:\s+year)?|FY)\s*'?(\d{4}|\d{2})\b", re.IGNORECASE)
PLAIN_YEAR_RE = re.compile(r"\b(20\d{2})\b")
REVENUE_WORDS = re.compile(r"revenue|sales|turnover|top ?-?line", re.IGNORECASE)
CLAUSE_BREAK_RE = re.compile(r"[;()\n]|\.\s")
MULTIPLIERS = {
    "billion": 1e9, "bn": 1e9, "b": 1e9,
    "million": 1e6, "mn": 1e6, "m": 1e6,
    "thousand": 1e3, "k": 1e3,
}  # fmt: skip


class MockProvider:
    name = "mock"

    def __init__(self, *, latency_scale: float = 1.0) -> None:
        self.latency_scale = latency_scale
        # Attempt counters per request fingerprint let simulated transient failures clear up on
        # retry, exactly like a real flaky upstream would.
        self._attempts: Counter[str] = Counter()

    async def generate(self, messages: list[Message], config: ModelConfig) -> GenerationResult:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        user = "\n\n".join(m.content for m in messages if m.role != "system")
        fingerprint = _digest(config.model, config.schema_name, system, user)
        self._attempts[fingerprint] += 1
        attempt = self._attempts[fingerprint]

        scale = float(config.settings.get("mock_latency_scale", self.latency_scale))
        failure_rate = float(config.settings.get("mock_failure_rate", 0.0))
        if failure_rate > 0 and _roll(fingerprint, str(attempt)) < failure_rate:
            await asyncio.sleep(0.05 * scale)
            raise ProviderError(
                "Simulated transient upstream error (503 Service Unavailable)",
                kind="server_error",
                status_code=503,
            )

        if config.schema_name == "judgement":
            output = _judge(user)
        elif config.response_schema is not None or "json" in system.lower():
            output = _extract(system, user, config)
        else:
            output = _answer(system, user, config.model)

        input_tokens = _estimate_tokens(system + user)
        output_tokens = _estimate_tokens(output)
        latency_ms = round(
            BASE_LATENCY_MS.get(config.model, DEFAULT_LATENCY_MS)
            + 0.8 * output_tokens
            + 150 * _roll(fingerprint, "latency"),
            1,
        )
        if scale > 0:
            await asyncio.sleep(latency_ms * scale / 1000)
        return GenerationResult(
            output=output,
            latency_ms=latency_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=config.model,
            provider=self.name,
            finish_reason="stop",
        )


# --- question answering -------------------------------------------------------------------


def _answer(system: str, user: str, model: str) -> str:
    instructions = system.lower()
    question_match = re.search(r"question:\s*(.+)", user, re.IGNORECASE)
    question = question_match.group(1).strip() if question_match else user.strip().split("\n")[0]
    passages = _passages(user)
    if not passages:
        return "I could not find any context to answer from."

    q_terms = set(_content_terms(question))
    ranked = sorted(passages, key=lambda p: (-len(q_terms & set(_content_terms(p[1]))), int(p[0])))
    skill = MODEL_SKILL.get(model, DEFAULT_SKILL)
    distracted = len(ranked) > 1 and _roll(model, system, question) > skill
    number, text = ranked[1] if distracted else ranked[0]
    sentence = max(
        _sentences(text), key=lambda s: len(q_terms & set(_content_terms(s))), default=text
    ).rstrip(".")

    concise = "concise" in instructions or "one sentence" in instructions
    grounded = "only" in instructions and "context" in instructions
    answer = sentence if concise else f"According to the provided context, {sentence}"
    if "cite" in instructions or "citation" in instructions:
        answer += f" [{number}]"
    answer += "."
    if not grounded and _roll(model, question, "embellish") < 0.55:
        answer += " " + EMBELLISHMENTS[int(_roll(question, "which") * len(EMBELLISHMENTS))]
    return answer


def _passages(text: str) -> list[tuple[str, str]]:
    found = re.findall(r"\[(\d+)\]\s*(.+?)(?=\s*\[\d+\]|\Z)", text, re.DOTALL)
    return [(n, " ".join(body.split())) for n, body in found if body.strip()]


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


# --- structured extraction ----------------------------------------------------------------


def _extract(system: str, user: str, config: ModelConfig) -> str:
    instructions = system.lower()
    skill = MODEL_SKILL.get(config.model, DEFAULT_SKILL)
    distracted = _roll(config.model, system, user[:400]) > skill
    structured = config.response_schema is not None

    record: dict[str, Any] = {}
    company = COMPANY_RE.search(user)
    if company:
        record["company"] = company.group(1).strip()

    revenue = _find_revenue(user, distracted=distracted)
    if revenue is not None:
        amount, raw = revenue
        wants_number = structured or any(
            phrase in instructions for phrase in ("integer", "full number", "whole number")
        )
        unit_slip = not wants_number and _roll(config.model, user, "units") > skill - 0.1
        record["revenue"] = raw if unit_slip else amount

    year = _find_year(user)
    if year is not None:
        record["year"] = year

    body = json.dumps(record)
    raw_only = any(
        phrase in instructions
        for phrase in ("only json", "only the json", "raw json", "no prose", "no markdown")
    )
    if not structured and not raw_only and _roll(config.model, user, "fence") < 0.5:
        return f"Here is the extracted data:\n```json\n{json.dumps(record, indent=2)}\n```"
    return body


def _find_revenue(text: str, *, distracted: bool) -> tuple[int, str] | None:
    """Prefer an amount in the same clause as a revenue keyword; a distracted model just takes
    the first amount it sees."""
    matches = list(MONEY_RE.finditer(text))
    if not matches:
        return None
    chosen = matches[0]
    if not distracted:
        bounds = [0, *(m.end() for m in CLAUSE_BREAK_RE.finditer(text)), len(text)]
        for keyword in REVENUE_WORDS.finditer(text):
            lo = max(b for b in bounds if b <= keyword.start())
            hi = min(b for b in bounds if b > keyword.start())
            in_clause = [m for m in matches if lo <= m.start() < hi]
            if in_clause:
                after = [m for m in in_clause if m.start() >= keyword.start()]
                chosen = (after or in_clause)[0]
                break
    number = float(chosen.group(1).replace(",", ""))
    unit = (chosen.group(2) or "").lower()
    return round(number * MULTIPLIERS.get(unit, 1)), chosen.group(0).strip()


def _find_year(text: str) -> int | None:
    fiscal = YEAR_RE.search(text)
    if fiscal:
        value = fiscal.group(1)
        return int(value) if len(value) == 4 else 2000 + int(value)
    plain = PLAIN_YEAR_RE.search(text)
    return int(plain.group(1)) if plain else None


# --- judging ------------------------------------------------------------------------------


def _judge(prompt: str) -> str:
    response = _section(prompt, "response")
    reference = _section(prompt, "reference")
    source = _section(prompt, "input")
    criteria = _section(prompt, "criteria").lower()
    low, high = 0.0, 1.0
    range_match = re.search(r"score from (-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?)", prompt)
    if range_match:
        low, high = float(range_match.group(1)), float(range_match.group(2))

    grounding = any(
        word in criteria for word in ("faithful", "grounded", "supported", "hallucinat")
    )
    response_terms = _content_terms(response)
    if grounding or not reference:
        allowed = set(_content_terms(source))
        terms = list(dict.fromkeys(response_terms))
        unsupported = [t for t in terms if t not in allowed]
        fraction = 1.0 if not terms else 1 - len(unsupported) / len(terms)
        if not unsupported:
            reason = "Every claim in the response is supported by the provided input."
        else:
            examples = ", ".join(f"'{t}'" for t in unsupported[:4])
            reason = (
                f"{len(unsupported)} of {len(terms)} content terms are not supported by the "
                f"input (e.g. {examples}), indicating claims beyond the source material."
            )
    else:
        key_terms = list(dict.fromkeys(_content_terms(reference)))
        present = set(response_terms)
        missing = [t for t in key_terms if t not in present]
        fraction = 1.0 if not key_terms else 1 - len(missing) / len(key_terms)
        if not missing:
            reason = "The response contains every key fact from the reference answer."
        else:
            reason = (
                f"The response covers {len(key_terms) - len(missing)} of {len(key_terms)} key "
                f"facts from the reference; missing: {', '.join(repr(t) for t in missing[:4])}."
            )

    score = low + fraction * (high - low)
    if high - low >= 2:
        score = round(score)
    return json.dumps({"reason": reason, "score": round(score, 3)})


def _section(text: str, tag: str) -> str:
    match = re.search(rf"<{tag}>\s*(.*?)\s*</{tag}>", text, re.DOTALL)
    return match.group(1) if match else ""


# --- shared helpers -----------------------------------------------------------------------


def _content_terms(text: str) -> list[str]:
    terms: list[str] = []
    for raw in re.findall(r"[A-Za-z0-9$][A-Za-z0-9.,$%'-]*", text):
        token = raw.lower().strip(".,'").lstrip("$").replace(",", "")
        number_with_unit = re.fullmatch(r"(\d+(?:\.\d+)?)(bn|b|m|k)", token)
        if number_with_unit:
            unit = {"bn": "billion", "b": "billion", "m": "million", "k": "thousand"}
            terms.extend([number_with_unit.group(1), unit[number_with_unit.group(2)]])
            continue
        if token and token not in STOPWORDS and not re.fullmatch(r"\[?\d\]?", token):
            terms.append(_stem(token))
    return terms


def _stem(token: str) -> str:
    """Crude suffix stripping so "opened"/"open" and "vessels"/"vessel" line up."""
    if token.isalpha() and len(token) > 4:
        for suffix in ("ing", "ed", "es", "s"):
            if token.endswith(suffix) and len(token) - len(suffix) >= 3:
                return token[: -len(suffix)]
    return token


def _estimate_tokens(text: str) -> int:
    return max(1, round(len(text) / 4))


def _digest(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()


def _roll(*parts: str) -> float:
    """Deterministic pseudo-random number in [0, 1) derived from the inputs."""
    return int(_digest(*parts)[:8], 16) / 0x1_0000_0000
