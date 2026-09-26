"use client";

import { ExternalLink, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { mutate } from "swr";

import { Button } from "@/components/ui/button";
import { DEMO_MODE, SOURCE_URL } from "@/lib/demo";

/** Explains what the demo is, and lets a visitor throw their changes away. */
export function DemoBanner() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!DEMO_MODE) return null;

  async function reset() {
    if (!window.confirm("Reset the demo? Your suites, edits, and runs will be discarded.")) return;
    setBusy(true);
    try {
      const { resetDemo } = await import("@/demo/server");
      await resetDemo();
      await mutate(() => true);
      router.push("/suites");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-lg border border-line bg-accent-soft px-4 py-3 text-[13px] md:flex-row md:items-center md:justify-between">
      <p className="text-ink">
        <span className="font-medium">Live demo</span>
        <span className="text-muted">
          {" "}
          · runs entirely in your browser. GPT and Claude results were recorded in advance; runs you
          launch use a simulated model. Your changes stay in this browser.
        </span>
      </p>
      <div className="flex shrink-0 gap-2">
        <a
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-ink"
        >
          <ExternalLink size={12} />
          Source
        </a>
        <Button size="sm" icon={<RotateCcw size={12} />} disabled={busy} onClick={reset}>
          Reset demo
        </Button>
      </div>
    </div>
  );
}
