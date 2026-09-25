import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

type Tone = "neutral" | "good" | "bad" | "warn" | "accent";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  good: "bg-good-soft text-good",
  bad: "bg-bad-soft text-bad",
  warn: "bg-warn-soft text-warn",
  accent: "bg-accent-soft text-accent",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-px text-xs font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const RUN_STATUS_TONE: Record<string, Tone> = {
  queued: "neutral",
  running: "accent",
  completed: "good",
  failed: "bad",
  cancelled: "warn",
  interrupted: "warn",
};

export function RunStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={RUN_STATUS_TONE[status] ?? "neutral"}>
      {status === "running" && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
      )}
      {status}
    </Badge>
  );
}

const CHANGE_TONE: Record<string, Tone> = {
  improved: "good",
  regressed: "bad",
  unchanged: "neutral",
  incomparable: "warn",
};

export function ChangeBadge({ change, mixed }: { change: string; mixed?: boolean }) {
  return (
    <Badge
      tone={CHANGE_TONE[change] ?? "neutral"}
      title={mixed ? "Some evaluators improved while others regressed" : undefined}
    >
      {change === "incomparable" ? "not comparable" : change}
      {mixed && " · mixed"}
    </Badge>
  );
}

export function Tag({ children, active }: { children: ReactNode; active?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 text-xs leading-5 whitespace-nowrap",
        active ? "border-accent bg-accent-soft text-accent" : "border-line text-muted",
      )}
    >
      {children}
    </span>
  );
}
