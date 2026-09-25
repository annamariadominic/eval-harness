import { ChangeBadge } from "@/components/ui/badge";
import { Delta } from "@/components/ui/delta";
import { Panel } from "@/components/ui/panel";
import type { ArmResult, EvaluatorDelta, ScoreDetail } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { deltaTone, formatCost, formatDelta } from "@/lib/format";

type Row = {
  key: string;
  name: string;
  type: string;
  base?: ScoreDetail;
  target?: ScoreDetail;
  delta?: EvaluatorDelta;
};

function rows(
  base: ArmResult | undefined,
  target: ArmResult | undefined,
  deltas: EvaluatorDelta[],
): Row[] {
  const byKey = new Map<string, Row>();
  for (const [side, result] of [
    ["base", base],
    ["target", target],
  ] as const) {
    for (const score of result?.scores ?? []) {
      const row = byKey.get(score.evaluator_key) ?? {
        key: score.evaluator_key,
        name: score.evaluator_name,
        type: score.evaluator_type,
      };
      row[side] = score;
      byKey.set(score.evaluator_key, row);
    }
  }
  for (const delta of deltas) {
    const row = byKey.get(delta.evaluator_key);
    if (row) row.delta = delta;
  }
  return [...byKey.values()];
}

export function ScoreComparison({
  base,
  target,
  deltas,
}: {
  base: ArmResult | undefined;
  target: ArmResult | undefined;
  deltas: EvaluatorDelta[];
}) {
  const compared = base !== undefined;
  return (
    <Panel
      title="Evaluator scores"
      description="Scores are normalised to 0-100. Judge reasons are shown verbatim."
      flush
    >
      <div className="divide-y divide-line">
        {rows(base, target, deltas).map((row) => (
          <div
            key={row.key}
            className={cn(
              "grid gap-4 px-4 py-3",
              compared
                ? "lg:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)_110px]"
                : "lg:grid-cols-[180px_minmax(0,1fr)]",
            )}
          >
            <div>
              <p className="text-[13px] font-medium text-ink">{row.name}</p>
              <p className="text-xs text-faint">{row.type.replace("_", " ")}</p>
            </div>
            {compared && <ScoreCell label="Reference" score={row.base} />}
            <ScoreCell label={compared ? "Candidate" : "Result"} score={row.target} />
            {compared && (
              <div className="flex items-start gap-2 lg:flex-col lg:items-end">
                {row.delta && (
                  <>
                    <Delta
                      className="text-sm"
                      text={formatDelta(row.delta.delta)}
                      tone={deltaTone(row.delta.delta)}
                    />
                    <ChangeBadge change={row.delta.change} />
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ScoreCell({ label, score }: { label: string; score: ScoreDetail | undefined }) {
  if (!score) return <p className="text-xs text-faint">{label}: not evaluated</p>;
  if (score.status !== "succeeded") {
    return (
      <div className="text-xs">
        <p className="text-faint lg:hidden">{label}</p>
        <p className={score.status === "failed" ? "text-bad" : "text-muted"}>
          {score.status === "failed" ? "Evaluator error" : "Skipped"}:{" "}
          {score.error_message ?? score.reason}
        </p>
      </div>
    );
  }
  const details = score.details as {
    raw_score?: number;
    score_range?: [number, number];
    fields?: Array<{ field: string; expected: unknown; actual: unknown; match: boolean }>;
    violations?: string[];
    missing?: string[];
  };
  return (
    <div className="min-w-0 text-xs">
      <p className="text-faint lg:hidden">{label}</p>
      <p className="flex items-baseline gap-2">
        <span
          className={cn(
            "num text-base font-semibold",
            score.passed === false ? "text-bad" : "text-ink",
          )}
        >
          {score.score === null ? "—" : (score.score * 100).toFixed(0)}
        </span>
        <span className={score.passed ? "text-good" : "text-bad"}>
          {score.passed ? "pass" : "fail"}
        </span>
        {details.raw_score !== undefined && details.score_range && (
          <span className="num text-muted">
            raw {details.raw_score} on {details.score_range[0]}-{details.score_range[1]}
          </span>
        )}
        {score.cost_usd !== null && (
          <span className="num text-faint">{formatCost(score.cost_usd)}</span>
        )}
      </p>
      <p className="mt-1 leading-relaxed break-words text-ink">{score.reason}</p>
      {details.fields && (
        <table className="mt-2 w-full font-mono">
          <tbody>
            {details.fields.map((f) => (
              <tr key={f.field} className={f.match ? "text-muted" : "text-bad"}>
                <td className="pr-2">{f.match ? "=" : "≠"}</td>
                <td className="pr-3">{f.field}</td>
                <td className="truncate pr-3">{JSON.stringify(f.actual)}</td>
                {!f.match && (
                  <td className="truncate text-faint">expected {JSON.stringify(f.expected)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {details.violations && details.violations.length > 1 && (
        <ul className="mt-2 list-disc pl-4 font-mono text-bad">
          {details.violations.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
