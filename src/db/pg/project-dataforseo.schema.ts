import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { projects } from "./app.schema";

// Timestamps are stored as *text* (same column shape as the SQLite schema); see
// the note in pg/app.schema.ts. `isoNow` matches `new Date().toISOString()` so
// DB-defaulted and app-written values sort together lexicographically.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ============================================================================
// Self-hosted DataForSEO spend per project: optional USD caps and a ledger of
// every paid provider call. Hosted mode bills through Autumn credits instead.
// Amounts are double precision (SQLite real): plain JS numbers end to end.
// ============================================================================

// One row per project that has been configured or has admitted a paid call.
// No row means unlimited and never configured.
export const projectDataforseoBudgets = pgTable("project_dataforseo_budgets", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  // Null = unlimited; zero = no new paid usage. Monthly is the UTC calendar
  // month of each usage row's started_at.
  monthlyLimitUsd: doublePrecision("monthly_limit_usd"),
  totalLimitUsd: doublePrecision("total_limit_usd"),
  paused: boolean("paused").notNull().default(false),
  // Bumped by every admission and settings change: the row lock that
  // serializes them per project.
  reservationVersion: integer("reservation_version").notNull().default(0),
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
  // Null = the row was created by an admission, not configured by anyone.
  updatedByUserId: text("updated_by_user_id"),
});

// One row per paid HTTP call, inserted as `pending` before dispatch. Pending
// counts its estimate; completed counts cost_usd; released counts zero. A
// pending row older than 30 minutes is reported as estimated (unsettled).
export const projectDataforseoUsage = pgTable(
  "project_dataforseo_usage",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    feature: text("feature").$type<CreditFeature>(),
    // Short endpoint label; `opening_balance` marks hand-inserted history.
    operation: text("operation").notNull(),
    runId: text("run_id"),
    actorUserId: text("actor_user_id"),
    startedAt: text("started_at").notNull().default(isoNow),
    estimatedCostUsd: doublePrecision("estimated_cost_usd").notNull(),
    costUsd: doublePrecision("cost_usd"),
    status: text("status", {
      enum: ["pending", "completed", "released"],
    }).notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("project_dataforseo_usage_project_started_idx").on(
      table.projectId,
      table.startedAt,
    ),
  ],
);
