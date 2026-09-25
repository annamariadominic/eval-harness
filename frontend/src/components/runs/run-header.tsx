"use client";

import { Flag, RotateCw, Square, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { mutate } from "swr";

import { Badge, RunStatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { RunProgressBar } from "@/components/ui/progress";
import { api, errorMessage } from "@/lib/api/client";
import { keys } from "@/lib/api/hooks";
import { ACTIVE_RUN_STATUSES, type RunDetail } from "@/lib/api/types";
import { formatDateTime, formatDuration } from "@/lib/format";

export function RunHeader({ run }: { run: RunDetail }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosingBaseline, setChoosingBaseline] = useState(false);
  const active = ACTIVE_RUN_STATUSES.has(run.status);
  const { progress } = run;
  const done = progress.succeeded + progress.failed + progress.cancelled;
  const unfinished = progress.cancelled + progress.pending + progress.running;

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([
        mutate(keys.run(run.id)),
        mutate(keys.suite(run.suite_id)),
        mutate(keys.suiteRuns(run.suite_id)),
        mutate(keys.runs),
      ]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function setBaseline(runVariantId: string) {
    await act(() =>
      api.put(`/suites/${run.suite_id}/baseline`, {
        run_id: run.id,
        run_variant_id: runVariantId,
      }),
    );
    setChoosingBaseline(false);
  }

  async function remove() {
    if (!window.confirm(`Delete run "${run.name}" and all of its results?`)) return;
    await act(() => api.delete(`/runs/${run.id}`));
    router.push(`/suites/${run.suite_id}/runs`);
  }

  return (
    <>
      <PageHeader
        breadcrumb={[
          { href: "/suites", label: "Suites" },
          { href: `/suites/${run.suite_id}`, label: run.suite_name },
          { href: `/suites/${run.suite_id}/runs`, label: "Runs" },
        ]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {run.name}
            <RunStatusBadge status={run.status} />
            {run.is_baseline && <Badge tone="accent">baseline</Badge>}
          </span>
        }
        description={
          <span className="num">
            {run.case_count} cases × {run.variants.length} variant
            {run.variants.length === 1 ? "" : "s"}, {run.evaluators.length} evaluators. Started{" "}
            {formatDateTime(run.started_at ?? run.created_at)}
            {run.finished_at && `, took ${formatDuration(run.started_at, run.finished_at)}`}.
          </span>
        }
        actions={
          <>
            {active && (
              <Button
                icon={<Square size={12} />}
                disabled={busy}
                onClick={() => act(() => api.post(`/runs/${run.id}/cancel`))}
              >
                Cancel run
              </Button>
            )}
            {!active && unfinished > 0 && (
              <Button
                icon={<RotateCw size={13} />}
                disabled={busy}
                onClick={() =>
                  act(() => api.post(`/runs/${run.id}/resume`, { retry_failed: false }))
                }
              >
                Resume
              </Button>
            )}
            {!active && progress.failed > 0 && (
              <Button
                icon={<RotateCw size={13} />}
                disabled={busy}
                onClick={() =>
                  act(() => api.post(`/runs/${run.id}/resume`, { retry_failed: true }))
                }
              >
                Retry {progress.failed} failed
              </Button>
            )}
            {run.status === "completed" && (
              <Button
                icon={<Flag size={13} />}
                disabled={busy}
                onClick={() =>
                  run.variants.length === 1
                    ? setBaseline(run.variants[0].id)
                    : setChoosingBaseline(true)
                }
              >
                {run.is_baseline ? "Change baseline variant" : "Set as baseline"}
              </Button>
            )}
            {!active && (
              <Button
                variant="ghost"
                aria-label="Delete run"
                title="Delete run"
                disabled={busy}
                onClick={remove}
              >
                <Trash2 size={14} />
              </Button>
            )}
          </>
        }
      />

      {(active || run.status === "interrupted" || run.error) && (
        <div className="mb-6 rounded-lg border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-ink">
              {active ? "Running" : "Stopped"}: <span className="num">{done}</span> of{" "}
              <span className="num">{progress.total}</span> generations finished
              {progress.running > 0 && (
                <span className="text-muted">, {progress.running} in flight</span>
              )}
            </span>
            <span className="num text-muted">
              {progress.failed > 0 && <span className="text-bad">{progress.failed} failed</span>}
            </span>
          </div>
          <RunProgressBar progress={progress} />
          {run.error && <p className="mt-2 text-xs text-warn">{run.error}</p>}
        </div>
      )}
      <FormError message={error} />

      {choosingBaseline && (
        <BaselineDialog
          run={run}
          onClose={() => setChoosingBaseline(false)}
          onChoose={setBaseline}
          busy={busy}
        />
      )}
    </>
  );
}

function BaselineDialog({
  run,
  onClose,
  onChoose,
  busy,
}: {
  run: RunDetail;
  onClose: () => void;
  onChoose: (runVariantId: string) => void;
  busy: boolean;
}) {
  const [choice, setChoice] = useState(run.baseline_run_variant_id ?? run.variants[0]?.id ?? "");
  return (
    <Dialog
      open
      onClose={onClose}
      title="Set baseline"
      description="Future runs in this suite are compared against the chosen variant's results from this run."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !choice} onClick={() => onChoose(choice)}>
            Set as baseline
          </Button>
        </>
      }
    >
      <Select
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        aria-label="Baseline variant"
      >
        {run.variants.map((variant) => (
          <option key={variant.id} value={variant.id}>
            {variant.name}
          </option>
        ))}
      </Select>
    </Dialog>
  );
}
