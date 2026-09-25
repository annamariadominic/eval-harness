"use client";

import { FlaskConical, History } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useProviders } from "@/lib/api/hooks";
import { cn } from "@/lib/cn";

import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { href: "/suites", label: "Suites", icon: FlaskConical },
  { href: "/runs", label: "Runs", icon: History },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: providers } = useProviders();

  return (
    <aside className="flex shrink-0 flex-col border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:w-52 md:border-r md:border-b-0">
      <div className="flex items-center justify-between gap-4 px-4 py-3 md:block md:py-5">
        <Link href="/suites" className="flex items-center gap-2 font-semibold tracking-tight">
          <Mark />
          <span>Eval Harness</span>
        </Link>
        <nav className="flex gap-1 md:mt-6 md:flex-col">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
                  active ? "bg-surface-2 font-medium text-ink" : "text-muted hover:text-ink",
                )}
              >
                <Icon size={15} />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="mt-auto hidden space-y-4 border-t border-line px-4 py-4 md:block">
        <div>
          <p className="mb-1.5 text-xs text-faint">Providers</p>
          <ul className="space-y-1">
            {(providers ?? []).map((provider) => (
              <li
                key={provider.name}
                className="flex items-center justify-between text-xs"
                title={
                  provider.configured
                    ? "Configured"
                    : `Set ${provider.env_var ?? "an API key"} to enable`
                }
              >
                <span className={provider.configured ? "text-ink" : "text-faint"}>
                  {provider.label}
                </span>
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    provider.configured ? "bg-good" : "bg-line-strong",
                  )}
                  aria-label={provider.configured ? "configured" : "not configured"}
                />
              </li>
            ))}
          </ul>
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}

/** Two offset bars: a baseline and a candidate. */
function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="text-accent">
      <rect x="2" y="4" width="9" height="3" rx="1" fill="currentColor" opacity="0.45" />
      <rect x="2" y="11" width="14" height="3" rx="1" fill="currentColor" />
    </svg>
  );
}
