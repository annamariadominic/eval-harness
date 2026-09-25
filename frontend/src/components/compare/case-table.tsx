import Link from "next/link";

import { ChangeBadge, Tag } from "@/components/ui/badge";
import { Delta } from "@/components/ui/delta";
import { Select, TextInput } from "@/components/ui/field";
import type { CaseComparison, ComparisonReport } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import {
  type CaseFilters,
  type ChangeFilter,
  type SortOrder,
  countBy,
  effectiveChange,
  evaluatorDelta,
  filterCases,
  sortCases,
} from "@/lib/comparison";
import { deltaTone, formatDelta, formatScore } from "@/lib/format";

import { ScoreValue } from "./score-cell";

const CHANGE_TABS: Array<{ value: ChangeFilter; label: string; comparedOnly?: boolean }> = [
  { value: "all", label: "All" },
  { value: "regressed", label: "Regressed", comparedOnly: true },
  { value: "improved", label: "Improved", comparedOnly: true },
  { value: "unchanged", label: "Unchanged", comparedOnly: true },
  { value: "failing", label: "Failing checks" },
  { value: "errors", label: "Errors" },
];

export function CaseTable({
  report,
  filters,
  sort,
  onFilters,
  onSort,
  caseHref,
}: {
  report: ComparisonReport;
  filters: CaseFilters;
  sort: SortOrder;
  onFilters: (changes: Partial<CaseFilters>) => void;
  onSort: (sort: SortOrder) => void;
  caseHref: (item: CaseComparison) => string;
}) {
  const single = !report.base;
  const counts = countBy(report.cases, filters.evaluator);
  const visible = sortCases(filterCases(report.cases, filters), sort, filters.evaluator);
  const tags = report.slices.map((s) => s.tag).filter((t) => t !== "(untagged)");
  const binary = new Map(report.evaluators.map((e) => [e.key, e.scoring === "binary"]));
  const focused = filters.evaluator
    ? report.evaluators.find((e) => e.key === filters.evaluator)
    : null;

  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="space-y-3 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold">Test cases</h2>
          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              className="w-40"
              placeholder="Filter by key"
              value={filters.search}
              onChange={(e) => onFilters({ search: e.target.value })}
              aria-label="Filter cases by key"
            />
            <Select
              className="w-36"
              value={filters.tag ?? ""}
              onChange={(e) => onFilters({ tag: e.target.value || null })}
              aria-label="Filter by tag"
            >
              <option value="">All tags</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </Select>
            <Select
              className="w-44"
              value={filters.evaluator ?? ""}
              onChange={(e) => onFilters({ evaluator: e.target.value || null })}
              aria-label="Focus on evaluator"
            >
              <option value="">All evaluators</option>
              {report.evaluators.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.name}
                </option>
              ))}
            </Select>
            {!single && (
              <Select
                className="w-36"
                value={sort}
                onChange={(e) => onSort(e.target.value as SortOrder)}
                aria-label="Sort cases"
              >
                <option value="worst">Largest drop first</option>
                <option value="best">Largest gain first</option>
                <option value="dataset">Dataset order</option>
              </Select>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter by outcome">
          {CHANGE_TABS.filter((tab) => !single || !tab.comparedOnly).map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={filters.change === tab.value}
              onClick={() => onFilters({ change: tab.value })}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs",
                filters.change === tab.value
                  ? "bg-ink text-bg"
                  : "text-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              {tab.label} <span className="num opacity-70">{counts[tab.value]}</span>
            </button>
          ))}
        </div>
        {focused && (
          <p className="text-xs text-muted">
            Outcomes and sorting use <span className="text-ink">{focused.name}</span> only.
          </p>
        )}
      </header>

      <div className="overflow-x-auto">
        <table className="num w-full text-[13px]">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 text-left font-medium">Case</th>
              {!single && <th className="px-2 py-2 text-right font-medium">Ref</th>}
              <th className="px-2 py-2 text-right font-medium">{single ? "Score" : "Cand"}</th>
              {!single && <th className="px-2 py-2 text-right font-medium">Δ</th>}
              {!single && <th className="px-2 py-2 text-left font-medium">Outcome</th>}
              {report.evaluators.map((e) => (
                <th
                  key={e.key}
                  className={cn(
                    "max-w-24 truncate px-2 py-2 text-right font-medium",
                    filters.evaluator === e.key && "text-accent",
                  )}
                  title={e.name}
                >
                  {e.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((item) => {
              const focusedDelta = evaluatorDelta(item, filters.evaluator);
              const shownBase = focusedDelta ? focusedDelta.base_score : item.base_score;
              const shownTarget = focusedDelta ? focusedDelta.target_score : item.target_score;
              const shownDelta = focusedDelta ? focusedDelta.delta : item.delta;
              return (
                <tr key={item.test_case_id} className="group hover:bg-surface-2/50">
                  <td className="max-w-72 px-4 py-2">
                    <Link
                      href={caseHref(item)}
                      className="font-medium text-ink group-hover:text-accent"
                    >
                      {item.key ?? item.test_case_id}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {item.tags.map((tag) => (
                        <Tag key={tag} active={tag === filters.tag}>
                          {tag}
                        </Tag>
                      ))}
                      {item.target_error_type && (
                        <span className="text-xs text-bad">error: {item.target_error_type}</span>
                      )}
                      {item.base_error_type && (
                        <span className="text-xs text-warn">
                          reference error: {item.base_error_type}
                        </span>
                      )}
                    </div>
                  </td>
                  {!single && (
                    <td className="px-2 py-2 text-right text-muted">{formatScore(shownBase)}</td>
                  )}
                  <td className="px-2 py-2 text-right text-ink">{formatScore(shownTarget)}</td>
                  {!single && (
                    <td className="px-2 py-2 text-right">
                      <Delta text={formatDelta(shownDelta)} tone={deltaTone(shownDelta)} />
                    </td>
                  )}
                  {!single && (
                    <td className="px-2 py-2">
                      <ChangeBadge
                        change={effectiveChange(item, filters.evaluator)}
                        mixed={!filters.evaluator && item.mixed}
                      />
                    </td>
                  )}
                  {report.evaluators.map((e) => {
                    const d = item.evaluators.find((x) => x.evaluator_key === e.key);
                    return (
                      <td
                        key={e.key}
                        className={cn(
                          "px-2 py-2 text-right text-xs",
                          d?.change === "regressed" && "bg-bad-soft/60",
                          d?.change === "improved" && "bg-good-soft/60",
                        )}
                        title={
                          d && !single
                            ? `${e.name}: ${formatScore(d.base_score)} → ${formatScore(d.target_score)} (${d.change})`
                            : e.name
                        }
                      >
                        <ScoreValue
                          score={d?.target_score}
                          passed={d?.target_passed}
                          binary={binary.get(e.key) ?? false}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-muted">No cases match these filters.</p>
        )}
      </div>
    </section>
  );
}
