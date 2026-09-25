import type { ReactNode } from "react";

import { Delta } from "@/components/ui/delta";
import { Panel } from "@/components/ui/panel";
import type { ArmMetrics, ComparisonReport } from "@/lib/api/types";
import {
  costTone,
  deltaTone,
  formatCost,
  formatCostDelta,
  formatDelta,
  formatLatency,
  formatLatencyDelta,
  formatPercent,
  formatScore,
  formatTokens,
  type Tone,
} from "@/lib/format";

type Row = {
  label: ReactNode;
  base: string;
  target: string;
  delta: string;
  tone: Tone;
  note?: string;
};

function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  return a === null || a === undefined || b === null || b === undefined ? null : b - a;
}

function scoreRow(
  label: ReactNode,
  a: number | null | undefined,
  b: number | null | undefined,
  format = formatScore,
): Row {
  const d = diff(a, b);
  return { label, base: format(a), target: format(b), delta: formatDelta(d), tone: deltaTone(d) };
}

export function MetricsTable({ report }: { report: ComparisonReport }) {
  const base: ArmMetrics | null = report.base_metrics ?? null;
  const target = report.target_metrics;
  const single = base === null;
  const baseEvaluators = new Map(base?.evaluators.map((e) => [e.evaluator_key, e]) ?? []);
  const scoring = new Map(report.evaluators.map((e) => [e.key, e.scoring]));

  const quality: Row[] = [
    scoreRow(
      <span className="font-medium text-ink">Overall score</span>,
      base?.overall_score,
      target.overall_score,
    ),
    scoreRow("Cases passing every check", base?.pass_rate, target.pass_rate, formatPercent),
    ...target.evaluators.map((evaluator) => {
      const before = baseEvaluators.get(evaluator.evaluator_key);
      const binary = scoring.get(evaluator.evaluator_key) === "binary";
      const row = scoreRow(
        evaluator.evaluator_name,
        binary ? before?.pass_rate : before?.mean_score,
        binary ? evaluator.pass_rate : evaluator.mean_score,
        binary ? formatPercent : formatScore,
      );
      if (evaluator.errors > 0) row.note = `${evaluator.errors} evaluator errors`;
      return row;
    }),
  ];

  const latency = diff(base?.latency.mean_ms, target.latency.mean_ms);
  const p95 = diff(base?.latency.p95_ms, target.latency.p95_ms);
  const tokens = diff(base?.total_tokens, target.total_tokens);
  const cost = diff(base?.total_cost_usd, target.total_cost_usd);
  const operations: Row[] = [
    {
      label: "Avg latency",
      base: formatLatency(base?.latency.mean_ms),
      target: formatLatency(target.latency.mean_ms),
      delta: formatLatencyDelta(latency),
      tone: costTone(latency, base?.latency.mean_ms),
    },
    {
      label: "p95 latency",
      base: formatLatency(base?.latency.p95_ms),
      target: formatLatency(target.latency.p95_ms),
      delta: formatLatencyDelta(p95),
      tone: costTone(p95, base?.latency.p95_ms),
    },
    {
      label: "Tokens",
      base: formatTokens(base?.total_tokens),
      target: formatTokens(target.total_tokens),
      delta:
        tokens === null
          ? "—"
          : `${tokens > 0 ? "+" : tokens < 0 ? "−" : ""}${formatTokens(Math.abs(tokens))}`,
      tone: costTone(tokens, base?.total_tokens),
    },
    {
      label: "Estimated cost",
      base: formatCost(base?.total_cost_usd),
      target: formatCost(target.total_cost_usd),
      delta: formatCostDelta(cost),
      tone: costTone(cost, base?.total_cost_usd),
      note:
        target.cost_complete && (base?.cost_complete ?? true)
          ? undefined
          : "Some models have no pricing entry",
    },
    {
      label: "Generation errors",
      base: String(base?.failed ?? "—"),
      target: String(target.failed),
      delta: "",
      tone: "neutral",
    },
    {
      label: "Retried generations",
      base: String(base?.retried_generations ?? "—"),
      target: String(target.retried_generations),
      delta: "",
      tone: "neutral",
    },
  ];

  return (
    <Panel title="Metrics" flush>
      <table className="num w-full text-[13px]">
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2 text-left font-medium" />
            {!single && (
              <th className="px-3 py-2 text-right font-medium" title={report.base?.variant_name}>
                Reference
              </th>
            )}
            <th className="px-3 py-2 text-right font-medium" title={report.target.variant_name}>
              Candidate
            </th>
            {!single && <th className="px-4 py-2 text-right font-medium">Δ</th>}
          </tr>
        </thead>
        <tbody>
          {quality.map((row, i) => (
            <MetricRow key={`q${i}`} row={row} single={single} />
          ))}
          <tr>
            <td colSpan={4} className="border-t border-line px-4 pt-3 pb-1 text-xs text-faint">
              Operations
            </td>
          </tr>
          {operations.map((row, i) => (
            <MetricRow key={`o${i}`} row={row} single={single} />
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function MetricRow({ row, single }: { row: Row; single: boolean }) {
  return (
    <tr className="hover:bg-surface-2/50">
      <td className="px-4 py-1.5 text-muted">
        {row.label}
        {row.note && <span className="ml-2 text-xs text-warn">{row.note}</span>}
      </td>
      {!single && <td className="px-3 py-1.5 text-right text-muted">{row.base}</td>}
      <td className="px-3 py-1.5 text-right text-ink">{row.target}</td>
      {!single && (
        <td className="px-4 py-1.5 text-right">
          <Delta text={row.delta} tone={row.tone} />
        </td>
      )}
    </tr>
  );
}
