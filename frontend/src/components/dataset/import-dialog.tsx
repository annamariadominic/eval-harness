"use client";

import { FileUp } from "lucide-react";
import { useState } from "react";

import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, FormError, TextArea } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/api/client";
import type { DatasetImportResult } from "@/lib/api/types";
import { parseDatasetText } from "@/lib/dataset-import";
import { formatValue } from "@/lib/format";

const EXAMPLE = `{
  "cases": [
    {
      "key": "acme-revenue-2025",
      "input": {
        "question": "What was Acme Corp's 2025 revenue?",
        "context": "Acme Corp reported fiscal 2025 revenue of $4.2B."
      },
      "expected": { "answer": "$4.2 billion" },
      "tags": ["financial", "easy"]
    }
  ]
}`;

export function ImportDialog({
  suiteId,
  open,
  onClose,
  onImported,
}: {
  suiteId: string;
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<DatasetImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setText("");
    setPreview(null);
    setError(null);
    setReplace(false);
  }

  async function send(dryRun: boolean) {
    const parsed = parseDatasetText(text);
    if (!parsed.ok) {
      setPreview(null);
      return setError(parsed.error);
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<DatasetImportResult>(`/suites/${suiteId}/test-cases/import`, {
        cases: parsed.cases,
        mode: replace ? "replace" : "append",
        dry_run: dryRun,
      });
      if (dryRun || !result.valid) {
        setPreview(result);
        return;
      }
      onImported();
      reset();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File) {
    setText(await file.text());
    setPreview(null);
    setError(null);
  }

  const canImport = preview?.valid && !busy;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Import test cases"
      description="Paste JSON or choose a .json / .jsonl file. Nothing is saved until the preview passes validation."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => send(true)} disabled={busy || !text.trim()}>
            Validate and preview
          </Button>
          <Button variant="primary" onClick={() => send(false)} disabled={!canImport}>
            Import {preview?.valid ? preview.total : ""} cases
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-accent">
            <FileUp size={14} />
            Choose file
            <input
              type="file"
              accept=".json,.jsonl,application/json"
              className="sr-only"
              onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
            />
          </label>
          <button
            type="button"
            className="text-xs text-muted hover:text-ink"
            onClick={() => {
              setText(EXAMPLE);
              setPreview(null);
            }}
          >
            Insert example
          </button>
        </div>
        <TextArea
          mono
          rows={10}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          placeholder={EXAMPLE}
          aria-label="Dataset JSON"
        />
        <Checkbox
          label="Replace the existing dataset (past runs keep their own snapshot)"
          checked={replace}
          onChange={(e) => {
            setReplace(e.target.checked);
            setPreview(null);
          }}
        />
        <FormError message={error} />
        {preview && <ImportPreview result={preview} />}
      </div>
    </Dialog>
  );
}

function ImportPreview({ result }: { result: DatasetImportResult }) {
  if (!result.valid) {
    return (
      <div className="rounded-md border border-bad/30 bg-bad-soft/50 p-3">
        <p className="text-[13px] font-medium text-bad">
          {result.errors.length} problem{result.errors.length === 1 ? "" : "s"} found. Fix them and
          validate again.
        </p>
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs">
          {result.errors.map((issue, i) => (
            <li key={i} className="font-mono">
              <span className="text-muted">case {issue.index}</span>
              {issue.field && <span className="text-ink"> · {issue.field}</span>}
              <span className="text-bad">: {issue.message}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-line p-3">
      <p className="text-[13px] text-ink">
        {result.total} valid case{result.total === 1 ? "" : "s"}
        {result.mode === "replace" && ", replacing the current dataset"}.
      </p>
      {Object.keys(result.tag_counts).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {Object.entries(result.tag_counts).map(([tag, count]) => (
            <Tag key={tag}>
              {tag} <span className="num ml-1 text-faint">{count}</span>
            </Tag>
          ))}
        </div>
      )}
      <ul className="mt-3 max-h-56 divide-y divide-line overflow-y-auto border-t border-line text-xs">
        {result.preview.map((item, i) => (
          <li key={i} className="grid grid-cols-[120px_1fr] gap-3 py-1.5">
            <span className="truncate text-muted">{item.key ?? `case ${i}`}</span>
            <span className="truncate font-mono text-ink">
              {formatValue(item.input).replace(/\s+/g, " ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
