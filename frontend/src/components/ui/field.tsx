import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";

const control =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60";

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-xs font-medium text-ink">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-bad">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-xs text-muted">{hint}</span>
      )}
    </label>
  );
}

export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, "h-8", className)} {...props} />;
}

export function TextArea({
  className,
  mono,
  ...props
}: ComponentProps<"textarea"> & { mono?: boolean }) {
  return (
    <textarea
      className={cn(control, "py-2 leading-relaxed", mono && "font-mono text-xs", className)}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cn(control, "h-8 pr-7", className)} {...props}>
      {children}
    </select>
  );
}

export function Checkbox({
  label,
  className,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { label: ReactNode }) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-[13px]", className)}>
      <input type="checkbox" className="size-3.5 accent-[var(--accent)]" {...props} />
      <span>{label}</span>
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-xs text-bad">
      {message}
    </p>
  );
}
