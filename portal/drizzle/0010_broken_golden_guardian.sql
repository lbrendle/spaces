CREATE TABLE `project_connections` (
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `connection_id`)
);
--> statement-breakpoint
CREATE INDEX `project_connections_workspace_project_idx` ON `project_connections` (`workspace_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `project_connections_connection_idx` ON `project_connections` (`connection_id`);--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `project_id` text DEFAULT '' NOT NULL;