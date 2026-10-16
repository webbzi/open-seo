import { createFileRoute, notFound } from "@tanstack/react-router";
import { OrganizationApiSpending } from "@/client/features/api-spending/OrganizationApiSpending";
import { isHostedClientAuthMode } from "@/lib/auth-mode";

export const Route = createFileRoute("/_app/settings/api-spending")({
  // Hosted deployments bill DataForSEO through credits; the per-project
  // ledger is self-hosted only, and its server functions refuse there.
  beforeLoad: () => {
    if (isHostedClientAuthMode()) throw notFound();
  },
  component: OrganizationApiSpending,
});
