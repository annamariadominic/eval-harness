"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Select, TextArea, TextInput } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/api/client";
import { useProviders } from "@/lib/api/hooks";
import type { Variant } from "@/lib/api/types";
import { parseJsonObject } from "@/lib/json-input";

type Props = {
  suiteId: string;
  variant: Variant | null;
  /** Pre-fill a new variant from an existing one. */
  template?: Variant | null;
  inputFields: string[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function VariantDialog(props: Props) {
  const formKey = props.variant?.id ?? `new-${props.template?.id ?? "blank"}`;
  return props.open ? <VariantForm key={formKey} {...props} /> : null;
}

function VariantForm({ suiteId, variant, template, inputFields, open, onClose, onSaved }: Props) {
  const source = variant ?? template ?? null;
  const { data: providers } = useProviders();
  const [name, setName] = useState(variant?.name ?? (template ? `${template.name} (copy)` : ""));
  const [description, setDescription] = useState(source?.description ?? "");
  const [provider, setProvider] = useState(source?.provider ?? "mock");
  const [model, setModel] = useState(source?.model ?? "mock-small");
  const [temperature, setTemperature] = useState(
    source?.temperature === null || source?.temperature === undefined
      ? ""
      : String(source.temperature),
  );
  const [maxTokens, setMaxTokens] = useState(String(source?.max_tokens ?? 1024));
  const [systemPrompt, setSystemPrompt] = useState(source?.system_prompt ?? "");
  const [userTemplate, setUserTemplate] = useState(
    source?.user_template ?? inputFields.map((f) => `${f}: {{ ${f} }}`).join("\n\n"),
  );
  const [settings, setSettings] = useState(
    source && Object.keys(source.settings).length ? JSON.stringify(source.settings, null, 2) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = providers?.find((p) => p.name === provider);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsedSettings = parseJsonObject(settings);
    if (!parsedSettings.ok) return setError(`Settings: ${parsedSettings.error}`);
    const body = {
      name,
      description,
      provider,
      model,
      system_prompt: systemPrompt,
      user_template: userTemplate,
      temperature: temperature.trim() === "" ? null : Number(temperature),
      max_tokens: Number(maxTokens),
      settings: parsedSettings.value,
    };
    setSaving(true);
    setError(null);
    try {
      if (variant) await api.patch(`/variants/${variant.id}`, body);
      else await api.post(`/suites/${suiteId}/variants`, body);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={variant ? "Edit variant" : "New variant"}
      description="A variant is one implementation of the feature: a provider, a model, and prompts. Editing it never changes past runs."
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Candidate · prompt v3"
            />
          </Field>
          <Field label="Description">
            <TextInput
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What changed and why"
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field
            label="Provider"
            error={
              selected && !selected.configured
                ? `Set ${selected.env_var} to run this variant`
                : null
            }
          >
            <Select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                const next = providers?.find((p) => p.name === e.target.value);
                if (next?.suggested_models[0]) setModel(next.suggested_models[0]);
              }}
            >
              {(providers ?? [{ name: "mock", label: "Mock", configured: true }]).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label}
                  {p.configured ? "" : " (no API key)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model">
            <TextInput
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list="model-suggestions"
              required
            />
            <datalist id="model-suggestions">
              {selected?.suggested_models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label="Temperature" hint="Empty uses the provider default.">
            <TextInput
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
            />
          </Field>
          <Field label="Max output tokens">
            <TextInput
              type="number"
              min={1}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              required
            />
          </Field>
        </div>
        <Field label="System prompt">
          <TextArea
            mono
            rows={4}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </Field>
        <Field
          label="User prompt template"
          hint={
            inputFields.length > 0 ? (
              <>
                Available fields:{" "}
                {inputFields.map((f) => (
                  <code
                    key={f}
                    className="mr-1 rounded bg-surface-2 px-1 font-mono"
                  >{`{{ ${f} }}`}</code>
                ))}
                or <code className="rounded bg-surface-2 px-1 font-mono">{"{{ input }}"}</code> for
                the whole input.
              </>
            ) : (
              <>
                Use <code className="rounded bg-surface-2 px-1 font-mono">{"{{ field }}"}</code>{" "}
                placeholders, or{" "}
                <code className="rounded bg-surface-2 px-1 font-mono">{"{{ input }}"}</code> for the
                whole input.
              </>
            )
          }
        >
          <TextArea
            mono
            rows={6}
            value={userTemplate}
            onChange={(e) => setUserTemplate(e.target.value)}
            required
          />
        </Field>
        <Field
          label="Provider settings"
          hint="Optional JSON passed through to the provider, e.g. top_p. The mock provider accepts mock_failure_rate."
        >
          <TextArea
            mono
            rows={3}
            value={settings}
            onChange={(e) => setSettings(e.target.value)}
            placeholder="{}"
          />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {variant ? "Save changes" : "Create variant"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
