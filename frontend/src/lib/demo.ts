/**
 * Demo-build helpers. The portfolio demo (`NEXT_PUBLIC_DEMO_MODE=1`) runs the backend in the
 * browser: real-provider results were recorded in advance, and only the mock can run live.
 */

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

export const SOURCE_URL = "https://github.com/annamariadominic/eval-harness";

/** Short badge text for a provider that cannot run here. */
export function unavailableLabel(envVar: string | null | undefined): string {
  return DEMO_MODE ? "recorded only" : `set ${envVar ?? "an API key"}`;
}

/** Tooltip for a provider that cannot run here. */
export function unavailableHint(envVar: string | null | undefined): string {
  return DEMO_MODE
    ? "Shown with results recorded in advance; the demo runs only the simulated model"
    : `Set ${envVar ?? "an API key"} to enable`;
}

/** In the demo, runs that used a real provider were recorded ahead of time. */
export function isRecordedRun(run: { variants: Array<{ provider: string }> }): boolean {
  return DEMO_MODE && run.variants.some((variant) => variant.provider !== "mock");
}
