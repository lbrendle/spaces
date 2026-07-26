CREATE TABLE `calendar_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`device_id` text NOT NULL,
	`event_id` text NOT NULL,
	`calendar_name` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_commands_event_idx` ON `calendar_commands` (`event_id`);--> statement-breakpoint
CREATE INDEX `calendar_commands_device_status_idx` ON `calendar_commands` (`device_id`,`status`,`created_at`);