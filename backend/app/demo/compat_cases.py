"""Golden cases for the Python behaviours the TypeScript port has to reproduce by hand.

JavaScript differs from Python in JSON error messages and formatting, float printing, rounding,
``sum()``, ``repr()``, and a few string operations. Each case records CPython's own answer.
"""

import json
from typing import Any

from app.providers.mock import _digest, _roll

JSON_INPUTS = [
    "",
    " ",
    "x",
    "{",
    "[",
    '{"a"',
    '{"a":',
    '{"a" 1}',
    '{"a": 1',
    '{"a": 1,}',
    '{"a": 1 "b": 2}',
    "[1,]",
    "[1 2]",
    "[1,",
    '"abc',
    '"a\\q"',
    '"a\\u12"',
    '"a\\u12zz"',
    '"a\nb"',
    "{1: 2}",
    "{'a': 1}",
    "[1] 2",
    "tru",
    "nul",
    "-",
    "-x",
    "01",
    "1.",
    "1e",
    ".5",
    '"\\',
    '{"a": [1, {"b": }]}',
    "[\n  1,\n  2\n  3]",
    '{"x": 1}\n\n  y',
    '{"é": "ü\\u00e9", "k": [true, false, null]}',
    '{"a":1,"a":2}',
    '"\\ud83d\\ude00 and \\ud83d alone"',
    '{"a"  :  1  ,  }',
    "[,1]",
    "{,}",
    "  [1, 2.5, -3e2, 0.1]  ",
    '"tab\\there\\/slash\\\\"',
    '{"nested": {"deep": [[], {}, [{"x": "y"}]]}}',
    "12345678901234567890",
    "-0",
]

DUMP_INPUTS = [
    '{"company": "Acme Corp", "revenue": 4200000000, "year": 2025}',
    '{"a": [1, 2.5, "x"], "b": null, "c": {"d": true}}',
    '["é", "☕", "😀", "\\u007f", "\\u0001", "q\\"uote", "back\\\\slash"]',
    "[]",
    "{}",
    '{"empty": [], "obj": {}, "n": -0.0001, "big": 1e+100, "small": 1.5e-07}',
    '"plain"',
]

FLOATS = [
    0.1,
    0.5,
    1.5,
    2.675,
    100.0,
    123456.789,
    1e15,
    1e16,
    1.5e16,
    9999999999999998.0,
    0.0001,
    0.00001,
    1.234e-05,
    5e-324,
    1.7976931348623157e308,
    -2.5,
    -0.0,
    0.30000000000000004,
    270.9,
    1 / 3,
]

ROUNDS = [
    (0.5, None),
    (1.5, None),
    (2.5, None),
    (-0.5, None),
    (-1.5, None),
    (2.4999999999999996, None),
    (1049.9, None),
    (0.125, 2),
    (0.375, 2),
    (2.675, 2),
    (1.0005, 3),
    (0.6666666666666666, 3),
    (230.94999999999999, 1),
    (230.95, 1),
    (4.35, 1),
    (180.0 + 0.8 * 12 + 150 * 0.31, 1),
    (-0.125, 2),
    (1e20 + 0.5, 1),
]

REPRS = [
    "plain",
    "it's",
    'say "hi"',
    "both ' and \"",
    "tab\tnew\nline\rcr",
    "back\\slash",
    "\x00\x1f\x7f\x80\x9f",
    "é ü ☕ 😀",
    "\u200b\u2028\xa0 \u3000",
    "",
]

SUMS = [
    [0.1, 0.2, 0.3],
    [1e16, 1.0, -1e16],
    [0.1] * 10,
    [1 / 3, 2 / 3, 1 / 7, 5 / 7, 0.25],
    [66.66666666666667, 66.66666666666667, 100.0, 56.94444444444444],
    [],
]

STRINGS = [
    "  padded\t\n",
    "\x1c\x1d mixed \x85\u3000",
    "a  b\n\tc",
    "\ufeffbom\ufeff",
    "Straße ÇA ǅ",
]


def compat_cases() -> dict[str, Any]:
    json_cases: list[dict[str, Any]] = []
    for text in JSON_INPUTS:
        try:
            value = json.loads(text)
            json_cases.append({"input": text, "dumped": json.dumps(value)})
        except json.JSONDecodeError as exc:
            json_cases.append(
                {"input": text, "error": {"msg": exc.msg, "lineno": exc.lineno, "colno": exc.colno}}
            )
    dump_cases = []
    for text in DUMP_INPUTS:
        value = json.loads(text)
        dump_cases.append(
            {
                "input": text,
                "default": json.dumps(value),
                "indent2": json.dumps(value, indent=2),
                "unicode_indent2": json.dumps(value, ensure_ascii=False, indent=2),
            }
        )
    return {
        "json": json_cases,
        "dumps": dump_cases,
        "float_repr": [{"value": x, "repr": repr(x)} for x in FLOATS],
        "round": [
            {"value": x, "ndigits": n, "result": round(x) if n is None else round(x, n)}
            for x, n in ROUNDS
        ],
        "repr": [{"value": s, "repr": repr(s)} for s in REPRS],
        "sum": [{"values": v, "result": sum(v)} for v in SUMS],
        "strings": [
            {
                "value": s,
                "strip": s.strip(),
                "split": s.split(),
                "casefold": s.casefold(),
                "lower": s.lower(),
                "len": len(s),
            }
            for s in STRINGS
        ],
        "hash": [
            {"parts": parts, "digest": _digest(*parts), "roll": _roll(*parts)}
            for parts in (
                ["mock-small", "judgement", "sys", "user"],
                ["é", "☕", "😀"],
                [""],
                ["a" * 200, "b" * 57],
            )
        ],
    }
