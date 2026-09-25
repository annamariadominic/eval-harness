"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { mutate } from "swr";

import { EvaluatorDialog } from "@/components/evaluators/evaluator-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorNotice, LoadingRows } from "@/components/ui/empty-state";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useEvaluatorTypes, useEvaluators } from "@/lib/api/hooks";
import type { Evaluator } from "@/lib/api/types";
import { describeEvaluator } from "@/lib/evaluator-forms";

export default function EvaluatorsPage() {
  const { suiteId } = useParams<{ suiteId: string }>();
  const { data: evaluators, error } = useEvaluators(suiteId);
  const { data: types } = useEvaluatorTypes();
  const [editing, setEditing] = useState<Evaluator | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = () =>
    Promise.all([mutate(keys.evaluators(suiteId)), mutate(keys.suite(suiteId))]);

  async function remove(evaluator: Evaluator) {
    if (!window.confirm(`Delete evaluator "${evaluator.name}"? Past runs keep their scores.`))
      return;
    try {
      await api.delete(`/evaluators/${evaluator.id}`);
      await refresh();
    } catch (err) {
      window.alert(errorMessage(err));
    }
  }

  if (error) return <ErrorNotice error={error} />;
  if (!evaluators) return <LoadingRows />;
  const typeInfo = new Map(types?.map((t) => [t.type, t]) ?? []);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-muted">
          Deterministic checks are free and exact. LLM judges grade against a rubric and explain
          every score.
        </p>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          New evaluator
        </Button>
      </div>
      {evaluators.length === 0 ? (
        <EmptyState
          title="No evaluators yet"
          description="Without evaluators a run still records outputs, latency, tokens, and cost, but nothing is scored."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              New evaluator
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Evaluator</th>
                <th className="px-4 py-2 font-medium">Checks</th>
                <th className="px-4 py-2 font-medium">Scoring</th>
                <th
                  className="px-4 py-2 text-right font-medium"
                  title="Score drop that counts as a regression"
                >
                  Regression at
                </th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {evaluators.map((evaluator) => {
                const info = typeInfo.get(evaluator.type);
                return (
                  <tr key={evaluator.id} className="group align-top hover:bg-surface-2/50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{evaluator.name}</p>
                      <div className="mt-1 flex gap-1.5">
                        <Badge tone={info?.kind === "llm" ? "accent" : "neutral"}>
                          {info?.label ?? evaluator.type}
                        </Badge>
                      </div>
                    </td>
                    <td className="max-w-lg px-4 py-3 text-xs text-muted">
                      <p>{describeEvaluator(evaluator.type, evaluator.config)}</p>
                      {evaluator.type === "llm_judge" && (
                        <p className="mt-1 line-clamp-2 text-faint">
                          {String(evaluator.config.criteria ?? "")}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {info?.scoring === "binary"
                        ? "pass / fail"
                        : info?.scoring === "graded"
                          ? "graded 0-1"
                          : "fraction 0-1"}
                    </td>
                    <td className="num px-4 py-3 text-right text-xs text-muted">
                      −{(evaluator.regression_threshold * 100).toFixed(0)} pts
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex justify-end opacity-60 group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Edit evaluator"
                          onClick={() => setEditing(evaluator)}
                        >
                          <Pencil size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Delete evaluator"
                          onClick={() => remove(evaluator)}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <EvaluatorDialog
        suiteId={suiteId}
        evaluator={editing}
        open={creating || editing !== null}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={refresh}
      />
    </>
  );
}
