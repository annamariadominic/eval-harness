"use client";

import { RunsTable } from "@/components/runs/runs-table";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, ErrorNotice, LoadingRows } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useRuns } from "@/lib/api/hooks";

export default function RunsPage() {
  const { data: runs, error, isLoading } = useRuns();
  return (
    <>
      <PageHeader
        title="Runs"
        description="Every evaluation run across suites. Runs keep a snapshot of their configuration, so old results stay readable after you edit a suite."
      />
      {error ? (
        <ErrorNotice error={error} />
      ) : isLoading || !runs ? (
        <LoadingRows />
      ) : runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="Open a suite and run an evaluation to see results here."
          action={<ButtonLink href="/suites">Go to suites</ButtonLink>}
        />
      ) : (
        <RunsTable runs={runs} showSuite />
      )}
    </>
  );
}
