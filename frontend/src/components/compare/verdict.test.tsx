import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { report } from "@/test/fixtures";

import { Verdict } from "./verdict";

describe("Verdict", () => {
  it("summarises the change counts and overall delta", () => {
    render(<Verdict report={report()} onSelectChange={() => {}} />);
    expect(screen.getByText("+20.0")).toBeDefined();
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "2 improved, 0 unchanged, 1 regressed",
    );
  });

  it("warns about regressions hidden by the headline number", () => {
    render(<Verdict report={report()} onSelectChange={() => {}} />);
    expect(
      screen.getByText("Correctness fell 20.0 points even though the overall score rose."),
    ).toBeDefined();
    expect(screen.getByText(/Slice "hard" regressed 40.0 points/)).toBeDefined();
  });

  it("jumps to the matching cases when a count is clicked", () => {
    const onSelect = vi.fn();
    render(<Verdict report={report()} onSelectChange={onSelect} />);
    fireEvent.click(screen.getByTitle("Show regressed cases"));
    expect(onSelect).toHaveBeenCalledWith("regressed");
  });

  it("shows a single-arm summary when there is no reference", () => {
    render(
      <Verdict
        report={{ ...report(), base: null, base_metrics: null, counts: null }}
        onSelectChange={() => {}}
      />,
    );
    expect(screen.getByText(/Choose a reference/)).toBeDefined();
  });
});
