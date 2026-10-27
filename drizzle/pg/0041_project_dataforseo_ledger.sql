CREATE TABLE "project_dataforseo_budgets" (
	"project_id" text PRIMARY KEY NOT NULL,
	"monthly_limit_usd" double precision,
	"total_limit_usd" double precision,
	"paused" boolean DEFAULT false NOT NULL,
	"reservation_version" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "project_dataforseo_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"feature" text,
	"operation" text NOT NULL,
	"run_id" text,
	"actor_user_id" text,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"estimated_cost_usd" double precision NOT NULL,
	"cost_usd" double precision,
	"status" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
ALTER TABLE "project_dataforseo_budgets" ADD CONSTRAINT "project_dataforseo_budgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dataforseo_usage" ADD CONSTRAINT "project_dataforseo_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_dataforseo_usage_project_started_idx" ON "project_dataforseo_usage" USING btree ("project_id","started_at");