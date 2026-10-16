import { SkeletonTableRows } from "@/client/components/SkeletonPresets";
import { CardShell } from "@/client/components/CardShell";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { moreDetailsClass } from "@/client/features/dashboard/cardParts";
import { MetricsTable } from "@/client/components/MetricsTable";
import {
  formatCount,
  formatCtr,
} from "@/client/features/search-performance/SearchPerformanceColumns";
import { getUmamiDashboardReport } from "@/serverFunctions/umami";
import { Skeleton } from "@/client/components/ui/skeleton";

const NOT_CONNECTED_COPY = {
  umami_not_configured: "Umami isn’t set up on this deployment.",
  umami_not_connected: "No Umami website is connected to this project.",
  umami_website_not_found:
    "The connected website is no longer available to the Umami API key.",
  umami_unauthorized: "Umami rejected the API key.",
} as const;

function statValue(
  value: number | null,
  format: (value: number) => string,
): string {
  return value === null ? "—" : format(value);
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return minutes > 0 ? `${minutes}m ${rounded % 60}s` : `${rounded}s`;
}

function formatShortDate(date: string): string {
  // Construct in local time: Date.parse("2026-08-01") is UTC midnight.
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function ChangeCell({ percentChange }: { percentChange: number | null }) {
  if (percentChange === null) return "—";
  const percent = Math.round(percentChange * 100);
  return (
    <span
      className={
        percent > 0
          ? "text-success"
          : percent < 0
            ? "text-destructive"
            : "text-muted-foreground"
      }
    >
      {percent > 0 ? "+" : ""}
      {percent}%
    </span>
  );
}

export function UmamiCard({
  projectId,
  websiteId,
}: {
  projectId: string;
  websiteId: string | null;
}) {
  const reportQuery = useQuery({
    queryKey: ["dashboardUmamiReport", projectId, websiteId],
    queryFn: () => getUmamiDashboardReport({ data: { projectId } }),
  });
  const result = reportQuery.data;

  const integrationsLink = (
    <Link
      to="/p/$projectId/settings/integrations"
      params={{ projectId }}
      hash="umami"
      className={moreDetailsClass}
    >
      {result && !result.connected ? "Open Integrations" : "Manage"}
    </Link>
  );

  let body;
  if (reportQuery.isError) {
    body = (
      <p className="text-sm text-muted-foreground">
        Couldn&rsquo;t load Umami data. Try again shortly.
      </p>
    );
  } else if (!result) {
    body = (
      <div className="space-y-3" aria-busy>
        <SkeletonTableRows rows={5} columns={3} />
        <Skeleton className="h-6" />
      </div>
    );
  } else if (!result.connected) {
    body = (
      <p className="text-sm text-muted-foreground">
        {NOT_CONNECTED_COPY[result.reason]} Check the Umami settings in
        Integrations.
      </p>
    );
  } else {
    const { report } = result;
    const { current, comparison, channels } = report;
    const { startDate, endDate } = report.request.resolvedDateRange;
    const organicVisits =
      channels.find((row) => row.channel === "organicSearch")?.visits ?? 0;
    const searchShare =
      current.visits > 0 ? organicVisits / current.visits : null;

    body = (
      <>
        <p className="mb-4 text-sm text-muted-foreground">
          {report.source.websiteName} · {formatShortDate(startDate)} –{" "}
          {formatShortDate(endDate)} · {report.request.timeZone}
        </p>
        {current.pageviews === 0 && current.visits === 0 ? (
          <p className="text-sm text-muted-foreground">
            No traffic recorded in this period yet.
          </p>
        ) : (
          <MetricsTable
            showChange
            rows={[
              {
                label: "Visitors",
                value: statValue(current.visitors, formatCount),
                change: (
                  <ChangeCell
                    percentChange={comparison.visitors.percentChange}
                  />
                ),
              },
              {
                label: "Visits",
                value: statValue(current.visits, formatCount),
                change: (
                  <ChangeCell percentChange={comparison.visits.percentChange} />
                ),
              },
              {
                label: "Pageviews",
                value: statValue(current.pageviews, formatCount),
                change: (
                  <ChangeCell
                    percentChange={comparison.pageviews.percentChange}
                  />
                ),
              },
              {
                label: "Bounce rate",
                value: statValue(current.bounceRate, formatCtr),
                change: (
                  <ChangeCell
                    percentChange={comparison.bounceRate.percentChange}
                  />
                ),
              },
              {
                label: "Avg. visit duration",
                value: statValue(current.avgVisitSeconds, formatDuration),
                change: (
                  <ChangeCell
                    percentChange={comparison.avgVisitSeconds.percentChange}
                  />
                ),
              },
              {
                label: "Search engine share",
                value: statValue(searchShare, formatCtr),
              },
            ]}
          />
        )}
      </>
    );
  }

  return (
    <CardShell title="Umami analytics" action={integrationsLink}>
      {body}
    </CardShell>
  );
}
