"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";

import { RunComparison } from "@/components/compare/run-comparison";
import { RunHeader } from "@/components/runs/run-header";
import { ErrorNotice, LoadingRows } from "@/components/ui/empty-state";
import { useRun } from "@/lib/api/hooks";

export default function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const { data: run, error } = useRun(runId);
  if (error) return <ErrorNotice error={error} />;
  if (!run) return <LoadingRows rows={5} />;
  return (
    <>
      <RunHeader run={run} />
      <Suspense fallback={<LoadingRows rows={4} />}>
        <RunComparison run={run} />
      </Suspense>
    </>
  );
}
