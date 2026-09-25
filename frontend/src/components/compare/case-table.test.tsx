import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_FILTERS } from "@/lib/comparison";
import { report } from "@/test/fixtures";

import { CaseTable } from "./case-table";

function renderTable(filters = EMPTY_FILTERS, onFilters = vi.fn()) {
  render(
    <CaseTable
      report={report()}
      filters={filters}
      sort="worst"
      onFilters={onFilters}
      onSort={() => {}}
      caseHref={(item) => `/cases/${item.test_case_id}`}
    />,
  );
  return onFilters;
}

const caseLinks = () =>
  within(screen.getByRole("table"))
    .getAllByRole("link")
    .map((link) => link.textContent);

describe("CaseTable", () => {
  it("lists the largest drops first with counts on each outcome tab", () => {
    renderTable();
    expect(caseLinks()).toEqual(["beta", "gamma", "alpha"]);
    expect(screen.getByRole("tab", { name: /Regressed 1/ })).toBeDefined();
    expect(screen.getByRole("tab", { name: /Improved 2/ })).toBeDefined();
  });

  it("shows only regressions when that filter is active", () => {
    renderTable({ ...EMPTY_FILTERS, change: "regressed" });
    expect(caseLinks()).toEqual(["beta"]);
  });

  it("filters by tag", () => {
    renderTable({ ...EMPTY_FILTERS, tag: "easy" });
    expect(caseLinks()).toEqual(["gamma", "alpha"]);
  });

  it("reports filter changes to the parent", () => {
    const onFilters = renderTable();
    fireEvent.click(screen.getByRole("tab", { name: /Regressed/ }));
    expect(onFilters).toHaveBeenCalledWith({ change: "regressed" });
  });

  it("links each case to the inspector", () => {
    renderTable();
    expect(screen.getByRole("link", { name: "beta" }).getAttribute("href")).toBe(
      "/cases/case_beta",
    );
  });
});
