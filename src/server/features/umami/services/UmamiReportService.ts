// Read contract for Umami reports, shared by the MCP tools and the dashboard.
// The methods below are stubs until the report service is implemented; the
// exported names, types and signatures are fixed.

export const UMAMI_BREAKDOWN_DIMENSIONS = [
  "page",
  "landing_page",
  "exit_page",
  "page_title",
  "referrer_domain",
  "channel",
  "country",
  "device",
  "browser",
  "os",
  "language",
  "event",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "hostname",
] as const;
export type UmamiBreakdownDimension =
  (typeof UMAMI_BREAKDOWN_DIMENSIONS)[number];

/** `search_engines` is valid only with the `landing_page` dimension. */
export const UMAMI_TRAFFIC_SOURCES = ["all", "search_engines"] as const;
export type UmamiTrafficSource = (typeof UMAMI_TRAFFIC_SOURCES)[number];

type ProjectScope = { projectId: string; organizationId: string };
/** Inclusive YYYY-MM-DD dates in the connection's time zone; both or neither. */
type DateInput = { startDate?: string; endDate?: string };
type DateRange = { startDate: string; endDate: string };

export type UmamiReportSource = {
  provider: "umami";
  websiteId: string;
  websiteName: string;
  websiteDomain: string | null;
};

type UmamiReportRequest = {
  requestedDateRange: { startDate: string | null; endDate: string | null };
  resolvedDateRange: DateRange;
  timeZone: string;
};

export type UmamiTotals = {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  /** bounces / visits, from 0 to 1; null when visits is 0. */
  bounceRate: number | null;
  totalTimeSeconds: number;
  /** totalTimeSeconds / visits; null when visits is 0. */
  avgVisitSeconds: number | null;
};

export type UmamiMetricChange = {
  /** current - previous; null when either side is null. */
  change: number | null;
  /** (current - previous) / previous; null when previous is 0 or null. */
  percentChange: number | null;
};

export type UmamiOverview = {
  source: UmamiReportSource;
  request: UmamiReportRequest & { previousDateRange: DateRange };
  current: UmamiTotals;
  previous: UmamiTotals;
  comparison: Record<keyof UmamiTotals, UmamiMetricChange>;
  /** One row per local day of the resolved range, oldest first, zero-filled. */
  trend: Array<{ date: string; pageviews: number; visits: number }>;
  /** Umami channel keys (organicSearch, direct, referral, paidAds, ...),
   *  visits descending. */
  channels: Array<{ channel: string; visits: number }>;
  /** Stable codes such as `end_date_clamped`. */
  warnings: string[];
};

/** A metric Umami does not compute for the dimension is null, never 0. */
export type UmamiBreakdownRow = {
  value: string;
  pageviews: number | null;
  visitors: number | null;
  visits: number | null;
  bounces: number | null;
  totalTimeSeconds: number | null;
};

export type UmamiBreakdown = {
  source: UmamiReportSource;
  request: UmamiReportRequest & {
    dimension: UmamiBreakdownDimension;
    trafficSource: UmamiTrafficSource;
    limit: number;
    offset: number;
  };
  rowCount: number;
  rows: UmamiBreakdownRow[];
  pageInfo: {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
  /** Stable codes such as `end_date_clamped` and
   *  `search_engine_referrer_approximation`. */
  warnings: string[];
};

/** Throws UmamiError: umami_not_configured, umami_not_connected,
 *  validation_error, or any upstream code from the client. */
async function getOverview(
  _input: ProjectScope & DateInput,
): Promise<UmamiOverview> {
  throw new Error("UmamiReportService.getOverview is not implemented yet.");
}

/** Throws like getOverview. `limit` is 1 to 1,000; `offset` is 0 or more. */
async function getBreakdown(
  _input: ProjectScope &
    DateInput & {
      dimension: UmamiBreakdownDimension;
      trafficSource: UmamiTrafficSource;
      limit: number;
      offset: number;
    },
): Promise<UmamiBreakdown> {
  throw new Error("UmamiReportService.getBreakdown is not implemented yet.");
}

export const UmamiReportService = { getOverview, getBreakdown };
