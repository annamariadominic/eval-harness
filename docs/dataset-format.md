# Dataset import format

Test cases are imported as JSON through **Suite → Dataset → Import JSON** (or
`POST /api/suites/{suite_id}/test-cases/import`). Imports are all-or-nothing: every case is
validated first and nothing is written unless all of them pass.

## Accepted file shapes

```jsonc
// 1. An object with a "cases" array (recommended)
{ "cases": [ { "input": "..." }, { "input": "..." } ] }

// 2. A bare array
[ { "input": "..." }, { "input": "..." } ]
```

```text
// 3. JSON Lines: one case object per line (.jsonl)
{"input": "..."}
{"input": "..."}
```

## Case fields

| Field      | Type                     | Required | Notes |
|------------|--------------------------|----------|-------|
| `input`    | string or any JSON value | yes      | Passed to the variant's prompt template. Object fields are available as `{{ field }}`; `{{ input }}` renders the whole input. Must not be empty. |
| `expected` | string or any JSON value | no       | Reference output for evaluators that need one (exact match, field match, contains with `expected_path`, LLM judges with `include_expected`). |
| `key`      | string (≤ 200 chars)     | no       | Human-readable identifier. Must be unique within the suite and within the file. |
| `tags`     | array of strings         | no       | Used for sliced analysis. Tags are trimmed, lower-cased, spaces become hyphens, duplicates are removed. |
| `metadata` | object                   | no       | Stored with the case and snapshotted into runs; not used for scoring. |

Any other field is rejected (for example a typo such as `"expect"`), so mistakes surface at
import time instead of silently producing unscored cases.

## Example

```json
{
  "cases": [
    {
      "key": "acme-revenue-2025",
      "input": {
        "question": "What was Acme Corp's 2025 revenue?",
        "context": "Acme Corp reported fiscal 2025 revenue of $4.2B."
      },
      "expected": { "answer": "$4.2 billion" },
      "tags": ["financial", "easy"]
    }
  ]
}
```

A complete importable file lives at [`examples/support-answers.json`](examples/support-answers.json).

## Import modes and validation

* `mode: "append"` (default) adds cases; keys must not collide with existing ones.
* `mode: "replace"` deletes the suite's current cases first. Past runs are unaffected because
  every run keeps its own snapshot of the cases it executed.
* `dry_run: true` validates and returns a preview (first 50 normalised cases plus tag counts)
  without saving. The UI always previews before importing.

Validation errors are reported per case and field, all at once:

```json
{
  "valid": false,
  "errors": [
    { "index": 1, "field": "key", "message": "Duplicate key 'a' (first used by case 0)" },
    { "index": 3, "field": "expect", "message": "Unknown field 'expect'. Allowed: expected, input, key, metadata, tags" }
  ]
}
```
