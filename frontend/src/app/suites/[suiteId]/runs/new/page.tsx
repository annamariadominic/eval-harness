"use client";

import { Play } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { mutate } from "swr";

import { Badge, Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingRows } from "@/components/ui/empty-state";
import { Field, FormError, TextInput } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { api, errorMessage } from "@/lib/api/client";
import {
  keys,
  useEvaluators,
  useProviders,
  useSuite,
  useTestCases,
  useVariants,
} from "@/lib/api/hooks";
import type { RunDetail } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { describeEvaluator } from "@/lib/evaluator-forms";
import { planRun } from "@/lib/run-plan";

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export default function NewRunPage() {
  const { suiteId } = useParams<{ suiteId: string }>();
  const router = useRouter();
  const { data: suite } = useSuite(suiteId);
  const { data: cases } = useTestCases(suiteId);
  const { data: variants } = useVariants(suiteId);
  const { data: evaluators } = useEvaluators(suiteId);
  const { data: providers } = useProviders();

  const configured = useMemo(
    () => new Set(providers?.filter((p) => p.configured).map((p) => p.name)),
    [providers],
  );

  // null means "untouched": default to every runnable variant and every evaluator.
  const [variantIds, setVariantIds] = useState<string[] | null>(null);
  const [evaluatorIds, setEvaluatorIds] = useState<string[] | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [concurrency, setConcurrency] = useState("4");
  const [maxAttempts, setMaxAttempts] = useState("3");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  if (!suite || !cases || !variants || !evaluators || !providers) return <LoadingRows rows={4} />;

  const runnable = (provider: string) => configured.has(provider);
  const judgeProvider = (config: Record<string, unknown>) => String(config.provider ?? "");
  const selectedVariants =
    variantIds ?? variants.filter((v) => runnable(v.provider)).map((v) => v.id);
  const selectedEvaluators =
    evaluatorIds ??
    evaluators
      .filter((e) => e.type !== "llm_judge" || runnable(judgeProvider(e.config)))
      .map((e) => e.id);

  const plan = planRun({
    cases,
    tagFilter: tags,
    variantCount: selectedVariants.length,
    evaluatorTypes: evaluators.filter((e) => selectedEvaluators.includes(e.id)).map((e) => e.type),
  });

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const run = await api.post<RunDetail>(`/suites/${suiteId}/runs`, {
        name: name.trim() || null,
        variant_ids: selectedVariants,
        evaluator_ids: selectedEvaluators,
        tags: tags.length ? tags : null,
        concurrency: Number(concurrency),
        max_attempts: Number(maxAttempts),
      });
      await Promise.all([mutate(keys.suite(suiteId)), mutate(keys.suiteRuns(suiteId))]);
      router.push(`/runs/${run.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setStarting(false);
    }
  }

  const allTags = Object.keys(suite.tag_counts);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-6">
        <Panel
          title="Variants"
          description="Each selected variant runs against the same test cases."
        >
          {variants.length === 0 ? (
            <p className="text-xs text-muted">
              No variants yet.{" "}
              <Link href={`/suites/${suiteId}/variants`} className="text-accent">
                Create one
              </Link>
              .
            </p>
          ) : (
            <ul className="space-y-1">
              {variants.map((variant) => {
                const ok = runnable(variant.provider);
                const provider = providers.find((p) => p.name === variant.provider);
                return (
                  <li key={variant.id}>
                    <label
                      className={cn(
                        "flex items-center gap-3 rounded-md px-2 py-1.5",
                        ok ? "cursor-pointer hover:bg-surface-2" : "opacity-60",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[var(--accent)]"
                        disabled={!ok}
                        checked={selectedVariants.includes(variant.id)}
                        onChange={() => setVariantIds(toggle(selectedVariants, variant.id))}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                        {variant.name}
                      </span>
                      <span className="font-mono text-xs text-muted">{variant.model}</span>
                      {!ok && <Badge tone="warn">set {provider?.env_var}</Badge>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Evaluators" description="Scores are computed for every generated output.">
          {evaluators.length === 0 ? (
            <p className="text-xs text-muted">
              No evaluators. The run will record outputs and operational metrics only.
            </p>
          ) : (
            <ul className="space-y-1">
              {evaluators.map((evaluator) => {
                const ok =
                  evaluator.type !== "llm_judge" || runnable(judgeProvider(evaluator.config));
                return (
                  <li key={evaluator.id}>
                    <label
                      className={cn(
                        "flex items-center gap-3 rounded-md px-2 py-1.5",
                        ok ? "cursor-pointer hover:bg-surface-2" : "opacity-60",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[var(--accent)]"
                        disabled={!ok}
                        checked={selectedEvaluators.includes(evaluator.id)}
                        onChange={() => setEvaluatorIds(toggle(selectedEvaluators, evaluator.id))}
                      />
                      <span className="w-40 shrink-0 truncate text-[13px] text-ink">
                        {evaluator.name}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">
                        {describeEvaluator(evaluator.type, evaluator.config)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title="Test cases"
          description="Run the whole dataset, or only cases carrying any of the selected tags."
        >
          {allTags.length === 0 ? (
            <p className="text-xs text-muted">All {cases.length} cases will run.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={tags.includes(tag)}
                  onClick={() => setTags(toggle(tags, tag))}
                >
                  <Tag active={tags.includes(tag)}>
                    {tag} <span className="num ml-1 text-faint">{suite.tag_counts[tag]}</span>
                  </Tag>
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <aside className="space-y-4">
        <Panel title="Run">
          <div className="space-y-4">
            <Field label="Name" hint="Optional. Defaults to the next run number.">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Prompt v3 candidate"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Concurrency" hint="Parallel requests.">
                <TextInput
                  type="number"
                  min={1}
                  max={32}
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                />
              </Field>
              <Field label="Attempts" hint="Per request.">
                <TextInput
                  type="number"
                  min={1}
                  max={6}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(e.target.value)}
                />
              </Field>
            </div>
            <dl className="num space-y-1 border-t border-line pt-3 text-xs">
              <PlanRow label="Test cases" value={plan.caseIds.length} />
              <PlanRow label="Generations" value={plan.generations} />
              <PlanRow label="Evaluations" value={plan.evaluations} />
              <PlanRow label="Judge model calls" value={plan.judgeCalls} />
            </dl>
            <FormError message={error} />
            <Button
              variant="primary"
              className="w-full"
              icon={<Play size={13} />}
              disabled={starting || plan.generations === 0}
              onClick={start}
            >
              {starting ? "Starting" : "Run evaluation"}
            </Button>
            {plan.generations === 0 && (
              <p className="text-xs text-muted">Select at least one variant and one test case.</p>
            )}
          </div>
        </Panel>
      </aside>
    </div>
  );
}

function PlanRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}
