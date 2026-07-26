CREATE TABLE `workspace_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspace_events_workspace_sequence_idx` ON `workspace_events` (`workspace_id`,`sequence`);