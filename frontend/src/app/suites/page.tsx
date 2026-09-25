"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { CreateSuiteDialog } from "@/components/suites/create-suite-dialog";
import { SuiteList } from "@/components/suites/suite-list";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorNotice, LoadingRows } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useSuites } from "@/lib/api/hooks";

export default function SuitesPage() {
  const { data: suites, error, isLoading } = useSuites();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Suites"
        description="Each suite pairs a dataset with the prompt and model variants you want to compare."
        actions={
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
            New suite
          </Button>
        }
      />
      {error ? (
        <ErrorNotice error={error} />
      ) : isLoading || !suites ? (
        <LoadingRows rows={2} />
      ) : suites.length === 0 ? (
        <EmptyState
          title="No suites yet"
          description="Create a suite, import a dataset, and define the variants you want to compare."
          action={<Button variant="primary" onClick={() => setCreating(true)}>New suite</Button>}
        />
      ) : (
        <SuiteList suites={suites} />
      )}
      <CreateSuiteDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
