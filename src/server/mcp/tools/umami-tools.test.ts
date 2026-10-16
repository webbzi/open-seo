import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UmamiBreakdown,
  UmamiOverview,
} from "@/server/features/umami/services/UmamiReportService";
import { UmamiError } from "@/server/lib/umamiErrors";
import { getUmamiBreakdownTool, getUmamiOverviewTool } from "./umami-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getBreakdown: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/umami/services/UmamiReportService",
  async (orig) => ({
    ...(await orig<object>()),
    UmamiReportService: {
      getOverview: mocks.getOverview,
      getBreakdown: mocks.getBreakdown,
    },
  }),
);
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();
const source = {
  provider: "umami",
  websiteId: "site-1",
  websiteName: "Example Site",
  websiteDomain: "example.com",
} as const;
const request = {
  requestedDateRange: { startDate: null, endDate: null },
  resolvedDateRange: { startDate: "2026-09-01", endDate: "2026-09-28" },
  timeZone: "Europe/Madrid",
};
const totals = {
  pageviews: 10,
  visitors: 5,
  visits: 6,
  bounces: 2,
  bounceRate: 0.33,
  totalTimeSeconds: 60,
  avgVisitSeconds: 10,
};
const noChange = { change: 0, percentChange: 0 };

const overview: UmamiOverview = {
  source,
  request: {
    ...request,
    previousDateRange: { startDate: "2026-08-04", endDate: "2026-08-31" },
  },
  current: totals,
  previous: totals,
  comparison: {
    pageviews: noChange,
    visitors: noChange,
    visits: noChange,
    bounces: noChange,
    bounceRate: noChange,
    totalTimeSeconds: noChange,
    avgVisitSeconds: noChange,
  },
  trend: [{ date: "2026-09-01", pageviews: 3, visitors: 2 }],
  channels: [{ channel: "organicSearch", visits: 4 }],
  warnings: ["end_date_clamped"],
};

const breakdown: UmamiBreakdown = {
  source,
  request: {
    ...request,
    dimension: "landing_page",
    trafficSource: "search_engines",
    limit: 100,
    offset: 0,
  },
  rowCount: 1,
  rows: [
    {
      value: "/pricing",
      pageviews: 7,
      visitors: null,
      visits: 4,
      bounces: null,
      totalTimeSeconds: null,
    },
  ],
  pageInfo: { offset: 0, limit: 100, hasMore: false, nextOffset: null },
  warnings: ["search_engine_referrer_approximation"],
};

describe("Umami MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({ id: "project_1" });
    mocks.getOverview.mockResolvedValue(overview);
    mocks.getBreakdown.mockResolvedValue(breakdown);
  });

  it("renders overview text that agrees with structuredContent", async () => {
    const result = await getUmamiOverviewTool.handler(
      { projectId: "project_1" },
      toolContext,
    );
    const text = textContent(result);

    expect(mocks.getOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        organizationId: "org_123",
      }),
    );
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      source: { websiteName: "Example Site" },
      warnings: ["end_date_clamped"],
    });
    expect(text).toContain("Example Site");
    expect(text).toContain("2026-09-01 through 2026-09-28 (Europe/Madrid)");
    expect(text).toContain("end_date_clamped: endDate was today or later");
    expect(text).toContain("organicSearch");
  });

  it("renders breakdown text that agrees with structuredContent", async () => {
    const result = await getUmamiBreakdownTool.handler(
      {
        projectId: "project_1",
        dimension: "landing_page",
        trafficSource: "search_engines",
        limit: 100,
        offset: 0,
      },
      toolContext,
    );
    const text = textContent(result);

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      rowCount: 1,
      warnings: ["search_engine_referrer_approximation"],
    });
    expect(text).toContain("1 rows");
    expect(text).toContain("Example Site");
    expect(text).toContain("2026-09-01 through 2026-09-28 (Europe/Madrid)");
    expect(text).toContain("search_engine_referrer_approximation");
    expect(text).toContain("/pricing");
  });

  it("links the Integrations page when the project is not connected", async () => {
    mocks.getOverview.mockRejectedValue(
      new UmamiError("umami_not_connected", "No Umami website is connected."),
    );
    const result = await getUmamiOverviewTool.handler(
      { projectId: "project_1" },
      toolContext,
    );

    const url = "https://open-seo.test/p/project_1/settings/integrations";
    expect(result.structuredContent).toMatchObject({
      status: "error",
      error: {
        code: "umami_not_connected",
        retryable: false,
        integrationsUrl: url,
      },
    });
    expect(textContent(result)).toContain("umami_not_connected");
    expect(textContent(result)).toContain(url);
  });

  it("reports retry details for a rate-limited error", async () => {
    mocks.getBreakdown.mockRejectedValue(
      new UmamiError("umami_rate_limited", "Umami is rate limiting.", 30),
    );
    const result = await getUmamiBreakdownTool.handler(
      {
        projectId: "project_1",
        dimension: "page",
        trafficSource: "all",
        limit: 100,
        offset: 0,
      },
      toolContext,
    );

    expect(result.structuredContent).toMatchObject({
      status: "error",
      error: {
        code: "umami_rate_limited",
        retryable: true,
        retryAfterSeconds: 30,
      },
    });
  });
});
