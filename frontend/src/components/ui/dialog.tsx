"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { cn } from "@/lib/cn";

/** Modal built on the native <dialog> element (focus trapping and Escape handling for free). */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className={cn(
        "m-auto max-h-[88vh] w-[calc(100%-2rem)] rounded-lg border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40",
        wide ? "max-w-4xl" : "max-w-xl",
      )}
    >
      {open && (
        <div className="flex max-h-[88vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 className="text-[15px] font-semibold">{title}</h2>
              {description && <p className="mt-1 text-xs text-muted">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
