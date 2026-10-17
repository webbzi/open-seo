import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

// Selected Umami website per project. The Umami instance URL and API key are
// deployment config (UMAMI_API_URL, UMAMI_API_KEY), never stored here.
export const umamiConnections = sqliteTable(
  "umami_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    websiteId: text("website_id").notNull(),
    // Copied from Umami's website list when the website is selected.
    websiteName: text("website_name").notNull(),
    websiteDomain: text("website_domain"),
    // IANA zone captured from the browser at selection; Umami websites have none.
    timeZone: text("time_zone").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("umami_connections_project_idx").on(table.projectId),
    index("umami_connections_organization_idx").on(table.organizationId),
  ],
);
