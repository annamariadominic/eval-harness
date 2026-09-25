/** Display formatting. Scores are stored 0-1 and shown as percentages with one decimal. */

const DASH = "—";

export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return (value * 100).toFixed(1);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return `${(value * 100).toFixed(1)}%`;
}

/** Score delta in percentage points, always signed: "+6.7", "−2.0", "0.0". */
export function formatDelta(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  const points = value * 100;
  if (Math.abs(points) < 0.05) return "0.0";
  return `${points > 0 ? "+" : "−"}${Math.abs(points).toFixed(1)}`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatLatencyDelta(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return DASH;
  const sign = ms > 0 ? "+" : ms < 0 ? "−" : "";
  return `${sign}${formatLatency(Math.abs(ms))}`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return DASH;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatCostDelta(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return DASH;
  const sign = usd > 0 ? "+" : usd < 0 ? "−" : "";
  return `${sign}${formatCost(Math.abs(usd))}`;
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return DASH;
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return DASH;
  return formatLatency(new Date(endIso).getTime() - new Date(startIso).getTime());
}

/** Pretty-print a test-case value: strings as-is, structured values as indented JSON. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export type Tone = "good" | "bad" | "neutral";

/** Higher-is-better tone for a score delta, with a dead zone for noise. */
export function deltaTone(delta: number | null | undefined, deadZone = 0.005): Tone {
  if (delta === null || delta === undefined || Math.abs(delta) <= deadZone) return "neutral";
  return delta > 0 ? "good" : "bad";
}

/** Lower-is-better tone (latency, cost), relative to the reference value. */
export function costTone(delta: number | null | undefined, reference: number | null | undefined): Tone {
  if (delta === null || delta === undefined || !reference) return "neutral";
  if (Math.abs(delta) / reference < 0.05) return "neutral";
  return delta < 0 ? "good" : "bad";
}
