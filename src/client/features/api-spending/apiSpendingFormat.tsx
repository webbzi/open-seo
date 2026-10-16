import { Badge } from "@/client/components/ui/badge";
import { creditFeatureLabel } from "@/shared/billing-credit-features";
import type { ApiUsageRow, ProjectApiSpending } from "./apiSpendingQueries";

/**
 * Drops the float noise summed costs carry (2.47999999999999 is 2.48, a
 * leftover ±1e-16 is 0). Provider costs never need more than eight decimals.
 */
export function roundUsd(value: number) {
  // `|| 0` turns -0 into 0, which Intl would print as "-$0.00".
  return Math.round(value * 1e8) / 1e8 || 0;
}

const centsFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const subCentFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 2,
});

/** USD with cents; a nonzero amount that would round to $0.00 keeps its digits ($0.0006). */
export function formatUsd(value: number) {
  const amount = roundUsd(value);
  return amount !== 0 && Math.abs(amount) < 0.005
    ? subCentFormat.format(amount)
    : centsFormat.format(amount);
}

/** A never-configured project is unlimited by default; "Unlimited" is an owner's explicit choice. */
export function formatLimit(limit: number | null, configured: boolean) {
  if (limit !== null) return formatUsd(limit);
  return configured ? "Unlimited" : "Not set";
}

export function featureLabel(feature: string | null) {
  return feature === null ? "Unattributed" : creditFeatureLabel(feature);
}

type BudgetStatus = ProjectApiSpending["status"];

const BUDGET_STATUS: Record<
  BudgetStatus,
  { label: string; variant: "success" | "warning" | "destructive" }
> = {
  available: { label: "Available", variant: "success" },
  monthly_limit_reached: {
    label: "Monthly limit reached",
    variant: "destructive",
  },
  total_limit_reached: { label: "Total limit reached", variant: "destructive" },
  paused: { label: "Paused", variant: "warning" },
};

export function BudgetStatusBadge({ status }: { status: BudgetStatus }) {
  const { label, variant } = BUDGET_STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

export const USAGE_STATUS_LABELS: Record<ApiUsageRow["status"], string> = {
  pending: "In progress",
  // Still pending past the cut-off: the outcome was never confirmed.
  estimated: "Estimated",
  completed: "Recorded",
  released: "Not charged",
};

const utcDayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "1 Nov 2026", the UTC calendar day. */
export function formatUtcDay(date: Date) {
  return utcDayFormat.format(date);
}
