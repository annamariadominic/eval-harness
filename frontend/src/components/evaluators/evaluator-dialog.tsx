"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Select, TextArea, TextInput } from "@/components/ui/field";
import { ApiError, api, errorMessage } from "@/lib/api/client";
import { useEvaluatorTypes, useProviders } from "@/lib/api/hooks";
import type { Evaluator } from "@/lib/api/types";
import {
  DEFAULT_CONFIGS,
  EVALUATOR_FIELDS,
  type FieldSpec,
  listFromText,
} from "@/lib/evaluator-forms";

type Props = {
  suiteId: string;
  evaluator: Evaluator | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

type Config = Record<string, unknown>;

export function EvaluatorDialog(props: Props) {
  return props.open ? <EvaluatorForm key={props.evaluator?.id ?? "new"} {...props} /> : null;
}

/** Text drafts for fields that are not edited as their stored type (lists, JSON). */
function initialDrafts(type: string, config: Config): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const field of EVALUATOR_FIELDS[type] ?? []) {
    const value = config[field.key];
    if (field.kind === "list") drafts[field.key] = Array.isArray(value) ? value.join("\n") : "";
    if (field.kind === "json") drafts[field.key] = JSON.stringify(value ?? {}, null, 2);
  }
  return drafts;
}

function EvaluatorForm({ suiteId, evaluator, open, onClose, onSaved }: Props) {
  const { data: types } = useEvaluatorTypes();
  const { data: providers } = useProviders();
  const [type, setType] = useState(evaluator?.type ?? "llm_judge");
  const [name, setName] = useState(evaluator?.name ?? "");
  const [threshold, setThreshold] = useState(String(evaluator?.regression_threshold ?? 0.05));
  const [config, setConfig] = useState<Config>(evaluator?.config ?? DEFAULT_CONFIGS[type] ?? {});
  const [drafts, setDrafts] = useState(() => initialDrafts(type, config));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const spec = types?.find((t) => t.type === type);

  function changeType(next: string) {
    setType(next);
    const nextConfig = DEFAULT_CONFIGS[next] ?? {};
    setConfig(nextConfig);
    setDrafts(initialDrafts(next, nextConfig));
    setFieldErrors({});
  }

  function set(key: string, value: unknown) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  function buildConfig(): Config | null {
    const result: Config = { ...config };
    for (const field of EVALUATOR_FIELDS[type] ?? []) {
      if (field.kind === "list")
        result[field.key] = listFromText(drafts[field.key] ?? "", !!field.optional);
      if (field.kind === "json") {
        try {
          result[field.key] = JSON.parse(drafts[field.key] ?? "{}");
        } catch (err) {
          setFieldErrors({ [field.key]: `Invalid JSON: ${(err as Error).message}` });
          return null;
        }
      }
      if (field.kind === "text" && field.optional && result[field.key] === "")
        result[field.key] = null;
    }
    return result;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    const built = buildConfig();
    if (!built) return;
    setSaving(true);
    setError(null);
    try {
      const body = { name, config: built, regression_threshold: Number(threshold) };
      if (evaluator) await api.patch(`/evaluators/${evaluator.id}`, body);
      else await api.post(`/suites/${suiteId}/evaluators`, { ...body, type });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && Array.isArray(err.details)) {
        const mapped: Record<string, string> = {};
        for (const detail of err.details as Array<{ loc?: string[]; message?: string }>) {
          const key = detail.loc?.[0];
          if (key && detail.message) mapped[key] = detail.message;
        }
        setFieldErrors(mapped);
      }
    } finally {
      setSaving(false);
    }
  }

  function renderField(field: FieldSpec) {
    const value = config[field.key];
    const fieldError = fieldErrors[field.key];
    switch (field.kind) {
      case "bool":
        return (
          <Checkbox
            key={field.key}
            label={field.label}
            checked={Boolean(value)}
            onChange={(e) => set(field.key, e.target.checked)}
          />
        );
      case "list":
      case "json":
        return (
          <Field key={field.key} label={field.label} hint={field.hint} error={fieldError}>
            <TextArea
              mono
              rows={field.kind === "json" ? 10 : 3}
              value={drafts[field.key] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [field.key]: e.target.value }))}
            />
          </Field>
        );
      case "textarea":
        return (
          <Field key={field.key} label={field.label} hint={field.hint} error={fieldError}>
            <TextArea
              rows={4}
              value={String(value ?? "")}
              onChange={(e) => set(field.key, e.target.value)}
            />
          </Field>
        );
      case "select":
        return (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <Select value={String(value)} onChange={(e) => set(field.key, e.target.value)}>
              {field.options?.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </Select>
          </Field>
        );
      case "provider":
        return (
          <Field key={field.key} label={field.label} error={fieldError}>
            <Select
              value={String(value)}
              onChange={(e) => {
                set(field.key, e.target.value);
                const next = providers?.find((p) => p.name === e.target.value);
                if (next?.suggested_models[0]) set("model", next.suggested_models[0]);
              }}
            >
              {providers?.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                  {p.configured ? "" : " (no API key)"}
                </option>
              ))}
            </Select>
          </Field>
        );
      case "number":
        return (
          <Field key={field.key} label={field.label} hint={field.hint} error={fieldError}>
            <TextInput
              type="number"
              step={field.step ?? "any"}
              value={value === null || value === undefined ? "" : String(value)}
              onChange={(e) =>
                set(field.key, e.target.value === "" ? null : Number(e.target.value))
              }
            />
          </Field>
        );
      default:
        return (
          <Field key={field.key} label={field.label} hint={field.hint} error={fieldError}>
            <TextInput
              value={String(value ?? "")}
              onChange={(e) => set(field.key, e.target.value)}
            />
          </Field>
        );
    }
  }

  const fields = EVALUATOR_FIELDS[type] ?? [];
  const inputs = fields.filter((f) => f.kind !== "bool");
  const toggles = fields.filter((f) => f.kind === "bool");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={evaluator ? "Edit evaluator" : "New evaluator"}
      description="Evaluators score each output. Past runs keep the configuration they ran with."
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Type" hint={spec?.description}>
            <Select
              value={type}
              onChange={(e) => changeType(e.target.value)}
              disabled={!!evaluator}
            >
              {(types ?? []).map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Correctness"
            />
          </Field>
          <Field label="Regression threshold" hint="Score drop (0-1) that counts as a regression.">
            <TextInput
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {inputs.map((field) => (
            <div
              key={field.key}
              className={
                field.kind === "textarea" || field.kind === "json" ? "sm:col-span-2" : undefined
              }
            >
              {renderField(field)}
            </div>
          ))}
        </div>
        {toggles.length > 0 && (
          <div className="flex flex-wrap gap-x-6 gap-y-2">{toggles.map(renderField)}</div>
        )}
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {evaluator ? "Save changes" : "Create evaluator"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
