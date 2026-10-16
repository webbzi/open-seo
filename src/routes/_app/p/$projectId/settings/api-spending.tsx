import { createFileRoute, notFound } from "@tanstack/react-router";
import { projectApiSpendingQueryOptions } from "@/client/features/api-spending/apiSpendingQueries";
import { ProjectApiSpending } from "@/client/features/api-spending/ProjectApiSpending";
import { queryClient } from "@/client/tanstack-db/queryClient";
import { isHostedClientAuthMode } from "@/lib/auth-mode";

export const Route = createFileRoute(
  "/_app/p/$projectId/settings/api-spending",
)({
  // Hosted deployments bill DataForSEO through credits; the per-project
  // ledger is self-hosted only, and its server functions refuse there.
  beforeLoad: () => {
    if (isHostedClientAuthMode()) throw notFound();
  },
  loader: ({ params }) => {
    void queryClient.prefetchQuery(
      projectApiSpendingQueryOptions(params.projectId),
    );
  },
  component: ProjectApiSpendingRoute,
});

function ProjectApiSpendingRoute() {
  const { projectId } = Route.useParams();
  return <ProjectApiSpending projectId={projectId} />;
}
