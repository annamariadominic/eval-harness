import { twMerge } from "tailwind-merge";

/** Join class names, skipping falsy values; later Tailwind classes override conflicting ones. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(" "));
}
