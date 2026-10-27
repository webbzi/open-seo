CREATE TABLE IF NOT EXISTS `project_dataforseo_budgets` (
	`project_id` text PRIMARY KEY NOT NULL,
	`monthly_limit_usd` real,
	`total_limit_usd` real,
	`paused` integer DEFAULT false NOT NULL,
	`reservation_version` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_by_user_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `project_dataforseo_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`feature` text,
	`operation` text NOT NULL,
	`run_id` text,
	`actor_user_id` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`estimated_cost_usd` real NOT NULL,
	`cost_usd` real,
	`status` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `project_dataforseo_usage_project_started_idx` ON `project_dataforseo_usage` (`project_id`,`started_at`);