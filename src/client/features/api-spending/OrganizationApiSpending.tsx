import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useId, useState } from "react";
import { EmptyState } from "@/client/components/EmptyState";
import { SectionHeader } from "@/client/components/PageHeader";
import { QueryState } from "@/client/components/QueryState";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";
import { Switch } from "@/client/components/ui/switch";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { useCanManageBilling } from "@/client/features/team/organizationQueries";
import type { CsvValue } from "@/client/lib/csv";
import { exportRows } from "@/client/lib/exportRows";
import { exportOrganizationDataforseoUsage } from "@/serverFunctions/projectDataforseoBudgets";
import {
  BudgetStatusBadge,
  USAGE_STATUS_LABELS,
  featureLabel,
  formatLimit,
  formatUsd,
  roundUsd,
} from "./apiSpendingFormat";
import {
  organizationApiSpendingQueryOptions,
  type OrganizationApiSpendingRow,
} from "./apiSpendingQueries";

/** The organization's DataForSEO spending across every project (self-hosted only). */
export function OrganizationApiSpending() {
  const canManage = useCanManageBilling();

  return (
    <div className="space-y-10">
      <ProjectSpendingTable />
      <section className="space-y-3">
        <SectionHeader
          title="Export usage"
          hint="Every paid call in the date range (UTC days), for reviewing project costs against client agreements."
        />
        {canManage ? (
          <UsageExport />
        ) : (
          <p className="text-sm text-muted-foreground">
            Only an organization owner can export usage.
          </p>
        )}
      </section>
    </div>
  );
}

function ProjectSpendingTable() {
  const spendingQuery = useQuery(organizationApiSpendingQueryOptions());
  const [showArchived, setShowArchived] = useState(true);
  const switchId = useId();

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Spending by project"
        hint="This month is the current UTC calendar month. In progress counts calls still running."
        action={
          <div className="flex items-center gap-2">
            <Switch
              id={switchId}
              checked={showArchived}
              onCheckedChange={setShowArchived}
            />
            <Label htmlFor={switchId} className="text-sm font-normal">
              Show archived
            </Label>
          </div>
        }
      />
      <QueryState
        query={spendingQuery}
        errorFallback="We couldn't load API spending."
      >
        {(rows) => {
          const visible = showArchived
            ? rows
            : rows.filter((row) => !row.archived);
          if (visible.length === 0) {
            return (
              <EmptyState
                kind="filtered"
                size="sm"
                title="No active projects"
                description="Turn on Show archived to see archived projects' spending."
              />
            );
          }
          return (
            <TableCard>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead className="text-right">This month</TableHead>
                    <TableHead className="text-right">Monthly limit</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Total limit</TableHead>
                    <TableHead className="text-right">In progress</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => (
                    <ProjectSpendingRow key={row.projectId} row={row} />
                  ))}
                </TableBody>
              </Table>
            </TableCard>
          );
        }}
      </QueryState>
    </section>
  );
}

function ProjectSpendingRow({ row }: { row: OrganizationApiSpendingRow }) {
  return (
    <TableRow>
      <TableCell>
        {row.archived ? (
          // Archived projects cannot be opened until restored from Projects.
          <span className="flex items-center gap-2">
            <span className="font-medium">{row.name}</span>
            <Badge variant="secondary" size="sm">
              Archived
            </Badge>
          </span>
        ) : (
          <Link
            to="/p/$projectId/settings/api-spending"
            params={{ projectId: row.projectId }}
            className="font-medium hover:underline"
          >
            {row.name}
          </Link>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatUsd(row.monthRecordedUsd)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatLimit(row.monthlyLimitUsd, row.configured)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatUsd(row.totalRecordedUsd)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatLimit(row.totalLimitUsd, row.configured)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatUsd(row.inFlightUsd)}
        {roundUsd(row.estimatedUsd) > 0 ? (
          <span className="block text-xs text-muted-foreground">
            + {formatUsd(row.estimatedUsd)} estimated
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <BudgetStatusBadge status={row.status} />
      </TableCell>
    </TableRow>
  );
}

type ExportRow = Awaited<
  ReturnType<typeof exportOrganizationDataforseoUsage>
>[number];

const EXPORT_HEADERS = [
  "Started at (UTC)",
  "Completed at (UTC)",
  "Project",
  "Project ID",
  "Feature",
  "Operation",
  "Status",
  "Recorded cost (USD)",
  "Estimated cost (USD)",
  "Run ID",
  "Actor user ID",
  "Usage ID",
];

/**
 * Full precision, as text: the CSV builder rounds numbers to cents, which
 * would turn a $0.0006 call into $0.00.
 */
const exportAmount = (value: number) =>
  roundUsd(value)
    .toFixed(8)
    .replace(/\.?0+$/, "");

/**
 * Recorded and estimated amounts get their own columns, so a sum of either is
 * meaningful. Released calls cost nothing and leave both empty. Opening
 * balances are recorded rows with operation "opening_balance".
 */
function toExportRow(row: ExportRow): CsvValue[] {
  const unsettled = row.status === "pending" || row.status === "estimated";
  return [
    row.startedAt,
    row.completedAt,
    row.projectName,
    row.projectId,
    featureLabel(row.feature),
    row.operation,
    USAGE_STATUS_LABELS[row.status],
    row.status === "completed" ? exportAmount(row.costUsd ?? 0) : null,
    unsettled ? exportAmount(row.estimatedCostUsd) : null,
    row.runId,
    row.actorUserId,
    row.id,
  ];
}

/** YYYY-MM-DD of the current UTC day. */
const utcToday = () => new Date().toISOString().slice(0, 10);

function UsageExport() {
  const [from, setFrom] = useState(() => `${utcToday().slice(0, 8)}01`);
  const [to, setTo] = useState(utcToday);
  const fromId = useId();
  const toId = useId();
  const rangeValid = from !== "" && to !== "" && from <= to;

  const exportMutation = useMutation({
    mutationFn: (range: { from: string; to: string }) =>
      exportOrganizationDataforseoUsage({ data: range }),
    onSuccess: (rows, range) =>
      exportRows({
        format: "csv",
        feature: "api_spending",
        headers: EXPORT_HEADERS,
        rows: rows.map(toExportRow),
        filename: `dataforseo-usage-${range.from}-to-${range.to}`,
      }),
  });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fromId}>From</Label>
        <Input
          id={fromId}
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => setFrom(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={toId}>To</Label>
        <Input
          id={toId}
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      <Button
        variant="outline"
        disabled={!rangeValid}
        pending={exportMutation.isPending}
        onClick={() => exportMutation.mutate({ from, to })}
      >
        <Download data-icon="inline-start" />
        Export CSV
      </Button>
      {!rangeValid ? (
        <p className="basis-full text-sm text-destructive">
          Pick a start date on or before the end date.
        </p>
      ) : null}
    </div>
  );
}
