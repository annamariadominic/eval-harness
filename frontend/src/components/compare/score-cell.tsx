import { cn } from "@/lib/cn";

/** Renders an evaluator result compactly: pass/fail for binary checks, 0-100 otherwise. */
export function ScoreValue({
  score,
  passed,
  binary,
  className,
}: {
  score: number | null | undefined;
  passed: boolean | null | undefined;
  binary: boolean;
  className?: string;
}) {
  if (score === null || score === undefined) {
    return <span className={cn("text-faint", className)}>—</span>;
  }
  if (binary) {
    return (
      <span className={cn(passed ? "text-ink" : "text-bad", className)}>
        {passed ? "pass" : "fail"}
      </span>
    );
  }
  return (
    <span className={cn("num", passed === false ? "text-bad" : "text-ink", className)}>
      {(score * 100).toFixed(0)}
    </span>
  );
}
