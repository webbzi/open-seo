import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as umamiClient from "@/server/lib/umamiClient";
import { UmamiReportService } from "./UmamiReportService";

// Responses mirror a live Umami 3.4.0 instance. The real client runs; only
// fetch, the deployment config and the mapping lookup are replaced.

const mocks = vi.hoisted(() => ({
  getUmamiConfig: vi.fn(),
  getByProjectId: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/lib/umamiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof umamiClient>()),
  getUmamiConfig: mocks.getUmamiConfig,
}));
vi.mock(
  "@/server/features/umami/repositories/UmamiConnectionRepository",
  () => ({
    UmamiConnectionRepository: { getByProjectId: mocks.getByProjectId },
  }),
);

const fetchMock = vi.fn<typeof fetch>();

const scope = { projectId: "project", organizationId: "organization" };
const websiteId = "5e420756-52d4-45e2-a6a8-788d614273ee";
const range = { startDate: "2026-09-07", endDate: "2026-09-09" };
const connection = {
  websiteId,
  websiteName: "First",
  websiteDomain: "example.test",
  timeZone: "Europe/Madrid",
};
const website = {
  id: websiteId,
  name: "First",
  domain: "example.test",
  deletedAt: null,
};

const stats = (visits: number, bounces = 0, totaltime = 0) => ({
  pageviews: visits,
  visitors: visits,
  visits,
  bounces,
  totaltime,
});
const metric = (name: string, visits: number, bounces = 0) => ({
  name,
  pageviews: String(visits), // Postgres-backed Umami sends strings
  visitors: visits,
  visits,
  bounces,
  totaltime: "0",
});

const toUrl = (input: Parameters<typeof fetch>[0]) =>
  input instanceof URL
    ? input
    : new URL(input instanceof Request ? input.url : input);

/** Answers by Umami path; `/stats` calls are served in order. */
function serve(routes: Record<string, unknown>, statsBodies: unknown[] = []) {
  fetchMock.mockImplementation((input) => {
    const url = toUrl(input);
    const path = url.pathname.replace(`/api/websites/${websiteId}`, "") || "/";
    const body =
      path === "/stats" ? statsBodies.shift() : (routes[path] ?? null);
    return Promise.resolve(Response.json(body));
  });
}

const urlsCalled = () => fetchMock.mock.calls.map(([url]) => toUrl(url));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  mocks.getUmamiConfig.mockResolvedValue({
    baseUrl: "https://umami.example.com",
    apiKey: "umami_key",
  });
  mocks.getByProjectId.mockResolvedValue(connection);
});

