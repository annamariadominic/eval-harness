"use client";

import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { mutate } from "swr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorNotice, LoadingRows } from "@/components/ui/empty-state";
import { VariantDialog } from "@/components/variants/variant-dialog";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useProviders, useTestCases, useVariants } from "@/lib/api/hooks";
import type { Variant } from "@/lib/api/types";

export default function VariantsPage() {
  const { suiteId } = useParams<{ suiteId: string }>();
  const { data: variants, error } = useVariants(suiteId);
  const { data: cases } = useTestCases(suiteId);
  const { data: providers } = useProviders();
  const [editing, setEditing] = useState<Variant | null>(null);
  const [template, setTemplate] = useState<Variant | null>(null);
  const [creating, setCreating] = useState(false);

  const inputFields = useMemo(() => {
    const first = cases?.find(
      (c) => c.input && typeof c.input === "object" && !Array.isArray(c.input),
    );
    return first ? Object.keys(first.input as Record<string, unknown>) : [];
  }, [cases]);

  const refresh = () => Promise.all([mutate(keys.variants(suiteId)), mutate(keys.suite(suiteId))]);

  async function remove(variant: Variant) {
    if (!window.confirm(`Delete variant "${variant.name}"? Past runs keep their snapshot.`)) return;
    try {
      await api.delete(`/variants/${variant.id}`);
      await refresh();
    } catch (err) {
      window.alert(errorMessage(err));
    }
  }

  if (error) return <ErrorNotice error={error} />;
  if (!variants) return <LoadingRows />;
  const configured = new Map(providers?.map((p) => [p.name, p]) ?? []);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-muted">
          Every selected variant runs against the same test cases.
        </p>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          New variant
        </Button>
      </div>
      {variants.length === 0 ? (
        <EmptyState
          title="No variants yet"
          description="Add at least one variant, typically your current prompt as the baseline and a candidate to compare."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              New variant
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {variants.map((variant) => {
            const provider = configured.get(variant.provider);
            return (
              <article
                key={variant.id}
                className="flex flex-col rounded-lg border border-line bg-surface"
              >
                <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-ink">{variant.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <Badge
                        tone={provider?.configured ? "neutral" : "warn"}
                        title={provider?.configured ? undefined : `Set ${provider?.env_var} to run`}
                      >
                        {provider?.label ?? variant.provider}
                        {!provider?.configured && " · no key"}
                      </Badge>
                      <span className="font-mono text-muted">{variant.model}</span>
                      <span className="text-faint">
                        temp {variant.temperature ?? "default"}, max {variant.max_tokens} tokens
                      </span>
                    </div>
                    {variant.description && (
                      <p className="mt-1.5 text-xs text-muted">{variant.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Duplicate variant"
                      title="Duplicate"
                      onClick={() => {
                        setTemplate(variant);
                        setCreating(true);
                      }}
                    >
                      <Copy size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Edit variant"
                      onClick={() => setEditing(variant)}
                    >
                      <Pencil size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Delete variant"
                      onClick={() => remove(variant)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </header>
                <div className="grid gap-3 p-4 text-xs">
                  <PromptBlock label="System" text={variant.system_prompt} />
                  <PromptBlock label="User template" text={variant.user_template} />
                </div>
              </article>
            );
          })}
        </div>
      )}
      <VariantDialog
        suiteId={suiteId}
        variant={editing}
        template={template}
        inputFields={inputFields}
        open={creating || editing !== null}
        onClose={() => {
          setCreating(false);
          setEditing(null);
          setTemplate(null);
        }}
        onSaved={refresh}
      />
    </>
  );
}

function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="mb-1 text-faint">{label}</p>
      <pre className="max-h-32 overflow-auto rounded-md bg-surface-2 px-3 py-2 font-mono leading-relaxed whitespace-pre-wrap text-ink">
        {text || <span className="text-faint">(none)</span>}
      </pre>
    </div>
  );
}
