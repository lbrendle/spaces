CREATE TABLE `media_assets` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `project_id` text,
  `object_key` text NOT NULL,
  `file_name` text NOT NULL,
  `content_type` text NOT NULL,
  `byte_size` integer NOT NULL,
  `etag` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `created_by_device_id` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_object_key_idx`
  ON `media_assets` (`object_key`);
--> statement-breakpoint
CREATE INDEX `media_assets_workspace_created_idx`
  ON `media_assets` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `media_assets_project_idx`
  ON `media_assets` (`workspace_id`,`project_id`);
