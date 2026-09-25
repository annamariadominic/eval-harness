import { CodeBlock } from "@/components/ui/code-block";

/**
 * Objects are shown field by field so long strings (contexts, documents) keep their real line
 * breaks instead of appearing as escaped JSON. Anything else falls back to a code block.
 */
export function StructuredValue({ value }: { value: unknown }) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return <CodeBlock value={value} />;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <dl className="space-y-3">
      {entries.map(([key, field]) => (
        <div key={key}>
          <dt className="mb-1 font-mono text-xs text-faint">{key}</dt>
          <dd>
            <CodeBlock value={field} maxHeight="max-h-64" />
          </dd>
        </div>
      ))}
    </dl>
  );
}
