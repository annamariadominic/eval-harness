import { RunStatusBadge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/ui/code-block";
import type { ArmResult } from "@/lib/api/types";
import { formatCost, formatLatency, formatTokens } from "@/lib/format";

export function OutputPanel({ role, result }: { role: string; result: ArmResult | undefined }) {
  if (!result) {
    return (
      <section className="rounded-lg border border-dashed border-line-strong p-4 text-xs text-muted">
        {role}: this case was not part of that run.
      </section>
    );
  }
  const { arm } = result;
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-line bg-surface">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">{role}</p>
          <p className="truncate font-semibold text-ink">{arm.variant_name}</p>
          <p className="truncate font-mono text-xs text-muted">
            {arm.provider}/{result.response_model ?? arm.model} · {arm.run_name}
          </p>
        </div>
        {result.status !== "succeeded" && <RunStatusBadge status={result.status} />}
      </header>
      <div className="flex-1 p-4">
        {result.status === "failed" ? (
          <div role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-xs text-bad">
            <p className="font-medium">Generation failed ({result.error_type})</p>
            <p className="mt-1 font-mono break-words">{result.error_message}</p>
          </div>
        ) : (
          <CodeBlock value={result.output ?? ""} maxHeight="max-h-96" />
        )}
      </div>
      <dl className="num grid grid-cols-3 gap-x-4 gap-y-2 border-t border-line px-4 py-3 text-xs sm:grid-cols-5">
        <Stat label="Latency" value={formatLatency(result.latency_ms)} />
        <Stat label="Input tokens" value={formatTokens(result.input_tokens)} />
        <Stat label="Output tokens" value={formatTokens(result.output_tokens)} />
        <Stat label="Est. cost" value={formatCost(result.cost_usd)} />
        <Stat
          label="Attempts"
          value={String(result.attempts)}
          warn={result.attempts > 1}
          title={result.attempts > 1 ? "Transient failures were retried" : undefined}
        />
      </dl>
    </section>
  );
}

function Stat({
  label,
  value,
  warn,
  title,
}: {
  label: string;
  value: string;
  warn?: boolean;
  title?: string;
}) {
  return (
    <div title={title}>
      <dt className="text-faint">{label}</dt>
      <dd className={warn ? "text-warn" : "text-ink"}>{value}</dd>
    </div>
  );
}
