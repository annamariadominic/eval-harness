"use client";

import { useParams } from "next/navigation";

import { RunHeader } from "@/components/runs/run-header";
import { RunResults } from "@/components/runs/run-results";
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
      <RunResults run={run} />
    </>
  );
}
