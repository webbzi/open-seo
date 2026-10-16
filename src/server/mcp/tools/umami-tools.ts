import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  UMAMI_BREAKDOWN_DIMENSIONS,
  UMAMI_TRAFFIC_SOURCES,
  UmamiReportService,
  type UmamiBreakdown,
  type UmamiBreakdownRow,
  type UmamiOverview,
  type UmamiReportSource,
} from "@/server/features/umami/services/UmamiReportService";
import { UmamiError } from "@/server/lib/umamiErrors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { looseObjectOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  formatMcpCell,
  formatMcpTable,
  percentCell,
  type McpTableColumn,
} from "@/server/mcp/table";
import { buildDashboardUrl } from "@/server/mcp/urls";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe(
    "Inclusive YYYY-MM-DD date. Provide both startDate and endDate, or neither. Default: the last 28 complete days, ending yesterday in the project's Umami time zone.",
  );

const errorDetailSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().nullable().optional(),
    integrationsUrl: z.string().optional(),
  })
  .passthrough();

// The MCP SDK can only publish and validate a top-level object schema — a
// discriminated union normalizes to undefined, which drops the schema from
// tools/list. So the ok/error branches share one object, with the per-status
// required fields enforced by a refinement (same approach as the GA4 tools).
function umamiEnvelopeSchema(okShape: Record<string, z.ZodType>) {
  const optionalShape = Object.fromEntries(
    Object.entries(okShape).map(([key, field]) => [key, field.optional()]),
  );
  return z
    .object({
      status: z.enum(["ok", "error"]),
      ...optionalShape,
      error: errorDetailSchema.optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      const required =
        value.status === "error" ? ["error"] : Object.keys(okShape);
      for (const key of required) {
        if ((value as Record<string, unknown>)[key] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when status is ${value.status}`,
          });
        }
      }
    });
}

const overviewOutputSchema = umamiEnvelopeSchema({
  source: looseObjectOutputSchema,
  request: looseObjectOutputSchema,
  current: looseObjectOutputSchema,
  previous: looseObjectOutputSchema,
  comparison: looseObjectOutputSchema,
  trend: z.array(looseObjectOutputSchema),
  channels: z.array(looseObjectOutputSchema),
  warnings: z.array(z.string()),
});

const breakdownOutputSchema = umamiEnvelopeSchema({
  source: looseObjectOutputSchema,
  request: looseObjectOutputSchema,
  rowCount: z.number(),
  rows: z.array(looseObjectOutputSchema),
  pageInfo: looseObjectOutputSchema,
  warnings: z.array(z.string()),
});

type ProjectContext = {
  auth: { organizationId: string };
  baseUrl: string;
  project: unknown;
};

const ACCESS_DESCRIPTION =
  "Reads only the Umami website connected to an OpenSEO project the caller is authorized to access. The server selects the website from that project's saved connection. Read-only and uses no OpenSEO credits.";

const annotations = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
};

function errorResponse(
  args: { projectId: string },
  context: ProjectContext,
  error: unknown,
): CallToolResult {
  let code: string;
  let message: string;
  let retryable = false;
  let retryAfterSeconds: number | null | undefined;
  if (error instanceof UmamiError) {
    code = error.code;
    message = error.message;
    retryable = error.retryable;
    retryAfterSeconds = error.retryAfterSeconds;
  } else {
    throw error;
  }
  const integrationsUrl =
    code === "umami_not_connected" || code === "umami_not_configured"
      ? buildDashboardUrl(
          context.baseUrl,
          `/p/${args.projectId}/settings/integrations`,
        )
      : undefined;
  return mcpResponse({
    text: `Umami error ${code}: ${message}${integrationsUrl ? ` Continue here: ${integrationsUrl}` : ""}`,
    meta: buildProjectMeta(context, args.projectId),
    structuredContent: {
      status: "error",
      error: { code, message, retryable, retryAfterSeconds, integrationsUrl },
    },
  });
}

function sourceLine(source: UmamiReportSource) {
  return `Website: ${source.websiteName} (${source.websiteDomain ?? "no domain"}, ${source.websiteId})`;
}

const WARNING_EXPLANATIONS: Record<string, string> = {
  end_date_clamped:
    "endDate was today or later, so it was moved to yesterday (the last complete day).",
  search_engine_referrer_approximation:
    "Counts landings whose referrer is a search engine, including paid-search clicks, so it can exceed the overview's organicSearch channel.",
  trend_omitted_range_too_long:
    "The range is longer than 184 days, so the daily trend is left out (Umami would switch to monthly buckets); totals, comparison and channels are unaffected.",
};

function warningsLine(warnings: readonly string[]) {
  if (warnings.length === 0) return "";
  const lines = warnings.map(
    (code) =>
      `- ${code}${WARNING_EXPLANATIONS[code] ? `: ${WARNING_EXPLANATIONS[code]}` : ""}`,
  );
  return `\nWarnings:\n${lines.join("\n")}`;
}

function headerText(
  label: string,
  result: UmamiOverview | UmamiBreakdown,
): string {
  const { resolvedDateRange: range, timeZone } = result.request;
  return `${label} for ${range.startDate} through ${range.endDate} (${timeZone}).\n${sourceLine(result.source)}`;
}

const TOTALS_METRICS = [
  "pageviews",
  "visitors",
  "visits",
  "bounces",
  "bounceRate",
  "totalTimeSeconds",
  "avgVisitSeconds",
] as const satisfies ReadonlyArray<keyof UmamiOverview["current"]>;

function overviewText(result: UmamiOverview): string {
  const previous = result.request.previousDateRange;
  const header = `${headerText("Umami overview", result)}\nCompared with ${previous.startDate} through ${previous.endDate}.`;
  const totals = formatMcpTable(TOTALS_METRICS, [
    { header: "metric", value: (metric) => metric },
    { header: "current", value: (metric) => result.current[metric] },
    { header: "previous", value: (metric) => result.previous[metric] },
    {
      header: "change",
      value: (metric) => result.comparison[metric].change,
    },
    {
      header: "percentChange",
      value: (metric) => result.comparison[metric].percentChange,
      format: percentCell,
    },
  ]);
  const trend = formatMcpTable(result.trend, [
    { header: "date", value: (row) => row.date },
    { header: "pageviews", value: (row) => row.pageviews },
    { header: "visitors", value: (row) => row.visitors },
  ]);
  const channels =
    result.channels.length === 0
      ? ""
      : `\n\nChannels:\n${formatMcpTable(result.channels, [
          { header: "channel", value: (row) => row.channel },
          { header: "visits", value: (row) => row.visits },
        ])}`;
  return `${header}${warningsLine(result.warnings)}\n\n${totals}\n\nDaily trend:\n${trend}${channels}`;
}

const BREAKDOWN_COLUMNS: McpTableColumn<UmamiBreakdownRow>[] = [
  { header: "value", value: (row) => row.value },
  { header: "pageviews", value: (row) => row.pageviews },
  { header: "visitors", value: (row) => row.visitors },
  { header: "visits", value: (row) => row.visits },
  { header: "bounces", value: (row) => row.bounces },
  { header: "totalTimeSeconds", value: (row) => row.totalTimeSeconds },
];

function breakdownText(result: UmamiBreakdown): string {
  const { dimension, trafficSource } = result.request;
  const paginate = result.pageInfo.hasMore
    ? ` More rows are available; call again with offset=${formatMcpCell(result.pageInfo.nextOffset)}.`
    : "";
  const header = `${headerText(`Umami ${dimension} breakdown (trafficSource=${trafficSource}): ${result.rowCount} rows`, result)}${paginate}`;
  const rows =
    result.rows.length === 0
      ? ""
      : `\n\n${formatMcpTable(result.rows, BREAKDOWN_COLUMNS)}`;
  return `${header}${warningsLine(result.warnings)}${rows}`;
}

const overviewInputSchema = z.strictObject({
  projectId: projectIdSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
});
type OverviewArgs = z.infer<typeof overviewInputSchema>;

export const getUmamiOverviewTool = {
  name: "get_umami_overview",
  config: {
    title: "Get Umami overview",
    description: `Answer whether traffic is improving with Umami pageviews, visitors, visits, bounce rate and visit time versus the previous equal-length period, plus the daily trend and the channel mix. ${ACCESS_DESCRIPTION}`,
    inputSchema: overviewInputSchema,
    outputSchema: overviewOutputSchema,
    annotations,
  },
  handler: withMcpProjectAuth(async (args: OverviewArgs, context) => {
    try {
      const result = await UmamiReportService.getOverview({
        projectId: args.projectId,
        organizationId: context.auth.organizationId,
        startDate: args.startDate,
        endDate: args.endDate,
      });
      return mcpResponse({
        text: overviewText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const breakdownInputSchema = z.strictObject({
  projectId: projectIdSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  dimension: z
    .enum(UMAMI_BREAKDOWN_DIMENSIONS)
    .describe(
      "What to group by: page (any viewed path), landing_page (first page of a visit), exit_page, referrer_domain, channel, country, device, utm_* and so on. For event, the pageviews column counts event occurrences.",
    ),
  trafficSource: z.enum(UMAMI_TRAFFIC_SOURCES).optional().default("all"),
  limit: z.number().int().min(1).max(1_000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
});
type BreakdownArgs = z.infer<typeof breakdownInputSchema>;

export const getUmamiBreakdownTool = {
  name: "get_umami_breakdown",
  config: {
    title: "Get Umami breakdown",
    description: `Break Umami traffic down by one dimension (page, landing page, referrer domain, channel, country, device, UTM and more) with pageviews, visitors, visits, bounces and time on site. trafficSource=search_engines works only with dimension=landing_page: it counts landings whose referrer is a search engine, including paid-search clicks. A metric Umami does not compute for a dimension is null. For dimension=event, the pageviews column counts event occurrences. ${ACCESS_DESCRIPTION}`,
    inputSchema: breakdownInputSchema,
    outputSchema: breakdownOutputSchema,
    annotations,
  },
  handler: withMcpProjectAuth(async (args: BreakdownArgs, context) => {
    try {
      const result = await UmamiReportService.getBreakdown({
        ...args,
        organizationId: context.auth.organizationId,
      });
      return mcpResponse({
        text: breakdownText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { status: "ok", ...result },
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};
