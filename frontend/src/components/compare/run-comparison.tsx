"use client";

import { ErrorNotice, LoadingRows } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { RunResults } from "@/components/runs/run-results";
import { query } from "@/lib/api/client";
import { useComparison, useSuite } from "@/lib/api/hooks";
import type { CaseComparison, RunDetail } from "@/lib/api/types";
import {
  type CaseFilters,
  type ChangeFilter,
  type SortOrder,
  armOptions,
  defaultArms,
} from "@/lib/comparison";
import { useQueryParams } from "@/lib/use-query-params";

import { ArmPicker } from "./arm-picker";
import { CaseTable } from "./case-table";
import { MetricsTable } from "./metrics-table";
import { SliceTable } from "./slice-table";
import { Verdict } from "./verdict";

const NO_REFERENCE = "none";

export function RunComparison({ run }: { run: RunDetail }) {
  const { params, update } = useQueryParams();
  const { data: suite } = useSuite(run.suite_id);
  const baseline = suite?.baseline ?? null;

  const defaults = defaultArms(run, baseline);
  const target = params.get("target") ?? defaults.target;
  const baseParam = params.get("base");
  const base = baseParam === NO_REFERENCE ? null : (baseParam ?? defaults.base);
  const sliceEvaluator = params.get("slice");
  const filters: CaseFilters = {
    change: (params.get("change") as ChangeFilter | null) ?? "all",
    tag: params.get("tag"),
    evaluator: params.get("evaluator"),
    search: params.get("q") ?? "",
  };
  const sort = (params.get("sort") as SortOrder | null) ?? "worst";

  // Refetch as results land while the run is executing.
  const { progress } = run;
  const refreshKey = `${run.status}:${progress.succeeded + progress.failed + progress.cancelled}`;
  const { data: report, error } = useComparison(target, base, sliceEvaluator, refreshKey);

  if (!suite) return <LoadingRows rows={4} />;
  const options = armOptions(run, baseline);

  const caseHref = (item: CaseComparison) =>
    `/runs/${run.id}/cases/${item.test_case_id}${query({
      target,
      base: base ?? NO_REFERENCE,
      change: filters.change === "all" ? null : filters.change,
      tag: filters.tag,
      evaluator: filters.evaluator,
    })}`;

  return (
    <div className="space-y-6">
      <ArmPicker
        options={options}
        base={base}
        target={target}
        onChange={(nextBase, nextTarget) =>
          update({ base: nextBase ?? NO_REFERENCE, target: nextTarget })
        }
      />
      {error ? (
        <ErrorNotice error={error} />
      ) : !report ? (
        <LoadingRows rows={6} />
      ) : (
        <>
          <Verdict report={report} onSelectChange={(change) => update({ change })} />
          <div className="grid gap-6 xl:grid-cols-2">
            <MetricsTable report={report} />
            <SliceTable
              report={report}
              sliceEvaluator={sliceEvaluator}
              onSliceEvaluator={(key) => update({ slice: key })}
              activeTag={filters.tag}
              onSelectTag={(tag) => update({ tag })}
            />
          </div>
          {run.variants.length > 2 && (
            <Panel title="All variants in this run" flush>
              <div className="-m-px">
                <RunResults run={run} />
              </div>
            </Panel>
          )}
          <CaseTable
            report={report}
            filters={filters}
            sort={sort}
            onFilters={(changes) =>
              update({
                ...("change" in changes
                  ? { change: changes.change === "all" ? null : changes.change! }
                  : {}),
                ...("tag" in changes ? { tag: changes.tag ?? null } : {}),
                ...("evaluator" in changes ? { evaluator: changes.evaluator ?? null } : {}),
                ...("search" in changes ? { q: changes.search ?? null } : {}),
              })
            }
            onSort={(next) => update({ sort: next === "worst" ? null : next })}
            caseHref={caseHref}
          />
        </>
      )}
    </div>
  );
}
