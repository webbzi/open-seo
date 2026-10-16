// Read contract for Umami reports, shared by the MCP tools and the dashboard.
import { sortBy } from "remeda";
import { shiftGa4Date } from "@/server/features/ga4/services/Ga4Dates";
import { UmamiConnectionRepository } from "@/server/features/umami/repositories/UmamiConnectionRepository";
import {
  resolveUmamiDateRange,
  type ResolvedUmamiDateRange,
} from "@/server/features/umami/services/umamiDates";
import {
  getDailyPageviews,
  getExpandedMetrics,
  getStats,
  getUmamiConfig,
  getWebsite,
  type UmamiMetricType,
} from "@/server/lib/umamiClient";
import { UmamiError } from "@/server/lib/umamiErrors";

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
  /** One row per local day of the resolved range, oldest first, zero-filled.
   *  Empty when the range is too long for daily buckets
   *  (`trend_omitted_range_too_long`). */
  trend: Array<{ date: string; pageviews: number; visitors: number }>;
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

const MAX_BREAKDOWN_LIMIT = 1_000;
const MAX_TREND_DAYS = 184;

/** Umami's `type` for each dimension, and whether Umami computes bounces and
 *  total time for it. Verified on Umami 3.4: page-level types hard-code both
 *  to 0, so they are null; session types are real. `event` is false too: Umami
 *  reports event occurrences as pageviews, single-event visits as bounces and
 *  the occurrence span as totaltime. The utm types are camelCase in Umami's
 *  API. */
const DIMENSIONS: Record<
  UmamiBreakdownDimension,
  { type: UmamiMetricType; engagement: boolean }
> = {
  page: { type: "path", engagement: false },
  landing_page: { type: "entry", engagement: false },
  exit_page: { type: "exit", engagement: false },
  page_title: { type: "title", engagement: false },
  referrer_domain: { type: "referrer", engagement: false },
  channel: { type: "channel", engagement: true },
  country: { type: "country", engagement: true },
  device: { type: "device", engagement: true },
  browser: { type: "browser", engagement: true },
  os: { type: "os", engagement: true },
  language: { type: "language", engagement: true },
  event: { type: "event", engagement: false },
  utm_source: { type: "utmSource", engagement: false },
  utm_medium: { type: "utmMedium", engagement: false },
  utm_campaign: { type: "utmCampaign", engagement: false },
  hostname: { type: "hostname", engagement: false },
};

// Umami's search-engine referrer domains (SEARCH_DOMAINS in Umami's
// src/lib/constants.ts). `google.` is a prefix that covers every country TLD.
const SEARCH_ENGINE_DOMAINS = [
  "baidu.com",
  "bing.com",
  "duckduckgo.com",
  "ecosia.org",
  "google.",
  "msn.com",
  "search.brave.com",
  "yandex",
];

// Umami filter syntax is `<operator>.<value>`; `re.` is a regex on the
// pageview's own referrer domain. Unanchored, so it is a contains-match like
// Umami's own classification (cn.bing.com, m.baidu.com). No commas: Umami
// splits values on them.
const SEARCH_ENGINE_REFERRER_FILTER = `re.(${SEARCH_ENGINE_DOMAINS.map(
  (domain) => domain.replaceAll(".", "\\."),
).join("|")})`;

async function requireConnected(scope: ProjectScope) {
  const config = await getUmamiConfig();
  if (!config) {
    throw new UmamiError(
      "umami_not_configured",
      "Umami is not configured on this deployment.",
    );
  }
  const connection = await UmamiConnectionRepository.getByProjectId(scope);
  if (!connection) {
    throw new UmamiError(
      "umami_not_connected",
      "This project is not connected to an Umami website.",
    );
  }
  return { config, connection };
}

function resolveRange(input: DateInput, timeZone: string) {
  try {
    return resolveUmamiDateRange({ ...input, timeZone });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new UmamiError("validation_error", error.message);
    }
    throw error;
  }
}

/** Resolves config, connection and dates, then confirms the website still
 *  exists: Umami answers zeroed stats for a deleted one. */
async function prepare(input: ProjectScope & DateInput) {
  const { config, connection } = await requireConnected(input);
  const range = resolveRange(input, connection.timeZone);
  await getWebsite(config, connection.websiteId);
  return { config, connection, range };
}

function reportSource(connection: {
  websiteId: string;
  websiteName: string;
  websiteDomain: string | null;
}): UmamiReportSource {
  return {
    provider: "umami",
    websiteId: connection.websiteId,
    websiteName: connection.websiteName,
    websiteDomain: connection.websiteDomain,
  };
}

function reportRequest(range: ResolvedUmamiDateRange) {
  return {
    requestedDateRange: range.requested,
    resolvedDateRange: {
      startDate: range.current.startDate,
      endDate: range.current.endDate,
    },
    timeZone: range.timeZone,
  };
}

function toTotals(stats: {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}): UmamiTotals {
  return {
    pageviews: stats.pageviews,
    visitors: stats.visitors,
    visits: stats.visits,
    bounces: stats.bounces,
    bounceRate: stats.visits > 0 ? stats.bounces / stats.visits : null,
    totalTimeSeconds: stats.totaltime,
    avgVisitSeconds: stats.visits > 0 ? stats.totaltime / stats.visits : null,
  };
}

function metricChange(
  current: number | null,
  previous: number | null,
): UmamiMetricChange {
  if (current === null || previous === null) {
    return { change: null, percentChange: null };
  }
  return {
    change: current - previous,
    percentChange: previous === 0 ? null : (current - previous) / previous,
  };
}

