import Link from "next/link";

import { RunStatusBadge } from "@/components/ui/badge";
import { Delta } from "@/components/ui/delta";
import type { SuiteSummary } from "@/lib/api/types";
import { deltaTone, formatDelta, formatRelativeTime, formatScore } from "@/lib/format";

export function SuiteList({ suites }: { suites: SuiteSummary[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {suites.map((suite) => (
        <li key={suite.id}>
          <SuiteRow suite={suite} />
        </li>
      ))}
    </ul>
  );
}

function SuiteRow({ suite }: { suite: SuiteSummary }) {
  const latest = suite.latest_run;
  const best = latest?.best;
  return (
    <Link
      href={`/suites/${suite.id}`}
      className="grid gap-4 px-5 py-4 hover:bg-surface-2/60 md:grid-cols-[minmax(0,1fr)_200px_150px_120px]"
    >
      <div className="min-w-0">
        <p className="font-semibold text-ink">{suite.name}</p>
        {suite.description && (
          <p className="mt-0.5 line-clamp-2 max-w-2xl text-xs text-muted">{suite.description}</p>
        )}
        <p className="num mt-2 text-xs text-muted">
          {suite.test_case_count} cases, {suite.variant_count} variants, {suite.evaluator_count}{" "}
          evaluators
        </p>
      </div>

      <div className="text-xs">
        <p className="text-faint">Latest run</p>
        {latest ? (
          <>
            <p className="mt-0.5 truncate text-ink">{latest.name}</p>
            <p className="mt-1 flex items-center gap-2 text-muted">
              <RunStatusBadge status={latest.status} />
              {formatRelativeTime(latest.created_at)}
            </p>
          </>
        ) : (
          <p className="mt-0.5 text-muted">No runs yet</p>
        )}
      </div>

      <div>
        <p className="text-xs text-faint">Best score</p>
        <p className="num mt-0.5 text-2xl font-semibold tracking-tight text-ink">
          {formatScore(best?.overall_score)}
        </p>
        {best && (
          <p className="truncate text-xs text-muted" title={best.variant_name}>
            {best.variant_name}
          </p>
        )}
      </div>

      <div>
        <p className="text-xs text-faint">vs baseline</p>
        {suite.delta_vs_baseline !== null && suite.delta_vs_baseline !== undefined ? (
          <Delta
            className="mt-0.5 block text-lg"
            text={formatDelta(suite.delta_vs_baseline)}
            tone={deltaTone(suite.delta_vs_baseline)}
          />
        ) : (
          <p className="mt-0.5 text-xs text-muted">
            {suite.baseline ? "Baseline is latest" : "No baseline set"}
          </p>
        )}
        {suite.baseline && (
          <p className="num text-xs text-muted">
            baseline {formatScore(suite.baseline.overall_score)}
          </p>
        )}
      </div>
    </Link>
  );
}
