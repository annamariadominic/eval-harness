"use client";

import { Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { mutate } from "swr";

import { ImportDialog } from "@/components/dataset/import-dialog";
import { TestCaseDialog } from "@/components/dataset/test-case-dialog";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorNotice, LoadingRows } from "@/components/ui/empty-state";
import { TextInput } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useSuite, useTestCases } from "@/lib/api/hooks";
import type { TestCase } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatValue } from "@/lib/format";

export default function DatasetPage() {
  return (
    <Suspense fallback={<LoadingRows />}>
      <Dataset />
    </Suspense>
  );
}

function preview(value: unknown): string {
  return formatValue(value).replace(/\s+/g, " ").slice(0, 220);
}

function Dataset() {
  const { suiteId } = useParams<{ suiteId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTag = searchParams.get("tag");
  const { data: suite } = useSuite(suiteId);
  const { data: cases, error } = useTestCases(suiteId);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<TestCase | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const refresh = () => Promise.all([mutate(keys.testCases(suiteId)), mutate(keys.suite(suiteId))]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (cases ?? []).filter(
      (c) =>
        (!activeTag || c.tags.includes(activeTag)) &&
        (!needle ||
          (c.key ?? "").toLowerCase().includes(needle) ||
          formatValue(c.input).toLowerCase().includes(needle) ||
          formatValue(c.expected).toLowerCase().includes(needle)),
    );
  }, [cases, activeTag, search]);

  function selectTag(tag: string | null) {
    router.replace(
      tag
        ? `/suites/${suiteId}/dataset?tag=${encodeURIComponent(tag)}`
        : `/suites/${suiteId}/dataset`,
    );
  }

  async function remove(testCase: TestCase) {
    if (
      !window.confirm(`Delete test case ${testCase.key ?? testCase.id}? Past runs keep their copy.`)
    )
      return;
    try {
      await api.delete(`/test-cases/${testCase.id}`);
      await refresh();
    } catch (err) {
      window.alert(errorMessage(err));
    }
  }

  if (error) return <ErrorNotice error={error} />;
  if (!cases) return <LoadingRows />;

  const tags = Object.keys(suite?.tag_counts ?? {});
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            className="w-64"
            placeholder="Search inputs, outputs, keys"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search test cases"
          />
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by tag">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => selectTag(activeTag === tag ? null : tag)}
                  aria-pressed={activeTag === tag}
                >
                  <Tag active={activeTag === tag}>{tag}</Tag>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button icon={<Upload size={13} />} onClick={() => setImporting(true)}>
            Import JSON
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
            Add test case
          </Button>
        </div>
      </div>

      {cases.length === 0 ? (
        <EmptyState
          title="This suite has no test cases"
          description="Each case is an input, an optional expected output, and tags for sliced analysis."
          action={
            <div className="flex gap-2">
              <Button onClick={() => setImporting(true)}>Import JSON</Button>
              <Button variant="primary" onClick={() => setCreating(true)}>
                Add test case
              </Button>
            </div>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full table-fixed text-left text-[13px]">
            <colgroup>
              <col className="w-44" />
              <col />
              <col className="w-64" />
              <col className="w-44" />
              <col className="w-20" />
            </colgroup>
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Key</th>
                <th className="px-4 py-2 font-medium">Input</th>
                <th className="px-4 py-2 font-medium">Expected</th>
                <th className="px-4 py-2 font-medium">Tags</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.map((testCase) => (
                <tr key={testCase.id} className="group align-top hover:bg-surface-2/50">
                  <td
                    className="truncate px-4 py-2.5 font-medium text-ink"
                    title={testCase.key ?? testCase.id}
                  >
                    {testCase.key ?? (
                      <span className="font-mono text-xs text-faint">{testCase.id}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="line-clamp-2 font-mono text-xs text-muted">
                      {preview(testCase.input)}
                    </p>
                  </td>
                  <td className="px-4 py-2.5">
                    <p
                      className={cn(
                        "line-clamp-2 font-mono text-xs",
                        testCase.expected == null ? "text-faint" : "text-muted",
                      )}
                    >
                      {testCase.expected == null ? "none" : preview(testCase.expected)}
                    </p>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {testCase.tags.map((tag) => (
                        <Tag key={tag} active={tag === activeTag}>
                          {tag}
                        </Tag>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex justify-end opacity-60 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Edit test case"
                        onClick={() => setEditing(testCase)}
                      >
                        <Pencil size={13} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Delete test case"
                        onClick={() => remove(testCase)}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-muted">
              No test cases match the current filters.
            </p>
          )}
          <p className="num border-t border-line px-4 py-2 text-xs text-muted">
            Showing {visible.length} of {cases.length} cases
          </p>
        </div>
      )}

      <TestCaseDialog
        suiteId={suiteId}
        testCase={editing}
        open={creating || editing !== null}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={refresh}
      />
      <ImportDialog
        suiteId={suiteId}
        open={importing}
        onClose={() => setImporting(false)}
        onImported={refresh}
      />
    </>
  );
}
