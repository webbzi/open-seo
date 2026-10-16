import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { EmptyState } from "@/client/components/EmptyState";
import { SectionHeader } from "@/client/components/PageHeader";
import { QueryState } from "@/client/components/QueryState";
import {
  SkeletonCard,
  SkeletonStatGrid,
} from "@/client/components/SkeletonPresets";
import { TablePagination } from "@/client/components/table/TablePagination";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import {
  BudgetStatusBadge,
  USAGE_STATUS_LABELS,
  featureLabel,
  formatLimit,
  formatUsd,
  formatUtcDay,
} from "./apiSpendingFormat";
import {
  projectApiSpendingQueryOptions,
  projectApiUsageQueryOptions,
  type ApiUsageRow,
  type ProjectApiSpending as Summary,
} from "./apiSpendingQueries";
import { BudgetLimitsForm } from "./BudgetLimitsForm";

/** The project settings "API spending" tab (self-hosted only). */
export function ProjectApiSpending({ projectId }: { projectId: string }) {
  const summaryQuery = useQuery(projectApiSpendingQueryOptions(projectId));

  return (
    <QueryState
      query={summaryQuery}
      errorFallback="We couldn't load this project's API spending."
      loading={<SkeletonStatGrid count={5} className="lg:grid-cols-5" />}
    >
      {(summary) => (
        <div className="space-y-10">
          <AllowanceSection summary={summary} />
          {/* key resets the form's baseline when switching projects */}
          <BudgetLimitsForm
            key={projectId}
            projectId={projectId}
            summary={summary}
          />
          <FeatureBreakdown rows={summary.featureBreakdown} />
          <RecentUsage projectId={projectId} />
        </div>
      )}
    </QueryState>
  );
}

function statusNote(summary: Summary) {
  if (summary.paused) {
    return "Paid DataForSEO usage is paused. Calls already sent still finish, and saved results stay available.";
  }
  if (!summary.configured) {
    return "No limits set yet, so paid usage is unlimited.";
  }
  if (summary.monthlyLimitUsd === null && summary.totalLimitUsd === null) {
    return "Paid usage is unlimited.";
  }
  return "Limits count recorded costs plus calls still in progress.";
}

function availableLabel(summary: Summary) {
  if (summary.paused) return "None while paused";
  if (summary.availableUsd === null) return "Unlimited";
  return formatUsd(summary.availableUsd);
}

function AllowanceSection({ summary }: { summary: Summary }) {
  return (
    <section className="space-y-3">
      <SectionHeader
        title="DataForSEO allowance"
        hint={statusNote(summary)}
        action={<BudgetStatusBadge status={summary.status} />}
      />
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="This month"
          value={formatUsd(summary.monthRecordedUsd)}
          hint={`of ${formatLimit(summary.monthlyLimitUsd, summary.configured)} monthly limit`}
        />
        <Stat
          label="Total"
          value={formatUsd(summary.totalRecordedUsd)}
          hint={`of ${formatLimit(summary.totalLimitUsd, summary.configured)} total limit`}
        />
        <Stat
          label="In progress"
          value={formatUsd(summary.inFlightUsd)}
          hint="Reserved for calls still running"
        />
        <Stat
          label="Estimated"
          value={formatUsd(summary.estimatedUsd)}
          hint="Calls whose cost was never confirmed, counted at their estimate"
        />
        <Stat
          label="Available for new work"
          value={availableLabel(summary)}
          hint="Room left under the tighter limit"
        />
      </dl>
      <p className="text-xs text-muted-foreground">
        {summary.trackingStartedAt
          ? `Tracking since ${formatUtcDay(summary.trackingStartedAt)}.`
          : "No paid usage recorded yet."}{" "}
        This month started {formatUtcDay(summary.monthStart)} 00:00 UTC. Month
        resets {formatUtcDay(summary.nextMonthStart)} 00:00 UTC.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint: string;
}) {
  return (
    <div className="space-y-1 rounded-lg border border-border bg-card p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
    </div>
  );
}

function FeatureBreakdown({ rows }: { rows: Summary["featureBreakdown"] }) {
  return (
    <section className="space-y-3">
      <SectionHeader
        title="By feature"
        hint="All usage since tracking started"
      />
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          title="No paid usage yet"
          description="Costs appear here once this project makes a paid DataForSEO call."
        />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                <TableHead className="text-right">Recorded</TableHead>
                <TableHead className="text-right">Estimated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.feature ?? "unattributed"}>
                  <TableCell>{featureLabel(row.feature)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(row.recordedUsd)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(row.estimatedUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}
    </section>
  );
}

function usageCost(row: ApiUsageRow) {
  if (row.status === "completed") return formatUsd(row.costUsd ?? 0);
  if (row.status === "released") return "—";
  return `~${formatUsd(row.estimatedCostUsd)} estimate`;
}

function RecentUsage({ projectId }: { projectId: string }) {
  const [page, setPage] = useState(1);
  const usageQuery = useQuery(projectApiUsageQueryOptions(projectId, page));

  return (
    <section className="space-y-3">
      <SectionHeader title="Recent usage" hint="Newest first" />
      <QueryState
        query={usageQuery}
        errorFallback="We couldn't load recent usage."
        loading={<SkeletonCard />}
      >
        {(usage) =>
          usage.rows.length === 0 && page === 1 ? (
            <EmptyState
              size="sm"
              title="No paid calls yet"
              description="Each paid DataForSEO call this project makes is listed here."
            />
          ) : (
            <TableCard>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Operation</TableHead>
                    <TableHead>Feature</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {new Date(row.startedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.operation}
                      </TableCell>
                      <TableCell>{featureLabel(row.feature)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {usageCost(row)}
                      </TableCell>
                      <TableCell>{USAGE_STATUS_LABELS[row.status]}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <TablePagination
                page={page}
                pageSize={usage.pageSize}
                // Exact once the last page is reached; unknown before.
                totalCount={
                  usage.hasNextPage
                    ? null
                    : (page - 1) * usage.pageSize + usage.rows.length
                }
                hasNextPage={usage.hasNextPage}
                isLoading={usageQuery.isPlaceholderData}
                onPageChange={setPage}
              />
            </TableCard>
          )
        }
      </QueryState>
    </section>
  );
}
