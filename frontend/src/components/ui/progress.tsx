import type { RunProgress } from "@/lib/api/types";

export function RunProgressBar({ progress }: { progress: RunProgress }) {
  const { total, succeeded, failed, cancelled } = progress;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  const done = succeeded + failed + cancelled;
  return (
    <div className="w-full">
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div className="bg-accent" style={{ width: `${pct(succeeded)}%` }} />
        <div className="bg-bad" style={{ width: `${pct(failed)}%` }} />
        <div className="bg-warn" style={{ width: `${pct(cancelled)}%` }} />
      </div>
    </div>
  );
}
