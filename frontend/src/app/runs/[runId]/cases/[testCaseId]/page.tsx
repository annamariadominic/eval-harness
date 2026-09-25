"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

import { OutputPanel } from "@/components/inspector/output-panel";
import { ScoreComparison } from "@/components/inspector/score-comparison";
import { StructuredValue } from "@/components/inspector/structured-value";
import { ChangeBadge, Tag } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Delta } from "@/components/ui/delta";
import { ErrorNotice, LoadingRows } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { query } from "@/lib/api/client";
import { useCaseResults, useComparison, useRun } from "@/lib/api/hooks";
import type { ArmResult } from "@/lib/api/types";
import { type ChangeFilter, type SortOrder, filterCases, sortCases } from "@/lib/comparison";
import { deltaTone, formatDelta, formatScore } from "@/lib/format";

export default function CaseInspectorPage() {
  return (
    <Suspense fallback={<LoadingRows rows={5} />}>
      <CaseInspector />
    </Suspense>
  );
}

function CaseInspector() {
  const { runId, testCaseId } = useParams<{ runId: string; testCaseId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const target = params.get("target");
  const baseParam = params.get("base");
  const base = baseParam && baseParam !== "none" ? baseParam : null;
  const filters = {
    change: (params.get("change") as ChangeFilter | null) ?? "all",
    tag: params.get("tag"),
    evaluator: params.get("evaluator"),
    search: "",
  };

  const { data: run } = useRun(runId);
  const refreshKey = run
    ? `${run.status}:${run.progress.succeeded + run.progress.failed + run.progress.cancelled}`
    : "";
  const { data: report } = useComparison(run ? target : null, base, null, refreshKey);
  const arms = [base, target].filter((id): id is string => Boolean(id));
  const { data: results, error } = useCaseResults(testCaseId, arms);

  // Previous/next follow the dashboard's filtered, sorted list.
  const ordered = report
    ? sortCases(
        filterCases(report.cases, filters),
        (params.get("sort") as SortOrder | null) ?? "worst",
        filters.evaluator,
      )
    : [];
  const index = ordered.findIndex((c) => c.test_case_id === testCaseId);
  const hrefFor = (caseId: string) => `/runs/${runId}/cases/${caseId}?${params.toString()}`;
  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
  const backHref = `/runs/${runId}${query({
    target,
    base: baseParam,
    change: filters.change === "all" ? null : filters.change,
    tag: filters.tag,
    evaluator: filters.evaluator,
  })}`;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)
      )
        return;
      if (event.key === "j" && next) router.push(hrefFor(next.test_case_id));
      if (event.key === "k" && prev) router.push(hrefFor(prev.test_case_id));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error) return <ErrorNotice error={error} />;
  if (!run || !results) return <LoadingRows rows={5} />;

  const byArm = new Map<string, ArmResult>(results.arms.map((a) => [a.arm.run_variant_id, a]));
  const baseResult = base ? byArm.get(base) : undefined;
  const targetResult = target ? byArm.get(target) : undefined;
  const comparison = report?.cases.find((c) => c.test_case_id === testCaseId);
  const { case: testCase } = results;
  const filterLabel = filters.change === "all" ? "cases" : `${filters.change} cases`;

  return (
    <>
      <PageHeader
        breadcrumb={[
          { href: "/runs", label: "Runs" },
          { href: backHref, label: run.name },
        ]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {testCase.key ?? testCase.test_case_id}
            {comparison && base && (
              <ChangeBadge change={comparison.change} mixed={comparison.mixed} />
            )}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            {testCase.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
            {comparison && base && (
              <span className="num ml-2 text-xs">
                case score {formatScore(comparison.base_score)} →{" "}
                {formatScore(comparison.target_score)}{" "}
                <Delta text={formatDelta(comparison.delta)} tone={deltaTone(comparison.delta)} />
              </span>
            )}
          </span>
        }
        actions={
          index >= 0 && (
            <div className="flex items-center gap-2">
              <span className="num text-xs text-muted">
                {index + 1} of {ordered.length} {filterLabel}
              </span>
              <ButtonLink
                href={prev ? hrefFor(prev.test_case_id) : "#"}
                aria-disabled={!prev}
                className={prev ? undefined : "pointer-events-none opacity-40"}
                title="Previous case (k)"
                icon={<ChevronLeft size={14} />}
              >
                Prev
              </ButtonLink>
              <ButtonLink
                href={next ? hrefFor(next.test_case_id) : "#"}
                aria-disabled={!next}
                className={next ? undefined : "pointer-events-none opacity-40"}
                title="Next case (j)"
              >
                Next <ChevronRight size={14} />
              </ButtonLink>
            </div>
          )
        }
      />

      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title="Input">
            <StructuredValue value={testCase.input} />
          </Panel>
          <Panel title="Expected / reference">
            {testCase.expected === null || testCase.expected === undefined ? (
              <p className="text-xs text-muted">This case has no expected output.</p>
            ) : (
              <StructuredValue value={testCase.expected} />
            )}
          </Panel>
        </div>

        <div className={base ? "grid gap-6 lg:grid-cols-2" : undefined}>
          {base && <OutputPanel role="Reference output" result={baseResult} />}
          <OutputPanel role={base ? "Candidate output" : "Output"} result={targetResult} />
        </div>

        <ScoreComparison
          base={baseResult}
          target={targetResult}
          deltas={comparison?.evaluators ?? []}
        />

        <Panel title="Rendered prompts" description="Exactly what was sent to each model.">
          <div className={base ? "grid gap-6 lg:grid-cols-2" : undefined}>
            {[baseResult, targetResult]
              .filter((r): r is ArmResult => Boolean(r))
              .map((result) => (
                <details key={result.result_id} className="group min-w-0">
                  <summary className="cursor-pointer text-xs text-muted hover:text-ink">
                    {result.arm.variant_name}: {result.request_messages?.length ?? 0} messages
                  </summary>
                  <div className="mt-2 space-y-2">
                    {(result.request_messages ?? []).map((message, i) => (
                      <div key={i}>
                        <p className="mb-1 text-xs text-faint">{String(message.role)}</p>
                        <CodeBlock value={String(message.content)} maxHeight="max-h-64" />
                      </div>
                    ))}
                  </div>
                </details>
              ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
