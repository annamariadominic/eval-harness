import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/format";

const toneClass: Record<Tone, string> = {
  good: "text-good",
  bad: "text-bad",
  neutral: "text-muted",
};

export function Delta({ text, tone, className }: { text: string; tone: Tone; className?: string }) {
  return <span className={cn("num font-medium", toneClass[tone], className)}>{text}</span>;
}
