import type { ResearchSpend } from "@/server/billing/researchSpend";
import {
  createDataforseoClient,
  type ProjectBillingCustomer,
} from "@/server/lib/dataforseo/client";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { fetchLiveSerp } from "@/server/lib/dataforseo/serp";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

type ResearchSearchInput = Parameters<typeof fetchLiveSerp>[0];

/**
 * One live Google search for competitor research, by deployment mode.
 * Hosted: the searches belong to the already-admitted research task, so only
 * their actual cost is collected for billResearchSpend instead of reserving
 * credits and interrupting it. Self-hosted: each search is a paid call of its
 * own, admitted against the project's DataForSEO budget and recorded by the
 * metered client (billResearchSpend records nothing self-hosted).
 */
export async function liveSearch(
  customer: ProjectBillingCustomer,
  spend: ResearchSpend[],
) {
  if (!(await isHostedServerAuthMode())) {
    const client = createDataforseoClient(customer);
    return (input: ResearchSearchInput) =>
      client.serp.live({ ...input, creditFeature: "keyword_research" });
  }
  const record = (costUsd: number) =>
    spend.push({
      provider: "dataforseo",
      creditFeature: "keyword_research",
      operation: "project_website_research",
      costUsd,
    });
  return async (input: ResearchSearchInput) => {
    try {
      const response = await fetchLiveSerp(input);
      record(response.billing.costUsd);
      return response.data;
    } catch (error) {
      if (error instanceof DataforseoChargedTaskError)
        record(error.billing.costUsd);
      throw error;
    }
  };
}
