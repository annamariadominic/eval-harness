"use client";

import type { RunDetail } from "@/lib/api/types";
import { formatCost, formatLatency, formatPercent, formatScore, formatTokens } from "@/lib/format";

type ArmSummary = {
  overall_score: number | null;
  pass_rate: number | null;
  succeeded: number;
  failed: number;
  latency: { mean_ms: number | null };
  total_tokens: number;
  total_cost_usd: number | null;
};

/** Per-variant headline numbers from the run's stored summary. */
export function RunResults({ run }: { run: RunDetail }) {
  const arms = (run.summary?.arms ?? {}) as Record<string, ArmSummary>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-left text-[13px]">
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Variant</th>
            <th className="px-4 py-2 text-right font-medium">Score</th>
            <th className="px-4 py-2 text-right font-medium">Pass rate</th>
            <th className="px-4 py-2 text-right font-medium">Errors</th>
            <th className="px-4 py-2 text-right font-medium">Avg latency</th>
            <th className="px-4 py-2 text-right font-medium">Tokens</th>
            <th className="px-4 py-2 text-right font-medium">Est. cost</th>
          </tr>
        </thead>
        <tbody className="num divide-y divide-line">
          {run.variants.map((variant) => {
            const arm = arms[variant.id];
            return (
              <tr key={variant.id}>
                <td className="px-4 py-2.5">
                  <p className="font-medium text-ink">{variant.name}</p>
                  <p className="font-mono text-xs text-muted">
                    {variant.provider}/{variant.model}
                  </p>
                </td>
                <td className="px-4 py-2.5 text-right font-semibold">
                  {formatScore(arm?.overall_score)}
                </td>
                <td className="px-4 py-2.5 text-right">{formatPercent(arm?.pass_rate)}</td>
                <td className="px-4 py-2.5 text-right">{arm?.failed ?? "—"}</td>
                <td className="px-4 py-2.5 text-right">{formatLatency(arm?.latency.mean_ms)}</td>
                <td className="px-4 py-2.5 text-right">{formatTokens(arm?.total_tokens)}</td>
                <td className="px-4 py-2.5 text-right">{formatCost(arm?.total_cost_usd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!run.summary && (
        <p className="border-t border-line px-4 py-3 text-xs text-muted">
          Scores appear when the run finishes.
        </p>
      )}
    </div>
  );
}
