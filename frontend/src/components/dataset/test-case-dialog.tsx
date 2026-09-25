"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, TextArea, TextInput } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/api/client";
import type { TestCase } from "@/lib/api/types";
import { parseJsonObject, parseLooseValue, parseTagList, toEditorText } from "@/lib/json-input";

type Props = {
  suiteId: string;
  testCase: TestCase | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function TestCaseDialog(props: Props) {
  // Remount the form whenever a different case is opened so fields reset cleanly.
  return props.open ? <TestCaseForm key={props.testCase?.id ?? "new"} {...props} /> : null;
}

function TestCaseForm({ suiteId, testCase, open, onClose, onSaved }: Props) {
  const [key, setKey] = useState(testCase?.key ?? "");
  const [input, setInput] = useState(toEditorText(testCase?.input));
  const [expected, setExpected] = useState(toEditorText(testCase?.expected));
  const [tags, setTags] = useState((testCase?.tags ?? []).join(", "));
  const [metadata, setMetadata] = useState(
    testCase && Object.keys(testCase.metadata ?? {}).length
      ? JSON.stringify(testCase.metadata, null, 2)
      : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsedInput = parseLooseValue(input);
    const parsedExpected = parseLooseValue(expected);
    const parsedMetadata = parseJsonObject(metadata);
    if (!parsedInput.ok) return setError(`Input: ${parsedInput.error}`);
    if (parsedInput.value === null) return setError("Input is required");
    if (!parsedExpected.ok) return setError(`Expected output: ${parsedExpected.error}`);
    if (!parsedMetadata.ok) return setError(`Metadata: ${parsedMetadata.error}`);

    const body = {
      key: key.trim() || null,
      input: parsedInput.value,
      expected: parsedExpected.value,
      tags: parseTagList(tags),
      metadata: parsedMetadata.value,
    };
    setSaving(true);
    setError(null);
    try {
      if (testCase) await api.patch(`/test-cases/${testCase.id}`, body);
      else await api.post(`/suites/${suiteId}/test-cases`, body);
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
      title={testCase ? "Edit test case" : "New test case"}
      description="Input and expected output accept plain text or JSON. JSON objects expose their fields to prompt templates as {{ field }}."
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Key" hint="Optional readable identifier, unique within the suite.">
            <TextInput
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="acme-revenue-2025"
            />
          </Field>
          <Field label="Tags" hint="Comma separated. Used for sliced analysis.">
            <TextInput
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="financial, hard"
            />
          </Field>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Field label="Input">
            <TextArea
              mono
              rows={12}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={'{\n  "question": "...",\n  "context": "..."\n}'}
              required
            />
          </Field>
          <Field label="Expected output" hint="Leave empty if no evaluator needs a reference.">
            <TextArea
              mono
              rows={12}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder={'{\n  "answer": "..."\n}'}
            />
          </Field>
        </div>
        <Field label="Metadata" hint="Optional JSON object stored with the case.">
          <TextArea mono rows={3} value={metadata} onChange={(e) => setMetadata(e.target.value)} />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {testCase ? "Save changes" : "Add test case"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
