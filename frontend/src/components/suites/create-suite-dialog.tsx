"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mutate } from "swr";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, TextArea, TextInput } from "@/components/ui/field";
import { api, errorMessage } from "@/lib/api/client";
import { keys } from "@/lib/api/hooks";
import type { SuiteDetail } from "@/lib/api/types";

export function CreateSuiteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const suite = await api.post<SuiteDetail>("/suites", { name, description });
      await mutate(keys.suites);
      onClose();
      router.push(`/suites/${suite.id}/dataset`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New suite" description="A suite groups a dataset with the variants and evaluators you compare on it.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="Support answer quality" />
        </Field>
        <Field label="Description" hint="What feature does this suite evaluate?">
          <TextArea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
            Create suite
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
