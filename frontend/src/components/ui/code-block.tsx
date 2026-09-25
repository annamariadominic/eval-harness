import { cn } from "@/lib/cn";
import { formatValue } from "@/lib/format";

export function CodeBlock({
  value,
  className,
  maxHeight = "max-h-80",
}: {
  value: unknown;
  className?: string;
  maxHeight?: string;
}) {
  const text = formatValue(value);
  return (
    <pre
      className={cn(
        "overflow-auto rounded-md border border-line bg-surface-2 px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-ink",
        maxHeight,
        className,
      )}
    >
      {text || <span className="text-faint">(empty)</span>}
    </pre>
  );
}
