/**
 * Port of `app/evaluators/registry.py`.
 *
 * Config validation is driven by each type's JSON schema (exported from the backend's Pydantic
 * models), and reports errors with Pydantic's wording, so the demo and the real API reject the
 * same configs with the same messages and store the same normalised config.
 */

import { isDict } from "../py";
import { validateObject } from "../validation";
import type { Evaluator, ModelCaller } from "./base";
import {
  compilePythonRegex,
  ContainsEvaluator,
  ExactMatchEvaluator,
  FieldMatchEvaluator,
  JsonSchemaEvaluator,
  JsonValidEvaluator,
  RegexEvaluator,
  RequiredFieldsEvaluator,
} from "./deterministic";
import { LLMJudgeEvaluator, type JudgeConfig } from "./judge";
import { checkSchema } from "./jsonschema";

export type EvaluatorTypeInfo = {
  type: string;
  label: string;
  description: string;
  kind: string;
  scoring: string;
  requires_expected: boolean;
  config_schema: Record<string, unknown>;
};

export type ConfigErrorDetail = { loc: string[]; message: string };

export class InvalidEvaluatorConfig extends Error {
  constructor(
    message: string,
    readonly errors: ConfigErrorDetail[] = [],
  ) {
    super(message);
    this.name = "InvalidEvaluatorConfig";
  }
}

type Config = Record<string, unknown>;

const FACTORIES: Record<string, (config: Config, caller: ModelCaller | null) => Evaluator> = {
  exact_match: (c) => new ExactMatchEvaluator(c),
  contains: (c) => new ContainsEvaluator(c),
  regex: (c) => new RegexEvaluator(c),
  json_valid: (c) => new JsonValidEvaluator(c),
  json_schema: (c) => new JsonSchemaEvaluator(c),
  required_fields: (c) => new RequiredFieldsEvaluator(c),
  field_match: (c) => new FieldMatchEvaluator(c),
  llm_judge: (c, caller) => {
    if (caller === null) throw new Error("LLM judge evaluators require a model caller");
    return new LLMJudgeEvaluator(c as JudgeConfig, caller);
  },
};

const FIELD_VALIDATORS: Record<string, Record<string, (value: unknown) => void>> = {
  regex: {
    pattern: (value) => {
      try {
        compilePythonRegex(String(value));
      } catch (error) {
        throw new Error(`Invalid regular expression: ${(error as Error).message}`);
      }
    },
  },
  json_schema: {
    json_schema: (value) => {
      try {
        checkSchema(value);
      } catch (error) {
        throw new Error(`Invalid JSON Schema: ${(error as Error).message}`);
      }
    },
  },
};

const MODEL_VALIDATORS: Record<string, (config: Config) => void> = {
  llm_judge: (config) => {
    if ((config.score_max as number) <= (config.score_min as number)) {
      throw new Error("score_max must be greater than score_min");
    }
  },
};

export class EvaluatorRegistry {
  private readonly types: Map<string, EvaluatorTypeInfo>;

  constructor(types: EvaluatorTypeInfo[]) {
    this.types = new Map(types.map((t) => [t.type, t]));
  }

  list(): EvaluatorTypeInfo[] {
    return [...this.types.values()];
  }

  get(type: string): EvaluatorTypeInfo {
    const spec = this.types.get(type);
    if (!spec) {
      const known = [...this.types.keys()].sort().join(", ");
      throw new InvalidEvaluatorConfig(`Unknown evaluator type '${type}'. Known types: ${known}`);
    }
    return spec;
  }

  /** Validate and fill defaults, returning the canonical config that gets stored. */
  normalizeConfig(type: string, config: unknown): Config {
    const spec = this.get(type);
    const validators = FIELD_VALIDATORS[type] ?? {};
    const { value, issues } = validateObject(spec.config_schema, isDict(config) ? config : {}, {
      fieldValidators: Object.fromEntries(
        Object.entries(validators).map(([name, check]) => [
          name,
          (v: unknown) => {
            check(v);
            return v;
          },
        ]),
      ),
      modelValidator: MODEL_VALIDATORS[type],
    });
    if (issues.length) {
      throw new InvalidEvaluatorConfig(
        `Invalid configuration for ${spec.label} evaluator`,
        issues.map(({ loc, message }) => ({ loc, message })),
      );
    }
    return value;
  }

  build(type: string, config: unknown, caller: ModelCaller | null = null): Evaluator {
    return FACTORIES[this.get(type).type](this.normalizeConfig(type, config), caller);
  }
}
