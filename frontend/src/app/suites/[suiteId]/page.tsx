"use client";

import { Check, Circle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { RunsTable } from "@/components/runs/runs-table";
import { ButtonLink } from "@/components/ui/button";
import { Delta } from "@/components/ui/delta";
import { Panel } from "@/components/ui/panel";
import { useRuns, useSuite } from "@/lib/api/hooks";
import type { SuiteDetail } from "@/lib/api/types";
import { deltaTone, formatDelta, formatPercent, formatScore } from "@/lib/format";

export default function SuiteOverviewPage() {
  const { suiteId } = useParams<{ suiteId: string }>();
  const { data: suite } = useSuite(suiteId);
  const { data: runs } = useRuns(suiteId);
  if (!suite) return null;

  const ready = suite.test_case_count > 0 && suite.variant_count > 0;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        {!ready || suite.evaluator_count === 0 ? <SetupChecklist suite={suite} /> : <Headline suite={suite} />}
        <Panel
          title="Recent runs"
          flush
          actions={
            suite.run_count > 5 && (
              <Link href={`/suites/${suiteId}/runs`} className="text-xs text-accent">
                All {suite.run_count} runs
              </Link>
            )
          }
        >
          {runs && runs.length > 0 ? (
            <div className="-m-px">
              <RunsTable runs={runs.slice(0, 5)} />
            </div>
          ) : (
            <p className="px-4 py-6 text-center text-xs text-muted">
              No runs yet. Run an evaluation to score your variants.
            </p>
          )}
        </Panel>
      </div>
      <aside className="space-y-6">
        <BaselinePanel suite={suite} />
        <TagPanel suite={suite} />
      </aside>
    </div>
  );
}

function Headline({ suite }: { suite: SuiteDetail }) {
  const best = suite.latest_run?.best;
  if (!suite.latest_run) {
    return (
      <Panel>
        <p className="text-sm text-ink">Everything is configured.</p>
        <p className="mt-1 text-xs text-muted">Run an evaluation to get your first scores.</p>
        <div className="mt-4">
          <ButtonLink href={`/suites/${suite.id}/runs/new`} variant="primary">
            Run evaluation
          </ButtonLink>
        </div>
      </Panel>
    );
  }
  return (
    <Panel>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-xs text-muted">
            Best variant in{" "}
            <Link href={`/runs/${suite.latest_run.id}`} className="text-ink hover:text-accent">
              {suite.latest_run.name}
            </Link>
          </p>
          <p className="num mt-1 text-4xl font-semibold tracking-tight text-ink">
            {formatScore(best?.overall_score)}
          </p>
          <p className="mt-1 text-xs text-muted">
            {best?.variant_name ?? "No scores yet"}
            {best?.pass_rate !== null && best?.pass_rate !== undefined && (
              <> with {formatPercent(best.pass_rate)} of cases passing every check</>
            )}
          </p>
        </div>
        {suite.delta_vs_baseline !== null && suite.delta_vs_baseline !== undefined && (
          <div className="text-right">
            <Delta className="text-3xl" text={formatDelta(suite.delta_vs_baseline)} tone={deltaTone(suite.delta_vs_baseline)} />
            <p className="mt-1 text-xs text-muted">points vs baseline</p>
          </div>
        )}
        <ButtonLink href={`/runs/${suite.latest_run.id}`}>Open results</ButtonLink>
      </div>
    </Panel>
  );
}

function SetupChecklist({ suite }: { suite: SuiteDetail }) {
  const steps = [
    { done: suite.test_case_count > 0, label: "Add test cases", href: "dataset", detail: "Write them by hand or import a JSON file." },
    { done: suite.variant_count > 0, label: "Define a variant", href: "variants", detail: "A provider, a model, and a prompt template." },
    { done: suite.evaluator_count > 0, label: "Add evaluators", href: "evaluators", detail: "Deterministic checks and LLM judges score each output." },
  ];
  return (
    <Panel title="Set up this suite" description="Three steps before the first run.">
      <ol className="space-y-3">
        {steps.map((step) => (
          <li key={step.href} className="flex items-start gap-3">
            {step.done ? (
              <Check size={16} className="mt-0.5 text-good" aria-label="done" />
            ) : (
              <Circle size={16} className="mt-0.5 text-faint" aria-label="to do" />
            )}
            <div>
              <Link href={`/suites/${suite.id}/${step.href}`} className="text-[13px] font-medium text-ink hover:text-accent">
                {step.label}
              </Link>
              <p className="text-xs text-muted">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function BaselinePanel({ suite }: { suite: SuiteDetail }) {
  const baseline = suite.baseline;
  return (
    <Panel title="Baseline" description="New runs are compared against this reference.">
      {baseline ? (
        <div>
          <p className="num text-2xl font-semibold text-ink">{formatScore(baseline.overall_score)}</p>
          <p className="mt-1 text-xs text-muted">{baseline.variant_name}</p>
          <Link href={`/runs/${baseline.run_id}`} className="mt-2 inline-block text-xs text-accent">
            {baseline.run_name}
          </Link>
        </div>
      ) : (
        <p className="text-xs text-muted">
          No baseline yet. Open a completed run and choose <span className="text-ink">Set as baseline</span>.
        </p>
      )}
    </Panel>
  );
}

function TagPanel({ suite }: { suite: SuiteDetail }) {
  const entries = Object.entries(suite.tag_counts);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  return (
    <Panel title="Dataset tags" description="Slices available for analysis.">
      {entries.length === 0 ? (
        <p className="text-xs text-muted">Tag test cases to compare performance by slice.</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map(([tag, count]) => (
            <li key={tag} className="grid grid-cols-[96px_1fr_24px] items-center gap-2 text-xs">
              <Link href={`/suites/${suite.id}/dataset?tag=${encodeURIComponent(tag)}`} className="truncate text-muted hover:text-ink">
                {tag}
              </Link>
              <span className="h-1.5 rounded-full bg-surface-2">
                <span className="block h-full rounded-full bg-neutral-bar" style={{ width: `${(count / max) * 100}%` }} />
              </span>
              <span className="num text-right text-muted">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
