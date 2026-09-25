"""Prompt templates: ``{{ path }}`` placeholders resolved against a test case input.

Deliberately tiny (no logic, no filters): prompt templates should be readable at a glance and
render identically forever, which matters for reproducing historical runs.

* ``{{ question }}`` — a field of an object input (dotted paths and ``[0]`` indices work)
* ``{{ input }}`` — the whole input (strings as-is, structured values as pretty JSON)
"""

import json
import re
from typing import Any

PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][\w.\[\]]*)\s*\}\}")
_PATH_TOKEN_RE = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


class TemplateError(ValueError):
    pass


def template_variables(template: str) -> list[str]:
    return list(dict.fromkeys(PLACEHOLDER_RE.findall(template)))


def render_template(template: str, value: Any) -> str:
    def substitute(match: re.Match[str]) -> str:
        path = match.group(1)
        resolved = value if path == "input" else _resolve(value, path)
        return resolved if isinstance(resolved, str) else json.dumps(resolved, indent=2)

    return PLACEHOLDER_RE.sub(substitute, template)


def _resolve(value: Any, path: str) -> Any:
    current = value
    for match in _PATH_TOKEN_RE.finditer(path):
        key, index = match.groups()
        if key is not None and isinstance(current, dict) and key in current:
            current = current[key]
        elif index is not None and isinstance(current, list) and int(index) < len(current):
            current = current[int(index)]
        else:
            raise TemplateError(f"Template variable '{{{{ {path} }}}}' is missing from the input")
    return current
