import Link from "next/link";

import { Badge, RunStatusBadge } from "@/components/ui/badge";
import { RunProgressBar } from "@/components/ui/progress";
import type { Run } from "@/lib/api/types";
import { formatRelativeTime, formatScore } from "@/lib/format";

type ArmSummary = { overall_score?: number | null; failed?: number };

function armSummaries(run: Run): Array<{ name: string; score: number | null; failed: number }> {
  const arms = (run.summary?.arms ?? {}) as Record<string, ArmSummary>;
  return run.variants.map((variant) => ({
    name: variant.name,
    score: arms[variant.id]?.overall_score ?? null,
    failed: arms[variant.id]?.failed ?? 0,
  }));
}

export function RunsTable({ runs, showSuite }: { runs: Run[]; showSuite?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-left text-[13px]">
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Run</th>
            {showSuite && <th className="px-4 py-2 font-medium">Suite</th>}
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Variants and scores</th>
            <th className="px-4 py-2 text-right font-medium">Cases</th>
            <th className="px-4 py-2 text-right font-medium">Started</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map((run) => (
            <tr key={run.id} className="align-top hover:bg-surface-2/50">
              <td className="px-4 py-3">
                <Link href={`/runs/${run.id}`} className="font-medium text-ink hover:text-accent">
                  {run.name}
                </Link>
                {run.is_baseline && (
                  <Badge tone="accent" className="ml-2">
                    baseline
                  </Badge>
                )}
              </td>
              {showSuite && (
                <td className="px-4 py-3">
                  <Link href={`/suites/${run.suite_id}`} className="text-muted hover:text-ink">
                    {run.suite_name}
                  </Link>
                </td>
              )}
              <td className="px-4 py-3">
                <RunStatusBadge status={run.status} />
                {(run.status === "running" || run.status === "queued") && (
                  <div className="mt-2 w-28">
                    <RunProgressBar progress={run.progress} />
                  </div>
                )}
              </td>
              <td className="px-4 py-3">
                <ul className="space-y-0.5">
                  {armSummaries(run).map((arm) => (
                    <li key={arm.name} className="flex items-baseline justify-between gap-4 text-xs">
                      <span className="truncate text-muted">{arm.name}</span>
                      <span className="num font-medium text-ink">
                        {formatScore(arm.score)}
                        {arm.failed > 0 && (
                          <span className="ml-1.5 text-bad" title="Failed generations">
                            {arm.failed} err
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </td>
              <td className="num px-4 py-3 text-right text-muted">{run.case_count}</td>
              <td className="px-4 py-3 text-right text-xs whitespace-nowrap text-muted">
                {formatRelativeTime(run.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
