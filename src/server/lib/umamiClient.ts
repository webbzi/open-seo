import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { UmamiError } from "@/server/lib/umamiErrors";
import {
  looksLikeUmamiApiKey,
  parseUmamiApiUrl,
} from "@/shared/selfhost-checks";

const REQUEST_TIMEOUT_MS = 15_000;
const WEBSITES_PAGE_SIZE = 100;
const MAX_WEBSITE_PAGES = 100;
const MAX_RETRY_AFTER_SECONDS = 86_400;

/** The deployment's one Umami instance (v3.4+), set by the operator. */
export type UmamiConfig = { baseUrl: string; apiKey: string };

/** Null unless both variables are present and valid: Umami is then off. */
export async function getUmamiConfig(): Promise<UmamiConfig | null> {
  const [rawUrl, rawKey] = await Promise.all([
    getOptionalEnvValue("UMAMI_API_URL"),
    getOptionalEnvValue("UMAMI_API_KEY"),
  ]);
  const baseUrl = rawUrl ? parseUmamiApiUrl(rawUrl) : null;
  const apiKey = rawKey?.trim();
  return baseUrl && apiKey && looksLikeUmamiApiKey(apiKey)
    ? { baseUrl, apiKey }
    : null;
}

const websiteSchema = z.object({
  id: z.guid(),
  name: z.string(),
  // Umami's own column is nullable, although its UI always sets it.
  domain: z.string().nullable(),
});

const websitesPageSchema = z.object({
  data: z.array(websiteSchema),
  count: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
});

type UmamiWebsite = z.infer<typeof websiteSchema>;

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS);
}

function errorForStatus(response: Response): UmamiError {
  const { status } = response;
  // Umami answers 401 both for a bad key and for a website the key cannot read.
  if (status === 401 || status === 403) {
    return new UmamiError(
      "umami_unauthorized",
      "Umami rejected the API key or denied access to the website.",
    );
  }
  if (status === 404) {
    return new UmamiError(
      "umami_website_not_found",
      "Umami website not found.",
    );
  }
  if (status === 429) {
    return new UmamiError(
      "umami_rate_limited",
      "Umami rate limit reached.",
      retryAfterSeconds(response),
    );
  }
  if (status >= 500) {
    return new UmamiError(
      "umami_upstream_unavailable",
      `Umami is temporarily unavailable (${status}).`,
    );
  }
  return new UmamiError(
    "umami_bad_request",
    `Umami rejected the request (${status}).`,
  );
}

