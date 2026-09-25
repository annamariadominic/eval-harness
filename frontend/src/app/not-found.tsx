import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <EmptyState
      title="This page does not exist"
      description="The suite or run may have been deleted."
      action={<ButtonLink href="/suites">Go to suites</ButtonLink>}
    />
  );
}
