"use client";

import { useParams } from "next/navigation";

import { RunsTable } from "@/components/runs/runs-table";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, LoadingRows } from "@/components/ui/empty-state";
import { useRuns } from "@/lib/api/hooks";

export default function SuiteRunsPage() {
  const { suiteId } = useParams<{ suiteId: string }>();
  const { data: runs } = useRuns(suiteId);
  if (!runs) return <LoadingRows />;
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        description="A run executes the selected test cases against each selected variant and scores every output."
        action={<ButtonLink href={`/suites/${suiteId}/runs/new`} variant="primary">Run evaluation</ButtonLink>}
      />
    );
  }
  return <RunsTable runs={runs} />;
}
