"""Reading structured data out of model outputs and test-case fields."""

import json
import re
from typing import Any

_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*\n?(.*?)```", re.DOTALL)
_PATH_TOKEN_RE = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


class JsonParseError(ValueError):
    pass


class PathNotFoundError(KeyError):
    pass


def parse_json_output(text: str, *, allow_code_fence: bool = False) -> Any:
    """Parse model output as JSON. Optionally unwraps a markdown code fence first."""
    candidate = text.strip()
    if allow_code_fence:
        fenced = _FENCE_RE.search(candidate)
        if fenced:
            candidate = fenced.group(1).strip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise JsonParseError(
            f"Output is not valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno})"
        ) from exc


def resolve_path(value: Any, path: str) -> Any:
    """Resolve a dotted path with optional list indices, e.g. ``items[0].name``."""
    current = value
    for match in _PATH_TOKEN_RE.finditer(path):
        key, index = match.groups()
        if key is not None:
            if not isinstance(current, dict) or key not in current:
                raise PathNotFoundError(path)
            current = current[key]
        else:
            position = int(index)
            if not isinstance(current, list) or position >= len(current):
                raise PathNotFoundError(path)
            current = current[position]
    return current


def to_text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
