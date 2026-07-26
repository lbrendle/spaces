CREATE TABLE `project_sources` (
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`device_id` text NOT NULL,
	`source_project_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`device_id`, `source_project_id`)
);
--> statement-breakpoint
CREATE INDEX `project_sources_project_idx` ON `project_sources` (`workspace_id`,`project_id`);