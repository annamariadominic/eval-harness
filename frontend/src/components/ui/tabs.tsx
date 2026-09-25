"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

export function TabNav({
  tabs,
}: {
  tabs: Array<{ href: string; label: string; count?: number; exact?: boolean }>;
}) {
  const pathname = usePathname();
  return (
    <nav className="-mb-px flex gap-5 overflow-x-auto border-b border-line" aria-label="Sections">
      {tabs.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 border-b-2 py-2 text-[13px] whitespace-nowrap",
              active
                ? "border-accent font-medium text-ink"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="num rounded bg-surface-2 px-1 text-xs text-muted">{tab.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
