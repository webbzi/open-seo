import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { projects } from "./app.schema";

// ============================================================================
// Self-hosted DataForSEO spend per project: optional USD caps and a ledger of
// every paid provider call. Hosted mode bills through Autumn credits instead.
// Timestamps default to ISO (unlike current_timestamp's space format) because
// month boundaries compare them lexicographically against app-written stamps.
// ============================================================================

// One row per project that has been configured or has admitted a paid call.
// No row means unlimited and never configured.
export const projectDataforseoBudgets = sqliteTable(
  "project_dataforseo_budgets",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Null = unlimited; zero = no new paid usage. Monthly is the UTC calendar
    // month of each usage row's started_at.
    monthlyLimitUsd: real("monthly_limit_usd"),
    totalLimitUsd: real("total_limit_usd"),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    // Bumped by every admission and settings change: the row lock that
    // serializes them per project on Postgres.
    reservationVersion: integer("reservation_version").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    // Null = the row was created by an admission, not configured by anyone.
    updatedByUserId: text("updated_by_user_id"),
  },
);

// One row per paid HTTP call, inserted as `pending` before dispatch. Pending
// counts its estimate; completed counts cost_usd; released counts zero. A
// pending row older than 30 minutes is reported as estimated (unsettled).
export const projectDataforseoUsage = sqliteTable(
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
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    estimatedCostUsd: real("estimated_cost_usd").notNull(),
    costUsd: real("cost_usd"),
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
