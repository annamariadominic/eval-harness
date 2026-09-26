import { describe, expect, it } from "vitest";

import { unitGolden, type Golden } from "../golden";
import { MockProvider } from "./mock-provider";
import { PricingTable } from "./pricing";
import { ProviderError } from "./providers";
import { renderTemplate, TemplateError, templateVariables } from "./templates";

const golden = unitGolden();
const noSleep = async () => {};

describe("mock provider parity", () => {
  it("reproduces every single-shot generation", async () => {
    const provider = new MockProvider(0, noSleep);
    const mismatches: string[] = [];
    for (const c of golden.mock.single as Golden[]) {
      const result = await provider.generate(c.messages, c.config);
      if (JSON.stringify(result) !== JSON.stringify(c.result)) {
        mismatches.push(
          `${JSON.stringify(c.messages)}\n  got ${JSON.stringify(result)}\n  want ${JSON.stringify(c.result)}`,
        );
      }
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
    expect(golden.mock.single.length).toBeGreaterThan(400);
  });

  it("injects transient failures that clear on retry, attempt by attempt", async () => {
    for (const c of golden.mock.sequences as Golden[]) {
      const provider = new MockProvider(0, noSleep);
      for (const expected of c.attempts) {
        try {
          const result = await provider.generate(c.messages, c.config);
          expect({ result }).toEqual(expected);
        } catch (error) {
          expect(error).toBeInstanceOf(ProviderError);
          const { message, kind, statusCode } = error as ProviderError;
          expect({ error: { message, kind, status_code: statusCode } }).toEqual(expected);
        }
      }
    }
  });
});

describe("templates", () => {
  // `{"n": 3.0}` renders as "3.0" in Python; a JavaScript number cannot remember the ".0".
  const cases = golden.templates.filter((c: Golden) => c.template !== "{{ n }}");
  it.each<Golden>(cases)("renders $template", (c) => {
    expect(templateVariables(c.template)).toEqual(c.variables);
    if (c.error) {
      expect(() => renderTemplate(c.template, c.input)).toThrow(new TemplateError(c.error));
    } else {
      expect(renderTemplate(c.template, c.input)).toBe(c.output);
    }
  });
});

describe("pricing", () => {
  it("estimates cost like the backend", async () => {
    const snapshot = await import("../../../public/demo/snapshot.json");
    const table = PricingTable.fromJson(snapshot.pricing);
    for (const c of golden.pricing as Golden[]) {
      expect(table.estimate(c.provider, c.model, c.input_tokens, c.output_tokens)).toBe(c.cost);
    }
  });
});
