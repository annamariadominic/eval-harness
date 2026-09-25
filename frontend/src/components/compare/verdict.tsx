import { AlertTriangle } from "lucide-react";

import { Delta } from "@/components/ui/delta";
import type { ComparisonReport } from "@/lib/api/types";
import { deltaTone, formatDelta, formatScore } from "@/lib/format";

/** The one-glance answer: did the candidate get better, and where did it get worse? */
export function Verdict({
  report,
  onSelectChange,
}: {
  report: ComparisonReport;
  onSelectChange: (change: "improved" | "regressed" | "unchanged") => void;
}) {
  const { counts, base, target, base_metrics: baseMetrics, target_metrics: targetMetrics } = report;

  if (!base || !counts || !baseMetrics) {
    return (
      <section className="rounded-lg border border-line bg-surface p-5">
        <p className="text-xs text-muted">{target.variant_name}</p>
        <p className="num mt-1 text-4xl font-semibold tracking-tight">
          {formatScore(targetMetrics.overall_score)}
        </p>
        <p className="mt-1 text-xs text-muted">
          Overall score across {targetMetrics.scored_cases} scored cases. Choose a reference to see
          improvements and regressions.
        </p>
      </section>
    );
  }

  const comparable = counts.improved + counts.unchanged + counts.regressed;
  const pct = (n: number) => (comparable ? (n / comparable) * 100 : 0);
  const warnings = buildWarnings(report);

  return (
    <section className="rounded-lg border border-line bg-surface">
      <div className="grid gap-6 p-5 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
        <div className="md:border-r md:border-line md:pr-8">
          <Delta
            className="block text-5xl leading-none tracking-tight"
            text={formatDelta(report.overall_delta)}
            tone={deltaTone(report.overall_delta)}
          />
          <p className="num mt-2 text-xs text-muted">
            overall score, {formatScore(baseMetrics.overall_score)} →{" "}
            <span className="text-ink">{formatScore(targetMetrics.overall_score)}</span>
          </p>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
            <CountButton
              label="improved"
              value={counts.improved}
              tone="text-good"
              onClick={() => onSelectChange("improved")}
            />
            <CountButton
              label="unchanged"
              value={counts.unchanged}
              tone="text-muted"
              onClick={() => onSelectChange("unchanged")}
            />
            <CountButton
              label="regressed"
              value={counts.regressed}
              tone="text-bad"
              onClick={() => onSelectChange("regressed")}
            />
            {counts.incomparable > 0 && (
              <span className="text-muted">
                <span className="num font-semibold text-warn">{counts.incomparable}</span> not
                comparable
              </span>
            )}
          </div>
          <div
            className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-2"
            role="img"
            aria-label={`${counts.improved} improved, ${counts.unchanged} unchanged, ${counts.regressed} regressed`}
          >
            <span className="bg-good" style={{ width: `${pct(counts.improved)}%` }} />
            <span className="bg-neutral-bar" style={{ width: `${pct(counts.unchanged)}%` }} />
            <span className="bg-bad" style={{ width: `${pct(counts.regressed)}%` }} />
          </div>
          <p className="num mt-2 text-xs text-muted">
            {target.variant_name} vs {base.variant_name}
            {base.run_id !== target.run_id && ` (${base.run_name})`}, on {report.coverage.shared}{" "}
            shared cases
            {report.coverage.base_only > 0 &&
              `; ${report.coverage.base_only} reference-only cases excluded`}
            {report.coverage.target_only > 0 &&
              `; ${report.coverage.target_only} new cases have no reference`}
            .
          </p>
        </div>
      </div>
      {warnings.length > 0 && (
        <ul className="space-y-1 border-t border-line bg-warn-soft/40 px-5 py-3 text-xs text-ink">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" aria-hidden />
              {warning}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CountButton({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted hover:text-ink"
      title={`Show ${label} cases`}
    >
      <span className={`num text-lg font-semibold ${tone}`}>{value}</span> {label}
    </button>
  );
}

/** Regressions the headline number hides: per-evaluator drops and slice-level drops. */
function buildWarnings(report: ComparisonReport): string[] {
  const warnings: string[] = [];
  const overall = report.overall_delta ?? 0;
  const baseByKey = new Map(report.base_metrics?.evaluators.map((e) => [e.evaluator_key, e]) ?? []);
  for (const evaluator of report.target_metrics.evaluators) {
    const before = baseByKey.get(evaluator.evaluator_key)?.mean_score;
    const after = evaluator.mean_score;
    if (before === null || before === undefined || after === null) continue;
    const delta = after - before;
    if (overall >= 0 && delta < -0.01) {
      warnings.push(
        `${evaluator.evaluator_name} fell ${formatDelta(delta).slice(1)} points even though the overall score ${overall > 0 ? "rose" : "held"}.`,
      );
    }
  }
  for (const slice of report.slices) {
    if (slice.hidden_regression) {
      warnings.push(
        `Slice "${slice.tag}" regressed ${formatDelta(slice.delta).slice(1)} points (${slice.cases} cases) while the aggregate improved.`,
      );
    }
  }
  return warnings;
}
