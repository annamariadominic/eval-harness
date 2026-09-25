import { ArrowRight } from "lucide-react";

import { Select } from "@/components/ui/field";
import type { ArmOption } from "@/lib/comparison";

export function ArmPicker({
  options,
  base,
  target,
  onChange,
}: {
  options: ArmOption[];
  base: string | null;
  target: string | null;
  onChange: (base: string | null, target: string | null) => void;
}) {
  const label = (o: ArmOption) =>
    `${o.label}${o.isBaseline ? " (baseline)" : ""}${o.inRun ? "" : ` · ${o.detail}`}`;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-56 flex-1 sm:max-w-80">
        <span className="mb-1 block text-xs text-muted">Reference</span>
        <Select value={base ?? ""} onChange={(e) => onChange(e.target.value || null, target)}>
          <option value="">No reference (this variant only)</option>
          {options
            .filter((o) => o.id !== target)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {label(o)}
              </option>
            ))}
        </Select>
      </label>
      <ArrowRight size={16} className="mb-2 text-faint" aria-hidden />
      <label className="min-w-56 flex-1 sm:max-w-80">
        <span className="mb-1 block text-xs text-muted">Candidate</span>
        <Select
          value={target ?? ""}
          onChange={(e) => onChange(base === e.target.value ? null : base, e.target.value)}
        >
          {options
            .filter((o) => o.inRun)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {label(o)}
              </option>
            ))}
        </Select>
      </label>
    </div>
  );
}
