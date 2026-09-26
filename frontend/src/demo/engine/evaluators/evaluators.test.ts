import { describe, expect, it } from "vitest";

import { unitGolden, type Golden } from "../../golden";
import { PricedModelCaller, ProviderRegistry, retryPolicy } from "../calls";
import { MockProvider } from "../mock-provider";
import { PricingTable } from "../pricing";
import snapshot from "../../../../public/demo/snapshot.json";
import { EvaluatorError } from "./base";
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT, type JudgeConfig } from "./judge";
import { EvaluatorRegistry, InvalidEvaluatorConfig } from "./registry";

const golden = unitGolden();
const registry = new EvaluatorRegistry(snapshot.meta.evaluator_types as never);
const noSleep = async () => {};

/**
 * Cases whose Python result depends on a float/int distinction JavaScript does not have: the
 * expected value `{"k": 1.0}` in the judge prompt prints as `1.0` in Python.
 */
function knownDivergence(c: Golden): boolean {
  return JSON.stringify(c.expected) === '{"k":1}';
}

/** Config errors whose wording comes from the regex / JSON Schema engine, not from Pydantic. */
const ENGINE_WORDED = new Set(["regex", "json_schema"]);

describe("evaluator parity", () => {
  const caller = new PricedModelCaller(
    new ProviderRegistry({ mock: new MockProvider(0, noSleep) }),
    PricingTable.fromJson(snapshot.pricing),
    retryPolicy(),
    noSleep,
  ).call;

  const scored = golden.evaluators.filter((c: Golden) => !("config_error" in c));
  it.each<Golden>(scored)("$type on $output", async (c) => {
    if ("normalized" in c) expect(registry.normalizeConfig(c.type, c.config)).toEqual(c.normalized);
    const sample = { input: c.input, expected: c.expected, output: c.output };
    const evaluator = registry.build(c.type, c.config, caller);
    if ("error" in c) {
      await expect(evaluator.evaluate(sample)).rejects.toThrow(new EvaluatorError(c.error));
    } else {
      expect(await evaluator.evaluate(sample)).toEqual(c.outcome);
    }
  });

  const invalid = golden.evaluators.filter((c: Golden) => "config_error" in c);
  it.each<Golden>(invalid)("rejects $type config $config", (c) => {
    let thrown: unknown;
    try {
      registry.normalizeConfig(c.type, c.config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidEvaluatorConfig);
    const { message, errors } = thrown as InvalidEvaluatorConfig;
    expect(message).toBe(c.config_error.message);
    if (ENGINE_WORDED.has(c.type) && errors[0]?.message.startsWith("Value error")) {
      expect(errors.map((e) => e.loc)).toEqual(c.config_error.errors.map((e: Golden) => e.loc));
      expect(c.config_error.errors[0].message).toMatch(/^Value error, /);
    } else {
      expect(errors).toEqual(c.config_error.errors);
    }
  });
});

describe("judge prompts", () => {
  it("uses the backend's system prompt", () => {
    expect(JUDGE_SYSTEM_PROMPT).toBe(golden.judge_system_prompt);
  });

  const cases = golden.judge_prompts.filter((c: Golden) => !knownDivergence(c));
  it.each<Golden>(cases)("builds the prompt for $config.criteria", (c) => {
    const config = registry.normalizeConfig("llm_judge", c.config) as JudgeConfig;
    const sample = { input: c.input, expected: c.expected, output: c.output };
    expect(buildJudgePrompt(config, sample)).toBe(c.prompt);
  });
});
