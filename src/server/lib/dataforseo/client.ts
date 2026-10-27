/* eslint-disable max-lines -- the one DataForSEO metering seam: every paid entry, and its hosted and self-hosted branches side by side */
import { waitUntil } from "cloudflare:workers";
import {
  type CreditFeature,
  mapDataforseoPathToCreditFeature,
} from "@/shared/billing-credit-features";
import { creditsForProviderUsd } from "@/shared/billing";
import {
  getOrCreateOrganizationCustomer,
  reserveUsageCredits,
  settleUsageCredits,
} from "@/server/billing/subscription";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { ProjectDataforseoBudgetService } from "@/server/features/projects/services/ProjectDataforseoBudgetService";
import {
  type DataforseoDispatch,
  trackDataforseoDispatch,
} from "@/server/lib/dataforseo/core";
import {
  DataforseoChargedTaskError,
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import { isProjectDataforseoRefusal } from "@/server/lib/dataforseo/projectBudgetRefusal";
import {
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  fetchQuestionsAnswers,
  postGoogleReviewsTask,
  postMyBusinessUpdatesTask,
} from "@/server/lib/dataforseo/business";
import {
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
} from "@/server/lib/dataforseo/backlinks";
import {
  fetchDomainRankOverview,
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
  fetchRelevantPages,
  fetchSerpCompetitors,
} from "@/server/lib/dataforseo/labs";
import {
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from "@/server/lib/dataforseo/google-ads";
import {
  fetchLiveSerp,
  fetchLocalSerp,
  fetchRankCheckSerp,
  postLocalSerpTasks,
  postRankCheckTasks,
} from "@/server/lib/dataforseo/serp";
import { fetchLighthouseResult } from "@/server/lib/dataforseo/lighthouse";
import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
} from "@/server/lib/dataforseo/ai";
import {
  fetchAiTrackingLiveAnswer,
  postAiTrackingTasks,
} from "@/server/lib/dataforseo/ai-tracking";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";

export { mapDataforseoPathToCreditFeature };

/**
 * The customer every paid DataForSEO call is made for. Hosted mode bills the
 * organization's credits; self-hosted mode meters the project's own budget,
 * so a caller without an authorized project cannot build a client.
 * `runId` labels the project ledger rows of a workflow run (rank check, AI
 * visibility run, site audit) so its spend can be traced back to it.
 */
export type ProjectBillingCustomer = BillingCustomerContext & {
  projectId: string;
  runId?: string;
};

/**
 * Wraps a section fetcher with billing metering. Each entry on the client is
 * `meter(customer, "section.entry", fetchX, dataforseoPricing.section.x,
 * defaultFeature?)`, which returns a function with the fetcher's own input
 * type and resolves to its unwrapped `.data`.
 *
 * `operation` labels the call in the project ledger. `estimateRawUsd` is
 * required: it is the upper bound reserved before the call, so an entry cannot
 * be added without a price (see pricing.ts).
 *
 * `defaultFeature` is the fallback credit feature; a caller can override it per
 * call by passing `creditFeature` in the input (e.g. an MCP tool attributing
 * spend to its own feature). The extra field is ignored by the fetchers, which
 * read named fields rather than spreading the input.
 */
function meter<I, T>(
  customer: ProjectBillingCustomer,
  operation: string,
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  estimateRawUsd: (input: I) => number,
  defaultFeature?: CreditFeature,
): (input: I & { creditFeature?: CreditFeature }) => Promise<T> {
  return (input) =>
    meterDataforseoCall(
      customer,
      operation,
      () => fetcher(input),
      estimateRawUsd(input),
      input.creditFeature ?? defaultFeature,
    );
}

export function createDataforseoClient(customer: ProjectBillingCustomer) {
  return {
    business: {
      businessListings: meter(
        customer,
        "business.businessListings",
        fetchBusinessListingsSearch,
        dataforseoPricing.business.businessListings,
        "local_seo",
      ),
      questionsAnswers: meter(
        customer,
        "business.questionsAnswers",
        fetchQuestionsAnswers,
        dataforseoPricing.business.questionsAnswers,
        "local_seo",
      ),
      myBusinessInfo: meter(
        customer,
        "business.myBusinessInfo",
        fetchMyBusinessInfo,
        dataforseoPricing.business.myBusinessInfo,
        "local_seo",
      ),
      // task_post is where DataForSEO charges; collection runs unmetered
      // through fetchBusinessDataTaskResult (see index.ts).
      reviewsTaskPost: meter(
        customer,
        "business.reviewsTaskPost",
        postGoogleReviewsTask,
        dataforseoPricing.business.reviewsTaskPost,
        "local_seo",
      ),
      updatesTaskPost: meter(
        customer,
        "business.updatesTaskPost",
        postMyBusinessUpdatesTask,
        dataforseoPricing.business.updatesTaskPost,
        "local_seo",
      ),
    },
    backlinks: {
      summary: meter(
        customer,
        "backlinks.summary",
        fetchBacklinksSummary,
        dataforseoPricing.backlinks.summary,
      ),
      rows: meter(
        customer,
        "backlinks.rows",
        fetchBacklinksRows,
        dataforseoPricing.backlinks.rows,
      ),
      referringDomains: meter(
        customer,
        "backlinks.referringDomains",
        fetchReferringDomains,
        dataforseoPricing.backlinks.referringDomains,
      ),
      domainPages: meter(
        customer,
        "backlinks.domainPages",
        fetchDomainPagesSummary,
        dataforseoPricing.backlinks.domainPages,
      ),
      history: meter(
        customer,
        "backlinks.history",
        fetchBacklinksHistory,
        dataforseoPricing.backlinks.history,
      ),
    },
    keywords: {
      related: meter(
        customer,
        "keywords.related",
        fetchRelatedKeywords,
        dataforseoPricing.keywords.related,
      ),
      suggestions: meter(
        customer,
        "keywords.suggestions",
        fetchKeywordSuggestions,
        dataforseoPricing.keywords.suggestions,
      ),
      ideas: meter(
        customer,
        "keywords.ideas",
        fetchKeywordIdeas,
        dataforseoPricing.keywords.ideas,
      ),
      // Google Ads endpoints for countries Labs doesn't support.
      adsIdeas: meter(
        customer,
        "keywords.adsIdeas",
        fetchAdsKeywordIdeas,
        dataforseoPricing.keywords.adsIdeas,
      ),
      adsSearchVolume: meter(
        customer,
        "keywords.adsSearchVolume",
        fetchAdsSearchVolume,
        dataforseoPricing.keywords.adsSearchVolume,
      ),
    },
    domain: {
      rankOverview: meter(
        customer,
        "domain.rankOverview",
        fetchDomainRankOverview,
        dataforseoPricing.domain.rankOverview,
      ),
      rankedKeywords: meter(
        customer,
        "domain.rankedKeywords",
        fetchRankedKeywords,
        dataforseoPricing.domain.rankedKeywords,
      ),
      relevantPages: meter(
        customer,
        "domain.relevantPages",
        fetchRelevantPages,
        dataforseoPricing.domain.relevantPages,
      ),
    },
    serp: {
      live: meter(
        customer,
        "serp.live",
        fetchLiveSerp,
        dataforseoPricing.serp.live,
      ),
      // A rank check batch shares one credit hold and one settle across its
      // live calls (see meterDataforseoCalls). Resolves per call, in order.
      rankCheckBatch: (inputs: Parameters<typeof fetchRankCheckSerp>[0][]) =>
        meterDataforseoCalls(
          customer,
          "serp.rankCheckBatch",
          inputs.map((input) => () => fetchRankCheckSerp(input)),
          inputs.map((input) => dataforseoPricing.serp.rankCheck(input)),
          "rank_tracking",
        ),
      // Posts up to 100 queued rank check tasks; one metered charge covers the
      // whole batch (DataForSEO bills task_post at post time, collection is
      // free).
      rankCheckTaskPost: meter(
        customer,
        "serp.rankCheckTaskPost",
        postRankCheckTasks,
        dataforseoPricing.serp.rankCheckTaskPost,
        "rank_tracking",
      ),
      local: meter(
        customer,
        "serp.local",
        fetchLocalSerp,
        dataforseoPricing.serp.local,
        "local_seo",
      ),
      // Live Maps searches for a Local SEO check, one per grid point; one
      // credit hold covers the batch.
      localBatch: (inputs: Parameters<typeof fetchLocalSerp>[0][]) =>
        meterDataforseoCalls(
          customer,
          "serp.localBatch",
          inputs.map((input) => () => fetchLocalSerp(input)),
          inputs.map((input) => dataforseoPricing.serp.local(input)),
          "local_seo",
        ),
      // One queued Maps task per rank grid point; one metered charge covers
      // them all (DataForSEO bills task_post, collection is free).
      localTaskPost: meter(
        customer,
        "serp.localTaskPost",
        postLocalSerpTasks,
        dataforseoPricing.serp.localTaskPost,
        "local_seo",
      ),
    },
    labs: {
      // Callers (e.g. the keyword-metrics MCP tool) can attribute the spend to
      // their own feature by passing `creditFeature` in the input; defaults to
      // rank_tracking when omitted.
      keywordOverview: meter(
        customer,
        "labs.keywordOverview",
        fetchKeywordOverview,
        dataforseoPricing.labs.keywordOverview,
        "rank_tracking",
      ),
      serpCompetitors: meter(
        customer,
        "labs.serpCompetitors",
        fetchSerpCompetitors,
        dataforseoPricing.labs.serpCompetitors,
      ),
    },
    lighthouse: {
      live: meter(
        customer,
        "lighthouse.live",
        fetchLighthouseResult,
        dataforseoPricing.lighthouse.live,
      ),
    },
    aiSearch: {
      mentionsSearch: meter(
        customer,
        "aiSearch.mentionsSearch",
        fetchLlmMentionsSearch,
        dataforseoPricing.aiSearch.mentionsSearch,
      ),
      aggregatedMetrics: meter(
        customer,
        "aiSearch.aggregatedMetrics",
        fetchLlmAggregatedMetrics,
        dataforseoPricing.aiSearch.aggregatedMetrics,
      ),
      topPages: meter(
        customer,
        "aiSearch.topPages",
        fetchLlmTopPages,
        dataforseoPricing.aiSearch.topPages,
      ),
      crossAggregatedMetrics: meter(
        customer,
        "aiSearch.crossAggregatedMetrics",
        fetchLlmCrossAggregatedMetrics,
        dataforseoPricing.aiSearch.crossAggregatedMetrics,
      ),
      llmResponse: meter(
        customer,
        "aiSearch.llmResponse",
        fetchLlmResponse,
        dataforseoPricing.aiSearch.llmResponse,
      ),
      // Posts up to 100 tracked prompts for one engine; one metered charge
      // covers the batch (DataForSEO bills task_post, collection is free).
      trackingTaskPost: meter(
        customer,
        "aiSearch.trackingTaskPost",
        postAiTrackingTasks,
        dataforseoPricing.aiSearch.trackingTaskPost,
        "ai_prompt_responses",
      ),
      // A manual run's live answers share one credit hold and one settle (see
      // meterDataforseoCalls). Resolves per call, in order.
      trackingLiveBatch: (
        inputs: Parameters<typeof fetchAiTrackingLiveAnswer>[0][],
      ) =>
        meterDataforseoCalls(
          customer,
          "aiSearch.trackingLiveBatch",
          inputs.map((input) => () => fetchAiTrackingLiveAnswer(input)),
          inputs.map((input) => dataforseoPricing.aiSearch.trackingLive(input)),
          "ai_prompt_responses",
        ),
    },
  } as const;
}

/**
 * The one seam every DataForSEO charge passes through. Hosted mode meters the
 * organization's credits; self-hosted mode meters the project's budget in raw
 * provider USD (see meterProjectDataforseoCalls).
 *
 * Hosted order: reserve the estimate on the org's credits -> provider calls ->
 * settle the hold on their real cost. The hold is atomic in Autumn, so
 * concurrent calls cannot all pass on one stale balance reading.
 *
 * A batch of calls shares one hold and one settle per credit pool it draws
 * on, with each call placed and refused as its own hold would be (see
 * reserveUsageCredits): holding and settling per call sent up to 40 Autumn
 * requests per rank check batch, and enough of them hit the SDK's timeout to
 * drop charges.
 */
async function meterDataforseoCalls<T>(
  customer: ProjectBillingCustomer,
  operation: string,
  executes: Array<() => Promise<DataforseoApiResponse<T>>>,
  estimatesUsd: number[],
  creditFeature?: CreditFeature,
): Promise<PromiseSettledResult<T>[]> {
  if (executes.length === 0) return [];
  const isHostedMode = await isHostedServerAuthMode();

  if (!isHostedMode) {
    return meterProjectDataforseoCalls(
      customer,
      operation,
      executes,
      estimatesUsd,
      creditFeature,
    );
  }

  const callCredits = estimatesUsd.map((usd) => creditsForProviderUsd(usd));
  const billingCustomer = await getOrCreateOrganizationCustomer(customer);
  const { holds, refusedCalls } = await reserveUsageCredits({
    customer,
    customerId: billingCustomer.id,
    callCredits,
    creditFeature,
  });

  const work = (async () => {
    const billed: Array<DataforseoApiCallCost | null> = executes.map(
      () => null,
    );
    const settled = await Promise.allSettled(
      executes.map(async (execute, index) => {
        if (refusedCalls.includes(index)) {
          throw new AppError("INSUFFICIENT_CREDITS");
        }
        try {
          const result = await execute();
          billed[index] = result.billing;
          return result.data;
        } catch (error) {
          // Transport / auth / upstream failure: nothing was billed.
          if (!(error instanceof DataforseoChargedTaskError)) throw error;
          // A malformed request (DataForSEO "Invalid Field: ...") that
          // DataForSEO did not bill returns no value to the customer, so don't
          // charge — surface it as a non-reportable VALIDATION_ERROR. If
          // DataForSEO still billed us (costUsd > 0), charge that cost so the
          // spend stays metered and visible instead of silently eaten.
          if (error.isInvalidField && error.billing.costUsd <= 0) {
            throw new AppError("VALIDATION_ERROR", error.message);
          }
          billed[index] = error.billing;
          throw error;
        }
      }),
    );

    for (const hold of holds) {
      const costs = hold.callIndexes
        .map((index) => billed[index])
        .filter((cost) => cost !== null);
      await settleUsageCredits({
        customer,
        hold,
        creditFeature:
          creditFeature ??
          (costs.length > 0
            ? mapDataforseoPathToCreditFeature(costs[0].path)
            : undefined),
        costs,
      });
    }
    return settled;
  })();

  keepAliveWithRequest(work);
  return await work;
}

type SettleOutcome = Parameters<
  typeof ProjectDataforseoBudgetService.settle
>[0]["outcomes"][number];

/**
 * Self-hosted: one admission on the project's budget for the whole invocation,
 * one estimate per call, so a refusal rejects every call before any is sent.
 * Then the calls, then one settlement with each call's outcome. A known charge
 * completes its row; a call provably never billed releases it; anything else
 * leaves it pending, later reported as estimated.
 */
async function meterProjectDataforseoCalls<T>(
  customer: ProjectBillingCustomer,
  operation: string,
  executes: Array<() => Promise<DataforseoApiResponse<T>>>,
  estimatesUsd: number[],
  creditFeature: CreditFeature | undefined,
): Promise<PromiseSettledResult<T>[]> {
  // The type requires a project, but Workflow payloads are deserialized:
  // missing attribution is a bug, never permission to spend unmetered.
  if (!customer.projectId) {
    throw new Error(
      `DataForSEO ${operation} has no project to meter its spend against`,
    );
  }
  const scope = {
    organizationId: customer.organizationId,
    projectId: customer.projectId,
  };

  let usageIds: string[];
  try {
    ({ usageIds } = await ProjectDataforseoBudgetService.admit({
      ...scope,
      actorUserId: customer.userId,
      feature: creditFeature ?? null,
      operation,
      runId: customer.runId ?? null,
      estimatesUsd,
    }));
  } catch (error) {
    if (!isProjectDataforseoRefusal(error)) throw error;
    return executes.map(() => ({ status: "rejected", reason: error }));
  }

  // A known cost completes the row. settle rejects the whole batch for a cost
  // that is not a finite non-negative number, so an unreadable one is unknown.
  // A null admission feature is filled in from the billed path.
  const chargedOutcome = (
    usageId: string,
    billing: DataforseoApiCallCost,
  ): SettleOutcome =>
    Number.isFinite(billing.costUsd) && billing.costUsd >= 0
      ? {
          usageId,
          kind: "charged",
          costUsd: billing.costUsd,
          feature: creditFeature
            ? undefined
            : mapDataforseoPathToCreditFeature(billing.path),
        }
      : { usageId, kind: "unknown" };

  // In order: a charged task carries its own cost; a parsed body's top-level
  // cost is what DataForSEO charged for the request, even for a request-level
  // refusal (account cost limit, funds, rate limits) answered with HTTP 200.
  // Without either, a call is provably unbilled only if nothing left this
  // Worker or DataForSEO refused it with an HTTP 4xx. Transport failures,
  // timeouts, 5xx and unreadable answers may have been billed.
  const failedOutcome = (
    usageId: string,
    error: unknown,
    dispatch: DataforseoDispatch,
  ): SettleOutcome => {
    if (error instanceof DataforseoChargedTaskError)
      return chargedOutcome(usageId, error.billing);
    if (dispatch.billing) return chargedOutcome(usageId, dispatch.billing);
    const unbilled =
      !dispatch.sent ||
      (dispatch.status !== null &&
        dispatch.status >= 400 &&
        dispatch.status < 500);
    return { usageId, kind: unbilled ? "released" : "unknown" };
  };

  const work = (async () => {
    const outcomes: SettleOutcome[] = [];
    const settled = await Promise.allSettled(
      executes.map(async (execute, index) => {
        const usageId = usageIds[index];
        const dispatch: DataforseoDispatch = {
          sent: false,
          status: null,
          billing: null,
        };
        try {
          const result = await trackDataforseoDispatch(dispatch, execute);
          outcomes.push(chargedOutcome(usageId, result.billing));
          return result.data;
        } catch (error) {
          outcomes.push(failedOutcome(usageId, error, dispatch));
          throw error;
        }
      }),
    );

    // The calls already happened: a lost settlement leaves their rows
    // pending (counted at their estimate), it must not fail the caller.
    try {
      await ProjectDataforseoBudgetService.settle({ ...scope, outcomes });
    } catch (error) {
      console.error("dataforseo.project-settle-failed", {
        ...scope,
        usageIds,
        error,
      });
    }
    return settled;
  })();

  keepAliveWithRequest(work);
  return await work;
}

/**
 * Registers the calls + settle with the request: workerd cancels pending I/O
 * once the client goes away, and a hold or admission that never settles would
 * let a disconnect-after-dispatch skip the deduction. The caller awaits `work`,
 * which handles its rejection; the background handle only keeps the chain
 * alive.
 */
function keepAliveWithRequest(work: Promise<unknown>): void {
  try {
    waitUntil(work.catch(() => undefined));
  } catch {
    // No request context (Workflow step, tests): the caller's await runs it.
  }
}

async function meterDataforseoCall<T>(
  customer: ProjectBillingCustomer,
  operation: string,
  execute: () => Promise<DataforseoApiResponse<T>>,
  estimateUsd: number,
  creditFeature?: CreditFeature,
): Promise<T> {
  const [result] = await meterDataforseoCalls(
    customer,
    operation,
    [execute],
    [estimateUsd],
    creditFeature,
  );
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
