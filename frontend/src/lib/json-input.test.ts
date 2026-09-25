import { describe, expect, it } from "vitest";

import { parseDatasetText } from "./dataset-import";
import { parseJsonObject, parseLooseValue, parseTagList } from "./json-input";

describe("parseLooseValue", () => {
  it("parses JSON-looking text and keeps prose as a string", () => {
    expect(parseLooseValue('{"answer": "$4.2 billion"}')).toEqual({
      ok: true,
      value: { answer: "$4.2 billion" },
    });
    expect(parseLooseValue("What was revenue?")).toEqual({ ok: true, value: "What was revenue?" });
    expect(parseLooseValue("42")).toEqual({ ok: true, value: 42 });
    expect(parseLooseValue("42 widgets")).toEqual({ ok: true, value: "42 widgets" });
    expect(parseLooseValue("  ")).toEqual({ ok: true, value: null });
  });

  it("reports broken JSON instead of silently storing a string", () => {
    const result = parseLooseValue('{"a": 1,}');
    expect(result.ok).toBe(false);
  });
});

describe("parseJsonObject", () => {
  it("requires an object", () => {
    expect(parseJsonObject("")).toEqual({ ok: true, value: {} });
    expect(parseJsonObject("[1]").ok).toBe(false);
    expect(parseJsonObject('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("parseTagList", () => {
  it("splits on commas and newlines", () => {
    expect(parseTagList("easy, financial\nlong-context,,")).toEqual([
      "easy",
      "financial",
      "long-context",
    ]);
  });
});

describe("parseDatasetText", () => {
  it("accepts an object with a cases array or a bare array", () => {
    expect(parseDatasetText('{"cases": [{"input": "a"}]}')).toEqual({
      ok: true,
      cases: [{ input: "a" }],
    });
    expect(parseDatasetText('[{"input": "a"}, {"input": "b"}]')).toMatchObject({ ok: true });
  });

  it("accepts JSON Lines", () => {
    const result = parseDatasetText('{"input": "a"}\n{"input": "b"}\n');
    expect(result).toEqual({ ok: true, cases: [{ input: "a" }, { input: "b" }] });
  });

  it("explains what is wrong", () => {
    expect(parseDatasetText("")).toMatchObject({ ok: false });
    expect(parseDatasetText('{"items": []}')).toMatchObject({
      ok: false,
      error: 'Expected an array of cases or an object with a "cases" array',
    });
    expect(parseDatasetText("[1, 2]")).toMatchObject({
      ok: false,
      error: "Case 0 is not a JSON object",
    });
    expect(parseDatasetText('{"input": "a"}\nnot json')).toMatchObject({
      ok: false,
      error: "Line 2 is not valid JSON",
    });
  });
});
