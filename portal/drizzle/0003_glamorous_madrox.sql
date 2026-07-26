ALTER TABLE `projects` ADD `source_device_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `source_project_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `projects_source_idx` ON `projects` (`workspace_id`,`source_device_id`,`source_project_id`);