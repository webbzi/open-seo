/* eslint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
  AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
  creditsForProviderUsd,
} from "@/shared/billing";
import type { ProjectDataforseoBudgetService } from "@/server/features/projects/services/ProjectDataforseoBudgetService";

interface CheckCallArg {
  customerId: string;
  featureId: string;
  requiredBalance?: number;
  lock?: { lockId: string };
}

interface CheckResult {
  allowed: boolean;
  balance: { remaining: number } | null;
}

interface FinalizeCallArg {
  lockId: string;
  action: "confirm" | "release";
  overrideValue?: number;
}

const {
  admitMock,
  settleMock,
  checkMock,
  finalizeMock,
  getOrCreateMock,
  isHostedServerAuthModeMock,
  mockEnv,
} = vi.hoisted(() => ({
  admitMock: vi.fn<(typeof ProjectDataforseoBudgetService)["admit"]>(),
  settleMock: vi.fn<(typeof ProjectDataforseoBudgetService)["settle"]>(),
  checkMock: vi.fn<(arg: CheckCallArg) => Promise<CheckResult>>(),
  finalizeMock:
    vi.fn<(arg: FinalizeCallArg) => Promise<{ success: boolean }>>(),
  getOrCreateMock: vi.fn(),
  isHostedServerAuthModeMock: vi.fn(),
  mockEnv: {},
}));

vi.mock(
  "@/server/features/projects/services/ProjectDataforseoBudgetService",
  () => ({
    ProjectDataforseoBudgetService: { admit: admitMock, settle: settleMock },
  }),
);

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
  waitUntil: vi.fn(),
}));

vi.mock("@/server/billing/autumn", () => ({
  autumn: {
    check: checkMock,
    balances: { finalize: finalizeMock },
  },
  AUTUMN_TRACK_RETRY_OPTIONS: {},
}));

// Keep the real subscription module (reserve/settle run against the mocked
// autumn facade) and only stub the customer lookup, so the hold logic stays
// exercised end to end through the client.
vi.mock("@/server/billing/subscription", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getOrCreateOrganizationCustomer: getOrCreateMock,
  };
});

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: isHostedServerAuthModeMock,
  getRequiredEnvValue: async () => "test-api-key",
}));

vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

// Mock every section module the client wraps so meterDataforseoCall's
// `execute()` resolves to a controllable fixture.
vi.mock("@/server/lib/dataforseo/labs", () => ({
  fetchRelatedKeywords: vi.fn(),
  fetchKeywordSuggestions: vi.fn(),
  fetchKeywordIdeas: vi.fn(),
  fetchDomainRankOverview: vi.fn(),
  fetchRankedKeywords: vi.fn(),
  fetchRelevantPages: vi.fn(),
  fetchKeywordOverview: vi.fn(),
  fetchSerpCompetitors: vi.fn(),
}));
vi.mock("@/server/lib/dataforseo/serp", () => ({
  fetchLiveSerp: vi.fn(),
  fetchRankCheckSerp: vi.fn(),
  postRankCheckTasks: vi.fn(),
  fetchLocalSerp: vi.fn(),
  postLocalSerpTasks: vi.fn(),
  clampSerpDepth: (depth: number) => depth,
  SERP_ANALYSIS_DEPTH: 20,
}));
vi.mock("@/server/lib/dataforseo/business", () => ({
  fetchBusinessListingsSearch: vi.fn(),
  fetchQuestionsAnswers: vi.fn(),
  fetchMyBusinessInfo: vi.fn(),
  postGoogleReviewsTask: vi.fn(),
  postMyBusinessUpdatesTask: vi.fn(),
}));
vi.mock("@/server/lib/dataforseo/google-ads", () => ({
  fetchAdsKeywordIdeas: vi.fn(),
  fetchAdsSearchVolume: vi.fn(),
}));
vi.mock("@/server/lib/dataforseo/backlinks", () => ({
  fetchBacklinksSummary: vi.fn(),
  fetchBacklinksRows: vi.fn(),
  fetchReferringDomains: vi.fn(),
  fetchDomainPagesSummary: vi.fn(),
  fetchBacklinksHistory: vi.fn(),
  BACKLINKS_DEFAULT_LIMIT: 100,
}));
vi.mock("@/server/lib/dataforseo/lighthouse", () => ({
  fetchLighthouseResult: vi.fn(),
}));
vi.mock("@/server/lib/dataforseo/ai", () => ({
  fetchLlmMentionsSearch: vi.fn(),
  fetchLlmAggregatedMetrics: vi.fn(),
  fetchLlmTopPages: vi.fn(),
  fetchLlmCrossAggregatedMetrics: vi.fn(),
  fetchLlmResponse: vi.fn(),
  resolveLlmMentionsLimit: (limit?: number) => limit ?? 100,
  LLM_RESPONSE_WEB_SEARCH_DEFAULT: true,
}));

import { waitUntil } from "cloudflare:workers";
import {
  createDataforseoClient,
  mapDataforseoPathToCreditFeature,
} from "@/server/lib/dataforseo/client";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  DataforseoChargedTaskError,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import { fetchBacklinksSummary } from "@/server/lib/dataforseo/backlinks";
import { fetchRankCheckSerp } from "@/server/lib/dataforseo/serp";

const billingCustomer = {
  organizationId: "org_123",
  userId: "user_123",
  userEmail: "alice@example.com",
  projectId: "project_123",
};

const backlinksInput = {
  target: "example.com",
};
const backlinksPath = ["v3", "backlinks", "summary", "live"];

// Below the summary estimate, as a real charge is (the estimate is an upper bound).
const RAW_COST = 0.02;
const EXPECTED_CREDITS = creditsForProviderUsd(RAW_COST);
const ESTIMATED_CREDITS = creditsForProviderUsd(
  dataforseoPricing.backlinks.summary(backlinksInput),
);

function setupHostedMode() {
  isHostedServerAuthModeMock.mockResolvedValue(true);
  getOrCreateMock.mockResolvedValue({ id: "org_123" });
  finalizeMock.mockResolvedValue({ success: true });
}

// Monthly balance only; topup reads empty.
function mockMonthlyBalance(monthly: number) {
  checkMock.mockImplementation(async (args) => {
    const remaining =
      args.featureId === AUTUMN_SEO_DATA_BALANCE_FEATURE_ID ? monthly : 0;
    return {
      allowed: remaining >= (args.requiredBalance ?? 1),
      balance: { remaining },
    };
  });
}

function mockDataforseoResult(costUsd: number) {
  vi.mocked(fetchBacklinksSummary).mockResolvedValue({
    data: { rank: 42 },
    billing: { costUsd, path: backlinksPath },
  });
}

function setupSelfHostedMode() {
  isHostedServerAuthModeMock.mockResolvedValue(false);
  admitMock.mockImplementation(async ({ estimatesUsd }) => ({
    usageIds: estimatesUsd.map((_, index) => `usage_${index}`),
  }));
  settleMock.mockResolvedValue(undefined);
}

const projectScope = {
  organizationId: "org_123",
  projectId: "project_123",
};

describe("self-hosted project ledger", () => {
  beforeEach(setupSelfHostedMode);
  afterEach(() => vi.unstubAllGlobals());

  it("admits the raw USD estimate and settles the provider's cost, without credits", async () => {
    mockDataforseoResult(RAW_COST);

    const client = createDataforseoClient(billingCustomer);
    const result = await client.backlinks.summary(backlinksInput);

    expect(result).toEqual({ rank: 42 });
    expect(admitMock).toHaveBeenCalledExactlyOnceWith({
      ...projectScope,
      actorUserId: "user_123",
      feature: null,
      operation: "backlinks.summary",
      runId: null,
      estimatesUsd: [dataforseoPricing.backlinks.summary(backlinksInput)],
    });
    // No admission feature, so the billed path supplies it.
    expect(settleMock).toHaveBeenCalledExactlyOnceWith({
      ...projectScope,
      outcomes: [
        {
          usageId: "usage_0",
          kind: "charged",
          costUsd: RAW_COST,
          feature: "backlinks",
        },
      ],
    });
    expect(vi.mocked(waitUntil)).toHaveBeenCalledTimes(1);
    expect(checkMock).not.toHaveBeenCalled();
  });

  // The fetcher drives the real request layer against a stubbed fetch, so the
  // outcome reflects what actually reached DataForSEO.
  function failThroughRequestLayer(fetchMock: typeof fetch) {
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(fetchBacklinksSummary).mockImplementation(async () => {
      assertOk(
        await dataforseoPost("/v3/backlinks/summary/live", [backlinksInput], {
          maxServerErrorRetries: 0,
        }),
      );
      // A response that passes assertOk fails item validation.
      throw new AppError("INTERNAL_ERROR", "invalid response shape");
    });
  }

  const respond = (body: object) =>
    failThroughRequestLayer(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
    );

  it.each([
    {
      failure: "a charged task error at zero cost",
      outcome: { kind: "charged", costUsd: 0 },
      setup: () =>
        vi.mocked(fetchBacklinksSummary).mockRejectedValue(
          new DataforseoChargedTaskError("DataForSEO task failed", {
            costUsd: 0,
            path: backlinksPath,
          }),
        ),
    },
    {
      failure: "a request-level refusal in an HTTP 200 body at its cost",
      outcome: { kind: "charged", costUsd: 0 },
      setup: () =>
        respond({
          status_code: 40203,
          status_message: "Cost limit exceeded.",
          cost: 0,
          tasks: null,
        }),
    },
    {
      failure: "a billed response that fails validation at its cost",
      outcome: { kind: "charged", costUsd: 0.002, feature: "backlinks" },
      setup: () =>
        respond({
          status_code: 20000,
          cost: 0.002,
          tasks: [{ status_code: 20000 }],
        }),
    },
    {
      failure: "an error before any request was sent",
      outcome: { kind: "released" },
      setup: () =>
        vi
          .mocked(fetchBacklinksSummary)
          .mockRejectedValue(new AppError("VALIDATION_ERROR")),
    },
    {
      failure: "an HTTP 4xx refusal",
      outcome: { kind: "released" },
      setup: () =>
        failThroughRequestLayer(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              new Response("Payment Required", { status: 402 }),
            ),
        ),
    },
    {
      failure: "an HTTP 5xx",
      outcome: { kind: "unknown" },
      setup: () =>
        failThroughRequestLayer(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response("upstream error", { status: 500 })),
        ),
    },
    {
      failure: "a transport failure after sending",
      outcome: { kind: "unknown" },
      setup: () =>
        failThroughRequestLayer(
          vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network")),
        ),
    },
  ])("settles $failure as $outcome.kind", async ({ outcome, setup }) => {
    setup();

    const client = createDataforseoClient(billingCustomer);
    await expect(client.backlinks.summary(backlinksInput)).rejects.toThrow();

    expect(settleMock).toHaveBeenCalledExactlyOnceWith({
      ...projectScope,
      outcomes: [expect.objectContaining({ usageId: "usage_0", ...outcome })],
    });
  });

  it("returns the results when the settlement write fails", async () => {
    mockDataforseoResult(RAW_COST);
    settleMock.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const client = createDataforseoClient(billingCustomer);
    await expect(client.backlinks.summary(backlinksInput)).resolves.toEqual({
      rank: 42,
    });

    expect(consoleError).toHaveBeenCalledWith(
      "dataforseo.project-settle-failed",
      expect.objectContaining({ ...projectScope, usageIds: ["usage_0"] }),
    );
  });

  it("refuses to spend for a customer without a project", async () => {
    mockDataforseoResult(RAW_COST);

    const client = createDataforseoClient({
      ...billingCustomer,
      projectId: "",
    });
    await expect(client.backlinks.summary(backlinksInput)).rejects.toThrow(
      "no project",
    );

    expect(admitMock).not.toHaveBeenCalled();
    expect(fetchBacklinksSummary).not.toHaveBeenCalled();
  });
});

describe("meterDataforseoCall", () => {
  it("never calls the provider when the hold is refused", async () => {
    setupHostedMode();
    mockMonthlyBalance(0);
    mockDataforseoResult(RAW_COST);

    const client = createDataforseoClient(billingCustomer);
    await expect(
      client.backlinks.summary(backlinksInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });

    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(fetchBacklinksSummary).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("holds the estimate, then confirms the hold at the billed cost", async () => {
    setupHostedMode();
    mockMonthlyBalance(5000);
    mockDataforseoResult(RAW_COST);

    const client = createDataforseoClient(billingCustomer);
    const result = await client.backlinks.summary(backlinksInput);

    expect(result).toEqual({ rank: 42 });
    expect(checkMock).toHaveBeenCalledTimes(1);
    const [holdCall] = checkMock.mock.calls[0];
    expect(holdCall).toMatchObject({
      customerId: "org_123",
      featureId: AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
      requiredBalance: ESTIMATED_CREDITS,
    });
    // The execute + settle chain is registered with the request so a client
    // disconnect after dispatch cannot skip the deduction.
    expect(vi.mocked(waitUntil)).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock.mock.calls[0][0]).toMatchObject({
      lockId: holdCall.lock?.lockId,
      action: "confirm",
      overrideValue: EXPECTED_CREDITS,
    });
  });

  it("confirms a charged DataForSEO task failure at its cost before rethrowing", async () => {
    setupHostedMode();
    mockMonthlyBalance(5000);
    vi.mocked(fetchBacklinksSummary).mockRejectedValue(
      new DataforseoChargedTaskError("DataForSEO task failed", {
        costUsd: RAW_COST,
        path: backlinksPath,
      }),
    );

    const client = createDataforseoClient(billingCustomer);
    await expect(client.backlinks.summary(backlinksInput)).rejects.toThrow(
      "DataForSEO task failed",
    );

    expect(finalizeMock.mock.calls[0][0]).toMatchObject({
      action: "confirm",
      overrideValue: EXPECTED_CREDITS,
    });
  });

  it("releases the hold for an unbilled invalid-field failure and throws VALIDATION_ERROR", async () => {
    setupHostedMode();
    mockMonthlyBalance(5000);
    vi.mocked(fetchBacklinksSummary).mockRejectedValue(
      new DataforseoChargedTaskError(
        "Invalid Field: 'target'.",
        { costUsd: 0, path: backlinksPath },
        true,
      ),
    );

    const client = createDataforseoClient(billingCustomer);
    await expect(
      client.backlinks.summary(backlinksInput),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(finalizeMock.mock.calls[0][0]).toMatchObject({ action: "release" });
  });

  it("releases the hold when the provider call fails before billing", async () => {
    setupHostedMode();
    mockMonthlyBalance(5000);
    vi.mocked(fetchBacklinksSummary).mockRejectedValue(
      new AppError("UPSTREAM_UNAVAILABLE", "DataForSEO timed out"),
    );

    const client = createDataforseoClient(billingCustomer);
    await expect(
      client.backlinks.summary(backlinksInput),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

    expect(vi.mocked(waitUntil)).toHaveBeenCalledTimes(1);
    expect(finalizeMock.mock.calls[0][0]).toMatchObject({ action: "release" });
  });
});

describe("rankCheckBatch", () => {
  const input = {
    keyword: "running shoes",
    keywordId: "kw_1",
    locationCode: 2840,
    languageCode: "en",
    device: "desktop" as const,
    targetDomain: "example.com",
    depth: 10,
  };
  const callEstimate = creditsForProviderUsd(
    dataforseoPricing.serp.rankCheck(input),
  );
  // 2 * ceil(1.28) = 4 credits for two calls, not ceil(2.56) = 3 for their
  // summed cost: each call is credited as it would be unbatched.
  const billed = {
    data: {
      keywordId: "kw_1",
      keyword: "running shoes",
      position: 3,
      url: null,
      serpFeatures: [],
    },
    billing: {
      costUsd: 0.001,
      path: ["v3", "serp", "google", "organic", "live", "advanced"],
    },
  };

  it("bills the batch with one hold on the summed estimate and one confirm on the billed calls", async () => {
    setupHostedMode();
    mockMonthlyBalance(5000);
    vi.mocked(fetchRankCheckSerp)
      .mockResolvedValueOnce(billed)
      .mockRejectedValueOnce(
        new AppError("UPSTREAM_UNAVAILABLE", "DataForSEO timed out"),
      )
      .mockResolvedValueOnce(billed);

    const client = createDataforseoClient(billingCustomer);
    const settled = await client.serp.rankCheckBatch([input, input, input]);

    expect(settled.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(checkMock.mock.calls[0][0]).toMatchObject({
      requiredBalance: 3 * callEstimate,
    });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock.mock.calls[0][0]).toMatchObject({
      action: "confirm",
      overrideValue: 2 * creditsForProviderUsd(0.001),
    });
  });

  it("splits a batch across monthly and top-up when only both together cover it", async () => {
    setupHostedMode();
    // Monthly covers two calls, top-up one: neither covers all three.
    checkMock.mockImplementation(async (args) => {
      const balance =
        args.featureId === AUTUMN_SEO_DATA_BALANCE_FEATURE_ID
          ? 2 * callEstimate
          : callEstimate;
      return {
        allowed: balance >= (args.requiredBalance ?? 1),
        balance: { remaining: balance },
      };
    });
    vi.mocked(fetchRankCheckSerp).mockResolvedValue(billed);

    const client = createDataforseoClient(billingCustomer);
    const settled = await client.serp.rankCheckBatch([input, input, input]);

    expect(settled.every((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    );
    // After the refused whole-batch monthly hold.
    const [monthlyHold, topupHold] = checkMock.mock.calls
      .slice(1)
      .map(([arg]) => arg);
    expect(monthlyHold).toMatchObject({
      featureId: AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
      requiredBalance: 2 * callEstimate,
    });
    expect(topupHold).toMatchObject({
      featureId: AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
      requiredBalance: callEstimate,
    });
    expect(finalizeMock.mock.calls.map(([arg]) => arg)).toMatchObject([
      {
        lockId: monthlyHold.lock?.lockId,
        overrideValue: 2 * creditsForProviderUsd(0.001),
      },
      {
        lockId: topupHold.lock?.lockId,
        overrideValue: creditsForProviderUsd(0.001),
      },
    ]);
  });

  it("self-hosted: admits the batch once, one raw estimate per call, and settles it once", async () => {
    setupSelfHostedMode();
    vi.mocked(fetchRankCheckSerp)
      .mockResolvedValueOnce(billed)
      .mockRejectedValueOnce(
        new DataforseoChargedTaskError(
          "DataForSEO task failed",
          billed.billing,
        ),
      )
      .mockRejectedValueOnce(new AppError("VALIDATION_ERROR"));

    const client = createDataforseoClient({
      ...billingCustomer,
      runId: "run_123",
    });
    const settled = await client.serp.rankCheckBatch([input, input, input]);

    expect(settled.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    const estimate = dataforseoPricing.serp.rankCheck(input);
    expect(admitMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operation: "serp.rankCheckBatch",
        feature: "rank_tracking",
        runId: "run_123",
        estimatesUsd: [estimate, estimate, estimate],
      }),
    );
    expect(settleMock).toHaveBeenCalledOnce();
    const { outcomes } = settleMock.mock.calls[0][0];
    expect(outcomes).toHaveLength(3);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { usageId: "usage_0", kind: "charged", costUsd: 0.001 },
        { usageId: "usage_1", kind: "charged", costUsd: 0.001 },
        { usageId: "usage_2", kind: "released" },
      ]),
    );
  });

  it("self-hosted: a refused batch rejects every call and sends none", async () => {
    setupSelfHostedMode();
    admitMock.mockRejectedValue(new AppError("PROJECT_BUDGET_EXCEEDED"));

    const client = createDataforseoClient(billingCustomer);
    const settled = await client.serp.rankCheckBatch([input, input]);

    const refused = {
      status: "rejected",
      reason: { code: "PROJECT_BUDGET_EXCEEDED" },
    };
    expect(settled).toMatchObject([refused, refused]);
    expect(fetchRankCheckSerp).not.toHaveBeenCalled();
    expect(settleMock).not.toHaveBeenCalled();
  });

  it("self-hosted: a failed admission write fails the batch and sends nothing", async () => {
    setupSelfHostedMode();
    admitMock.mockRejectedValue(new Error("database unavailable"));

    const client = createDataforseoClient(billingCustomer);
    await expect(client.serp.rankCheckBatch([input])).rejects.toThrow(
      "database unavailable",
    );

    expect(fetchRankCheckSerp).not.toHaveBeenCalled();
  });
});

describe("mapDataforseoPathToCreditFeature", () => {
  it.each([
    ["v3/dataforseo_labs/google/related_keywords/live", "keyword_research"],
    ["v3/dataforseo_labs/google/keyword_suggestions/live", "keyword_research"],
    ["v3/serp/google/organic/live/regular", "keyword_research"],
    ["v3/keywords_data/google_ads/search_volume/live", "keyword_research"],
    ["v3/dataforseo_labs/google/domain_rank_overview/live", "domain_overview"],
    ["v3/dataforseo_labs/google/ranked_keywords/live", "domain_overview"],
    ["v3/dataforseo_labs/google/relevant_pages/live", "domain_overview"],
    ["v3/backlinks/summary/live", "backlinks"],
    ["backlinks/summary", "backlinks"],
    ["v3/backlinks/referring_domains/live", "backlinks"],
    ["v3/on_page/lighthouse/live/json", "site_audit"],
    ["v3/ai_optimization/llm_mentions/search/live", "ai_citations"],
    ["v3/ai_optimization/llm_mentions/aggregated_metrics/live", "ai_citations"],
    ["v3/ai_optimization/llm_mentions/top_pages/live", "ai_citations"],
    [
      "v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
      "keyword_research",
    ],
    ["v3/ai_optimization/chat_gpt/llm_responses/live", "ai_prompt_responses"],
    ["v3/ai_optimization/claude/llm_responses/live", "ai_prompt_responses"],
    ["v3/ai_optimization/gemini/llm_responses/live", "ai_prompt_responses"],
    ["v3/ai_optimization/perplexity/llm_responses/live", "ai_prompt_responses"],
    ["v3/business_data/business_listings/search/live", "local_seo"],
    ["v3/serp/google/local_finder/live/advanced", "local_seo"],
    ["v3/serp/google/maps/live/advanced", "local_seo"],
  ])("maps %s to %s", (path, feature) => {
    expect(mapDataforseoPathToCreditFeature(path.split("/"))).toBe(feature);
  });
});