function compareTotals(
  current: UmamiTotals,
  previous: UmamiTotals,
): UmamiOverview["comparison"] {
  return {
    pageviews: metricChange(current.pageviews, previous.pageviews),
    visitors: metricChange(current.visitors, previous.visitors),
    visits: metricChange(current.visits, previous.visits),
    bounces: metricChange(current.bounces, previous.bounces),
    bounceRate: metricChange(current.bounceRate, previous.bounceRate),
    totalTimeSeconds: metricChange(
      current.totalTimeSeconds,
      previous.totalTimeSeconds,
    ),
    avgVisitSeconds: metricChange(
      current.avgVisitSeconds,
      previous.avgVisitSeconds,
    ),
  };
}

const byLocalDate = (series: Array<{ x: string; y: number }>) =>
  new Map(series.map(({ x, y }) => [x.slice(0, 10), y]));

/** Zero-fills daily buckets only: Umami omits days without data, and its `x`
 *  buckets start with the local date. */
function zeroFilledTrend(
  range: ResolvedUmamiDateRange,
  pageviews: Array<{ x: string; y: number }>,
  visitors: Array<{ x: string; y: number }>,
) {
  const pageviewsByDate = byLocalDate(pageviews);
  const visitorsByDate = byLocalDate(visitors);
  return Array.from({ length: range.dayCount }, (_, index) => {
    const date = shiftGa4Date(range.current.startDate, index);
    return {
      date,
      pageviews: pageviewsByDate.get(date) ?? 0,
      visitors: visitorsByDate.get(date) ?? 0,
    };
  });
}

/** Throws UmamiError: umami_not_configured, umami_not_connected,
 *  validation_error, or any upstream code from the client. */
async function getOverview(
  input: ProjectScope & DateInput,
): Promise<UmamiOverview> {
  const { config, connection, range } = await prepare(input);
  const { websiteId } = connection;
  // Umami silently turns unit=day into months past ~7 calendar months.
  const trendOmitted = range.dayCount > MAX_TREND_DAYS;

  const [current, previous, daily, channels] = await Promise.all([
    getStats(config, websiteId, range.current),
    getStats(config, websiteId, range.previous),
    trendOmitted
      ? null
      : getDailyPageviews(config, websiteId, range.current, range.timeZone),
    getExpandedMetrics(config, websiteId, range.current, { type: "channel" }),
  ]);
  const currentTotals = toTotals(current);
  const previousTotals = toTotals(previous);

  return {
    source: reportSource(connection),
    request: {
      ...reportRequest(range),
      previousDateRange: {
        startDate: range.previous.startDate,
        endDate: range.previous.endDate,
      },
    },
    current: currentTotals,
    previous: previousTotals,
    comparison: compareTotals(currentTotals, previousTotals),
    trend: daily ? zeroFilledTrend(range, daily.pageviews, daily.sessions) : [],
    channels: sortBy(
      channels.map((row) => ({
        channel: row.name ?? "(not set)",
        visits: row.visits,
      })),
      [({ visits }) => visits, "desc"],
    ),
    warnings: [
      ...range.warnings,
      ...(trendOmitted ? ["trend_omitted_range_too_long"] : []),
    ],
  };
}

/** Throws like getOverview. `limit` is 1 to 1,000; `offset` is 0 or more. */
async function getBreakdown(
  input: ProjectScope &
    DateInput & {
      dimension: UmamiBreakdownDimension;
      trafficSource: UmamiTrafficSource;
      limit: number;
      offset: number;
    },
): Promise<UmamiBreakdown> {
  const { dimension, trafficSource, limit, offset } = input;

  // Validate before prepare: invalid input never touches the database or Umami.
  // The referrer filter matches each pageview's own referrer domain, so it
  // is meaningful only for landing pages: on other dimensions it would drop
  // internal navigation or mislabel rows.
  if (trafficSource === "search_engines" && dimension !== "landing_page") {
    throw new UmamiError(
      "validation_error",
      "trafficSource search_engines is valid only with the landing_page dimension.",
    );
  }
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_BREAKDOWN_LIMIT ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new UmamiError(
      "validation_error",
      `limit must be 1 to ${MAX_BREAKDOWN_LIMIT} and offset 0 or more.`,
    );
  }
  const { config, connection, range } = await prepare(input);
  const { websiteId } = connection;

  const { type, engagement } = DIMENSIONS[dimension];
  // Umami ignores limit and offset for `type=channel` (a short, fixed list),
  // so that dimension is read whole and paged here. Elsewhere Umami returns no
  // total, so one extra row tells whether another page exists.
  const pagedLocally = type === "channel";
  const fetched = await getExpandedMetrics(config, websiteId, range.current, {
    type,
    ...(pagedLocally ? {} : { limit: limit + 1, offset }),
    referrer:
      trafficSource === "search_engines"
        ? SEARCH_ENGINE_REFERRER_FILTER
        : undefined,
  });
  const pageRows = pagedLocally
    ? fetched.slice(offset, offset + limit + 1)
    : fetched;
  const hasMore = pageRows.length > limit;
  const rows = pageRows.slice(0, limit).map((row) => ({
    value: row.name ?? "(not set)",
    pageviews: row.pageviews,
    visitors: row.visitors,
    visits: row.visits,
    bounces: engagement ? row.bounces : null,
    totalTimeSeconds: engagement ? row.totaltime : null,
  }));

  return {
    source: reportSource(connection),
    request: {
      ...reportRequest(range),
      dimension,
      trafficSource,
      limit,
      offset,
    },
    rowCount: rows.length,
    rows,
    pageInfo: {
      offset,
      limit,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    },
    warnings: [
      ...range.warnings,
      ...(trafficSource === "search_engines"
        ? ["search_engine_referrer_approximation"]
        : []),
    ],
  };
}

export const UmamiReportService = { getOverview, getBreakdown };
