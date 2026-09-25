import { Badge } from "@/components/ui/badge";
import { Delta } from "@/components/ui/delta";
import { Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import type { ComparisonReport } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { deltaTone, formatDelta, formatScore } from "@/lib/format";

export function SliceTable({
  report,
  sliceEvaluator,
  onSliceEvaluator,
  activeTag,
  onSelectTag,
}: {
  report: ComparisonReport;
  sliceEvaluator: string | null;
  onSliceEvaluator: (key: string | null) => void;
  activeTag: string | null;
  onSelectTag: (tag: string | null) => void;
}) {
  const single = !report.base;
  const maxDelta = Math.max(0.05, ...report.slices.map((s) => Math.abs(s.delta ?? 0)));

  return (
    <Panel
      title="Performance by slice"
      description="Each tag's cases scored separately. A case can belong to several slices."
      flush
      actions={
        <Select
          className="w-44"
          value={sliceEvaluator ?? ""}
          onChange={(e) => onSliceEvaluator(e.target.value || null)}
          aria-label="Slice metric"
        >
          <option value="">Overall score</option>
          {report.evaluators.map((e) => (
            <option key={e.key} value={e.key}>
              {e.name}
            </option>
          ))}
        </Select>
      }
    >
      {report.slices.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted">
          Tag test cases to analyse slices.
        </p>
      ) : (
        <table className="num w-full text-[13px]">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 text-left font-medium">Tag</th>
              <th className="px-2 py-2 text-right font-medium">Cases</th>
              {!single && <th className="px-2 py-2 text-right font-medium">Reference</th>}
              <th className="px-2 py-2 text-right font-medium">Candidate</th>
              {!single && <th className="px-2 py-2 text-right font-medium">Δ</th>}
              {!single && <th className="w-28 px-4 py-2" aria-label="Change" />}
            </tr>
          </thead>
          <tbody>
            {report.slices.map((slice) => {
              const width = slice.delta === null ? 0 : (Math.abs(slice.delta) / maxDelta) * 50;
              const active = activeTag === slice.tag;
              return (
                <tr
                  key={slice.tag}
                  className={cn(
                    "cursor-pointer hover:bg-surface-2/50",
                    active && "bg-accent-soft/60",
                  )}
                  onClick={() => onSelectTag(active ? null : slice.tag)}
                >
                  <td className="px-4 py-1.5">
                    <span className={active ? "font-medium text-accent" : "text-ink"}>
                      {slice.tag}
                    </span>
                    {slice.hidden_regression ? (
                      <Badge
                        tone="bad"
                        className="ml-2"
                        title="This slice regressed while the aggregate improved"
                      >
                        hidden regression
                      </Badge>
                    ) : (
                      slice.regressed_slice && (
                        <Badge tone="bad" className="ml-2">
                          regressed
                        </Badge>
                      )
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted">{slice.cases}</td>
                  {!single && (
                    <td className="px-2 py-1.5 text-right text-muted">
                      {formatScore(slice.base_score)}
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-right text-ink">
                    {formatScore(slice.target_score)}
                  </td>
                  {!single && (
                    <td className="px-2 py-1.5 text-right">
                      <Delta text={formatDelta(slice.delta)} tone={deltaTone(slice.delta)} />
                    </td>
                  )}
                  {!single && (
                    <td className="px-4 py-1.5">
                      {/* Diverging bar centred on zero: left is worse, right is better. */}
                      <div className="relative h-2 rounded-sm bg-surface-2" aria-hidden>
                        <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
                        {slice.delta !== null && (
                          <span
                            className={cn(
                              "absolute inset-y-0 rounded-sm",
                              slice.delta >= 0 ? "left-1/2 bg-good" : "right-1/2 bg-bad",
                            )}
                            style={{ width: `${width}%` }}
                          />
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
