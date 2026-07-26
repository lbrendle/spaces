CREATE TABLE `knowledge_access` (
	`workspace_id` text NOT NULL,
	`page_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`access` text DEFAULT 'read' NOT NULL,
	PRIMARY KEY(`workspace_id`, `page_id`, `subject_type`, `subject_id`)
);
--> statement-breakpoint
CREATE INDEX `knowledge_access_subject_idx` ON `knowledge_access` (`workspace_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `shared_calendar_access` (
	`workspace_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`access` text DEFAULT 'busy' NOT NULL,
	PRIMARY KEY(`workspace_id`, `calendar_id`, `subject_type`, `subject_id`)
);
--> statement-breakpoint
CREATE INDEX `shared_calendar_access_subject_idx` ON `shared_calendar_access` (`workspace_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `shared_calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`source_device_id` text DEFAULT '' NOT NULL,
	`source_event_id` text DEFAULT '' NOT NULL,
	`external_id` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`all_day` integer DEFAULT 0 NOT NULL,
	`tz` text DEFAULT '' NOT NULL,
	`organizer` text DEFAULT '' NOT NULL,
	`attendees_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`source` text DEFAULT 'hq' NOT NULL,
	`etag` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shared_calendar_events_span_idx` ON `shared_calendar_events` (`workspace_id`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `shared_calendar_events_calendar_idx` ON `shared_calendar_events` (`calendar_id`,`starts_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `shared_calendar_events_source_idx` ON `shared_calendar_events` (`workspace_id`,`source_device_id`,`source_event_id`) WHERE "shared_calendar_events"."source_event_id" <> '';--> statement-breakpoint
CREATE TABLE `shared_calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_device_id` text DEFAULT '' NOT NULL,
	`source_calendar_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT 'hq' NOT NULL,
	`external_id` text DEFAULT '' NOT NULL,
	`owner_type` text DEFAULT 'member' NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`owner_label` text DEFAULT '' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`writable` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shared_calendars_workspace_idx` ON `shared_calendars` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shared_calendars_source_idx` ON `shared_calendars` (`workspace_id`,`source_device_id`,`source_calendar_id`) WHERE "shared_calendars"."source_calendar_id" <> '';--> statement-breakpoint
ALTER TABLE `knowledge_pages` ADD `owner_user_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_pages` ADD `visibility` text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_pages` ADD `source_type` text DEFAULT 'portal' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_pages` ADD `source_device_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_pages` ADD `source_record_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_pages` ADD `source_collection_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_pages` ADD `source_label` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_pages` ADD `path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_pages` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `knowledge_pages`
   SET `owner_user_id` = `created_by`
 WHERE `owner_user_id` = '';--> statement-breakpoint
UPDATE `knowledge_pages`
   SET `source_record_id` = `id`
 WHERE `source_type` = 'portal' AND `source_record_id` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_pages_source_idx` ON `knowledge_pages` (`workspace_id`,`source_device_id`,`source_record_id`) WHERE "knowledge_pages"."source_record_id" <> '';--> statement-breakpoint
ALTER TABLE `teams` ADD `source_device_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `source_team_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_source_idx` ON `teams` (`workspace_id`,`source_device_id`,`source_team_id`) WHERE "teams"."source_team_id" <> '';
