CREATE TABLE `content_items` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `project_id` text,
  `campaign` text DEFAULT '' NOT NULL,
  `title` text NOT NULL,
  `brief` text DEFAULT '' NOT NULL,
  `copy` text DEFAULT '' NOT NULL,
  `platform` text DEFAULT 'multi' NOT NULL,
  `connection_id` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'idea' NOT NULL,
  `scheduled_at` integer DEFAULT 0 NOT NULL,
  `published_url` text DEFAULT '' NOT NULL,
  `media_url` text DEFAULT '' NOT NULL,
  `publish_error` text DEFAULT '' NOT NULL,
  `agent_id` text DEFAULT '' NOT NULL,
  `created_by` text NOT NULL,
  `source_device_id` text DEFAULT '' NOT NULL,
  `source_content_id` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_items_workspace_status_idx`
  ON `content_items` (`workspace_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `content_items_project_idx`
  ON `content_items` (`workspace_id`,`project_id`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_items_source_idx`
  ON `content_items` (`workspace_id`,`source_device_id`,`source_content_id`)
  WHERE `source_content_id` <> '';
