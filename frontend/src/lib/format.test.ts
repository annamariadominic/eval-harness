import { describe, expect, it } from "vitest";

import {
  costTone,
  deltaTone,
  formatCost,
  formatDelta,
  formatLatency,
  formatRelativeTime,
  formatScore,
  formatTokens,
  formatValue,
} from "./format";

describe("score formatting", () => {
  it("shows scores as percentages with one decimal", () => {
    expect(formatScore(0.891)).toBe("89.1");
    expect(formatScore(null)).toBe("—");
  });

  it("signs deltas in percentage points and treats noise as zero", () => {
    expect(formatDelta(0.067)).toBe("+6.7");
    expect(formatDelta(-0.31)).toBe("−31.0");
    expect(formatDelta(0.0001)).toBe("0.0");
    expect(formatDelta(undefined)).toBe("—");
  });

  it("assigns tones with a dead zone", () => {
    expect(deltaTone(0.05)).toBe("good");
    expect(deltaTone(-0.05)).toBe("bad");
    expect(deltaTone(0.002)).toBe("neutral");
    expect(deltaTone(null)).toBe("neutral");
  });

  it("treats lower latency and cost as better", () => {
    expect(costTone(-0.5, 2)).toBe("good");
    expect(costTone(0.5, 2)).toBe("bad");
    expect(costTone(0.01, 2)).toBe("neutral");
  });
});

describe("operational formatting", () => {
  it("formats latency", () => {
    expect(formatLatency(270.4)).toBe("270 ms");
    expect(formatLatency(1420)).toBe("1.42 s");
  });

  it("formats cost with precision that fits the magnitude", () => {
    expect(formatCost(0.00066)).toBe("$0.0007");
    expect(formatCost(0.0321)).toBe("$0.032");
    expect(formatCost(12.5)).toBe("$12.50");
    expect(formatCost(null)).toBe("—");
  });

  it("abbreviates token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });

  it("formats relative time", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(formatRelativeTime("2026-01-01T11:59:50Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-01-01T11:30:00Z", now)).toBe("30 min ago");
    expect(formatRelativeTime("2025-12-30T12:00:00Z", now)).toBe("2 d ago");
  });

  it("pretty-prints structured values", () => {
    expect(formatValue("text")).toBe("text");
    expect(formatValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatValue(null)).toBe("");
  });
});
