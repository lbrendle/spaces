ALTER TABLE `projects` ADD `repo` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `channels` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `channels` ADD `updated_at` text DEFAULT '' NOT NULL;
--> statement-breakpoint
DROP INDEX `channels_workspace_name_idx`;
--> statement-breakpoint
CREATE INDEX `channels_workspace_project_idx`
  ON `channels` (`workspace_id`,`project_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_workspace_project_name_idx`
  ON `channels` (`workspace_id`,`project_id`,`name`)
  WHERE `project_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_workspace_global_name_idx`
  ON `channels` (`workspace_id`,`name`)
  WHERE `project_id` IS NULL;
--> statement-breakpoint
CREATE TABLE `channel_sources` (
  `workspace_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `device_id` text NOT NULL,
  `source_channel_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY(`device_id`, `source_channel_id`)
);
--> statement-breakpoint
CREATE INDEX `channel_sources_channel_idx`
  ON `channel_sources` (`workspace_id`,`channel_id`);
--> statement-breakpoint
ALTER TABLE `messages` ADD `author_name` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `messages` ADD `status` text DEFAULT 'done' NOT NULL;
--> statement-breakpoint
ALTER TABLE `messages` ADD `meta` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `messages` ADD `run_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `messages` ADD `updated_at` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `message_sources` (
  `workspace_id` text NOT NULL,
  `message_id` text NOT NULL,
  `device_id` text NOT NULL,
  `source_message_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY(`device_id`, `source_message_id`)
);
--> statement-breakpoint
CREATE INDEX `message_sources_message_idx`
  ON `message_sources` (`workspace_id`,`message_id`);
--> statement-breakpoint
CREATE TABLE `issue_sources` (
  `workspace_id` text NOT NULL,
  `issue_id` text NOT NULL,
  `device_id` text NOT NULL,
  `source_task_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY(`device_id`, `source_task_id`)
);
--> statement-breakpoint
CREATE INDEX `issue_sources_issue_idx`
  ON `issue_sources` (`workspace_id`,`issue_id`);