describe("getOverview", () => {
  it("computes totals, rates, comparison and a zero-filled local-date trend", async () => {
    serve(
      {
        "/": website,
        "/pageviews": {
          pageviews: [
            { x: "2026-09-07T00:00:00Z", y: 2 },
            { x: "2026-09-09T00:00:00Z", y: 1 },
          ],
          sessions: [{ x: "2026-09-07T00:00:00Z", y: 1 }],
        },
        "/metrics/expanded": [metric("direct", 1), metric("organicSearch", 3)],
      },
      [stats(4, 2, 80), stats(0)],
    );

    const overview = await UmamiReportService.getOverview({
      ...scope,
      ...range,
    });

    expect(overview.current).toMatchObject({
      visits: 4,
      bounceRate: 0.5,
      avgVisitSeconds: 20,
    });
    expect(overview.previous).toMatchObject({
      visits: 0,
      bounceRate: null,
      avgVisitSeconds: null,
    });
    expect(overview.comparison.visits).toEqual({
      change: 4,
      percentChange: null,
    });
    expect(overview.comparison.bounceRate).toEqual({
      change: null,
      percentChange: null,
    });
    expect(overview.trend).toEqual([
      { date: "2026-09-07", pageviews: 2, visitors: 1 },
      { date: "2026-09-08", pageviews: 0, visitors: 0 },
      { date: "2026-09-09", pageviews: 1, visitors: 0 },
    ]);
    expect(overview.channels).toEqual([
      { channel: "organicSearch", visits: 3 },
      { channel: "direct", visits: 1 },
    ]);
    expect(overview.request.previousDateRange).toEqual({
      startDate: "2026-09-04",
      endDate: "2026-09-06",
    });
  });

  it("omits the daily trend for ranges Umami would bucket by month", async () => {
    serve({ "/": website, "/metrics/expanded": [metric("direct", 1)] }, [
      stats(4),
      stats(0),
    ]);

    const overview = await UmamiReportService.getOverview({
      ...scope,
      startDate: "2026-01-01",
      endDate: "2026-07-04", // 185 days
    });

    expect(overview.trend).toEqual([]);
    expect(overview.warnings).toContain("trend_omitted_range_too_long");
    expect(overview.current.visits).toBe(4);
    expect(overview.channels).toHaveLength(1);
    expect(urlsCalled().some((u) => u.pathname.endsWith("/pageviews"))).toBe(
      false,
    );
  });

  it("reports a website that Umami no longer has", async () => {
    serve({ "/": null });

    await expect(
      UmamiReportService.getOverview({ ...scope, ...range }),
    ).rejects.toMatchObject({ code: "umami_website_not_found" });
  });

  it("fails before any request when the project is not connected", async () => {
    mocks.getByProjectId.mockResolvedValue(null);

    await expect(UmamiReportService.getOverview(scope)).rejects.toMatchObject({
      code: "umami_not_connected",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getBreakdown", () => {
  const input = {
    ...scope,
    ...range,
    trafficSource: "all" as const,
    offset: 0,
  };

  it("maps the dimension to Umami's type and nulls metrics Umami hard-codes", async () => {
    serve({
      "/": website,
      "/metrics/expanded": [metric("/", 14), metric("/blog/a", 10)],
    });

    const page = await UmamiReportService.getBreakdown({
      ...input,
      dimension: "page",
      limit: 100,
    });

    const expanded = urlsCalled().find((u) => u.pathname.endsWith("/expanded"));
    expect(expanded?.searchParams.get("type")).toBe("path");
    expect(page.rows[0]).toEqual({
      value: "/",
      pageviews: 14,
      visitors: 14,
      visits: 14,
      bounces: null,
      totalTimeSeconds: null,
    });
  });

  it("keeps real bounces and time for session dimensions", async () => {
    serve({
      "/": website,
      "/metrics/expanded": [{ ...metric("laptop", 24, 15), totaltime: "720" }],
    });

    const device = await UmamiReportService.getBreakdown({
      ...input,
      dimension: "device",
      limit: 100,
    });

    expect(device.rows[0]).toMatchObject({
      bounces: 15,
      totalTimeSeconds: 720,
    });
  });

  it("reports a deleted website instead of zeroed rows", async () => {
    serve({ "/": { ...website, deletedAt: "2026-10-01T00:00:00Z" } });

    await expect(
      UmamiReportService.getBreakdown({
        ...input,
        dimension: "page",
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: "umami_website_not_found" });
  });

  it("nulls bounces and time for event, where Umami reuses those fields", async () => {
    serve({
      "/": website,
      "/metrics/expanded": [{ ...metric("signup", 5, 3), totaltime: "90" }],
    });

    const events = await UmamiReportService.getBreakdown({
      ...input,
      dimension: "event",
      limit: 100,
    });

    expect(events.rows[0]).toMatchObject({
      pageviews: 5,
      bounces: null,
      totalTimeSeconds: null,
    });
  });

  it("fetches one extra row to report whether another page exists", async () => {
    serve({
      "/": website,
      "/metrics/expanded": [metric("/a", 3), metric("/b", 2), metric("/c", 1)],
    });

    const result = await UmamiReportService.getBreakdown({
      ...input,
      dimension: "page",
      limit: 2,
      offset: 4,
    });

    const expanded = urlsCalled().find((u) => u.pathname.endsWith("/expanded"));
    expect(expanded?.searchParams.get("limit")).toBe("3");
    expect(result.rows.map((r) => r.value)).toEqual(["/a", "/b"]);
    expect(result.pageInfo).toEqual({
      offset: 4,
      limit: 2,
      hasMore: true,
      nextOffset: 6,
    });
  });

  it("pages the channel dimension locally because Umami ignores limit", async () => {
    serve({
      "/": website,
      "/metrics/expanded": ["a", "b", "c", "d"].map((name) => metric(name, 1)),
    });

    const result = await UmamiReportService.getBreakdown({
      ...input,
      dimension: "channel",
      limit: 2,
      offset: 2,
    });

    const expanded = urlsCalled().find((u) => u.pathname.endsWith("/expanded"));
    expect(expanded?.searchParams.has("limit")).toBe(false);
    expect(result.rows.map((r) => r.value)).toEqual(["c", "d"]);
    expect(result.pageInfo).toMatchObject({ hasMore: false, nextOffset: null });
  });

  it("sends the search-engine referrer filter and warns it is approximate", async () => {
    serve({ "/": website, "/metrics/expanded": [metric("/", 9)] });

    const result = await UmamiReportService.getBreakdown({
      ...input,
      dimension: "landing_page",
      trafficSource: "search_engines",
      limit: 10,
    });

    const expanded = urlsCalled().find((u) => u.pathname.endsWith("/expanded"));
    expect(expanded?.searchParams.get("referrer")).toBe(
      String.raw`re.(baidu\.com|bing\.com|duckduckgo\.com|ecosia\.org|google\.|msn\.com|search\.brave\.com|yandex)`,
    );
    expect(result.warnings).toContain("search_engine_referrer_approximation");
    expect(result.pageInfo.hasMore).toBe(false);
  });

  it("rejects search_engines on other dimensions before any request", async () => {
    await expect(
      UmamiReportService.getBreakdown({
        ...input,
        dimension: "page",
        trafficSource: "search_engines",
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.getByProjectId).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
