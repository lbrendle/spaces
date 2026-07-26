CREATE TABLE `content_tombstones` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_by` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_tombstones_workspace_revision_idx` ON `content_tombstones` (`workspace_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_tombstones_entity_idx` ON `content_tombstones` (`workspace_id`,`entity`,`entity_id`);