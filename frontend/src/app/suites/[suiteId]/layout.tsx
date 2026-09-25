"use client";

import { Play } from "lucide-react";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";

import { ButtonLink } from "@/components/ui/button";
import { ErrorNotice, LoadingRows } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { TabNav } from "@/components/ui/tabs";
import { useSuite } from "@/lib/api/hooks";

export default function SuiteLayout({ children }: { children: ReactNode }) {
  const { suiteId } = useParams<{ suiteId: string }>();
  const { data: suite, error } = useSuite(suiteId);
  const base = `/suites/${suiteId}`;

  if (error) return <ErrorNotice error={error} />;
  if (!suite) return <LoadingRows rows={3} />;

  return (
    <>
      <PageHeader
        breadcrumb={[{ href: "/suites", label: "Suites" }]}
        title={suite.name}
        description={suite.description}
        actions={
          <ButtonLink href={`${base}/runs/new`} variant="primary" icon={<Play size={13} />}>
            Run evaluation
          </ButtonLink>
        }
      />
      <div className="mb-6">
        <TabNav
          tabs={[
            { href: base, label: "Overview", exact: true },
            { href: `${base}/dataset`, label: "Dataset", count: suite.test_case_count },
            { href: `${base}/variants`, label: "Variants", count: suite.variant_count },
            { href: `${base}/evaluators`, label: "Evaluators", count: suite.evaluator_count },
            { href: `${base}/runs`, label: "Runs", count: suite.run_count },
          ]}
        />
      </div>
      {children}
    </>
  );
}