async function request<T>(
  config: UmamiConfig,
  path: string,
  query: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = new URL(`${config.baseUrl}/api${path}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
      },
      // Never follow a redirect: it could carry the bearer token to another
      // host. "manual" (not "error", which Workers may reject) returns the 3xx
      // response, which the !response.ok check below turns into an error.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Network failure or timeout.
    throw new UmamiError(
      "umami_upstream_unavailable",
      "Umami is temporarily unavailable.",
    );
  }
  if (!response.ok) throw errorForStatus(response);

  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new UmamiError(
      "umami_malformed_response",
      "Umami returned an unexpected response.",
    );
  }
  return parsed.data;
}

// Postgres returns some sums (pageviews, totaltime) as strings.
const umamiNumber = z.coerce.number().finite();

const statsTotalsShape = {
  pageviews: umamiNumber,
  visitors: umamiNumber,
  visits: umamiNumber,
  bounces: umamiNumber,
  totaltime: umamiNumber,
};
const statsSchema = z.object(statsTotalsShape);
type UmamiStats = z.infer<typeof statsSchema>;

const seriesSchema = z.array(z.object({ x: z.string(), y: umamiNumber }));
const pageviewsSchema = z.object({
  pageviews: seriesSchema,
  sessions: seriesSchema,
});

const expandedMetricsSchema = z.array(
  z.object({ name: z.string().nullable(), ...statsTotalsShape }),
);
type UmamiExpandedMetric = z.infer<typeof expandedMetricsSchema>[number];

/** Metric `type` values of /metrics/expanded that the breakdown uses. */
export type UmamiMetricType =
  | "path"
  | "entry"
  | "exit"
  | "title"
  | "referrer"
  | "channel"
  | "country"
  | "device"
  | "browser"
  | "os"
  | "language"
  | "event"
  | "utmSource"
  | "utmMedium"
  | "utmCampaign"
  | "hostname";

type UmamiWindow = { startAt: number; endAt: number };

const windowQuery = ({ startAt, endAt }: UmamiWindow) => ({
  startAt: String(startAt),
  endAt: String(endAt),
});

/** One website. Umami answers an admin key with `null` for an unknown website
 *  and a deleted website keeps its row, so both are "not found". */
export async function getWebsite(
  config: UmamiConfig,
  websiteId: string,
): Promise<UmamiWebsite> {
  // A malformed id makes Umami answer a bodiless 500.
  if (!z.guid().safeParse(websiteId).success) {
    throw new UmamiError("validation_error", "Invalid Umami website id.");
  }
  const website = await request(
    config,
    `/websites/${websiteId}`,
    {},
    websiteSchema.extend({ deletedAt: z.string().nullable() }).nullable(),
  );
  if (!website || website.deletedAt !== null) {
    throw new UmamiError("umami_website_not_found", "Umami website not found.");
  }
  return website;
}

export function getStats(
  config: UmamiConfig,
  websiteId: string,
  window: UmamiWindow,
): Promise<UmamiStats> {
  return request(
    config,
    `/websites/${websiteId}/stats`,
    windowQuery(window),
    statsSchema,
  );
}

/** Daily page views; days without data are omitted. Each `x` starts with the
 *  local date in `timeZone`. */
export async function getDailyPageviews(
  config: UmamiConfig,
  websiteId: string,
  window: UmamiWindow,
  timeZone: string,
): Promise<z.infer<typeof pageviewsSchema>> {
  return request(
    config,
    `/websites/${websiteId}/pageviews`,
    { ...windowQuery(window), unit: "day", timezone: timeZone },
    pageviewsSchema,
  );
}

export function getChannelVisits(
  config: UmamiConfig,
  websiteId: string,
  window: UmamiWindow,
): Promise<Array<{ x: string; y: number }>> {
  return request(
    config,
    `/websites/${websiteId}/metrics`,
    { ...windowQuery(window), type: "channel" },
    seriesSchema,
  );
}

export function getExpandedMetrics(
  config: UmamiConfig,
  websiteId: string,
  window: UmamiWindow,
  options: {
    type: UmamiMetricType;
    /** Omitted: Umami's default. `type=channel` ignores both. */
    limit?: number;
    offset?: number;
    /** Umami filter syntax, e.g. `re.google|bing`. */
    referrer?: string;
  },
): Promise<UmamiExpandedMetric[]> {
  const { type, limit, offset, referrer } = options;
  return request(
    config,
    `/websites/${websiteId}/metrics/expanded`,
    {
      ...windowQuery(window),
      type,
      ...(limit === undefined ? {} : { limit: String(limit) }),
      ...(offset === undefined ? {} : { offset: String(offset) }),
      ...(referrer ? { referrer } : {}),
    },
    expandedMetricsSchema,
  );
}

/** Every website the API key can see: its own, plus those of teams the key's
 *  user owns or manages (Umami's `includeTeams` rule). */
export async function listWebsites(
  config: UmamiConfig,
): Promise<UmamiWebsite[]> {
  // Keyed by id: offset pages can repeat a row when a website is added
  // between two page reads.
  const websites = new Map<string, UmamiWebsite>();
  for (let page = 1; page <= MAX_WEBSITE_PAGES; page += 1) {
    // The response has no next-page marker: the last page is the one that
    // reaches `count` at the page size Umami actually applied.
    const { data, count, pageSize } = await request(
      config,
      "/websites",
      {
        includeTeams: "true",
        page: String(page),
        pageSize: String(WEBSITES_PAGE_SIZE),
      },
      websitesPageSchema,
    );
    for (const website of data) websites.set(website.id, website);
    if (data.length === 0 || page * pageSize >= count) {
      return [...websites.values()];
    }
  }
  throw new Error(
    `Umami website discovery exceeded ${MAX_WEBSITE_PAGES} pages.`,
  );
}
