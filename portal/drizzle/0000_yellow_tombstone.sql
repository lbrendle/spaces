CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_workspace_idx` ON `activity` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`owns` text NOT NULL,
	`backend` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`effort` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_profiles_workspace_idx` ON `agent_profiles` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`topic` text NOT NULL,
	`mode` text DEFAULT 'lead' NOT NULL,
	`lead_agent_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_workspace_name_idx` ON `channels` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`account_label` text DEFAULT '' NOT NULL,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`last_sync_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connections_workspace_idx` ON `connections` (`workspace_id`,`kind`);--> statement-breakpoint
CREATE TABLE `cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cycles_workspace_idx` ON `cycles` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decisions_workspace_idx` ON `decisions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`claimed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_hash_idx` ON `device_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `device_snapshots` (
	`device_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `device_snapshots_workspace_idx` ON `device_snapshots` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_idx` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `devices_workspace_idx` ON `devices` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`sender_name` text NOT NULL,
	`sender_address` text NOT NULL,
	`status` text NOT NULL,
	`assignee_id` text,
	`labels_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbox_workspace_status_idx` ON `inbox_items` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_idx` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_workspace_idx` ON `invites` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`cycle_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`assignee_id` text,
	`created_by` text NOT NULL,
	`due_date` text,
	`source` text DEFAULT 'portal' NOT NULL,
	`source_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issues_workspace_status_idx` ON `issues` (`workspace_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `issues_source_idx` ON `issues` (`workspace_id`,`source`,`source_id`);--> statement-breakpoint
CREATE TABLE `knowledge_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`body` text NOT NULL,
	`kind` text NOT NULL,
	`tags_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_pages_workspace_slug_idx` ON `knowledge_pages` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE INDEX `knowledge_pages_updated_idx` ON `knowledge_pages` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`author_type` text DEFAULT 'user' NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`parent_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_channel_idx` ON `messages` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `page_links` (
	`workspace_id` text NOT NULL,
	`from_page_id` text NOT NULL,
	`to_page_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `from_page_id`, `to_page_id`)
);
--> statement-breakpoint
CREATE INDEX `page_links_to_idx` ON `page_links` (`workspace_id`,`to_page_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`lead_id` text,
	`target_date` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_workspace_idx` ON `projects` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `team_actors` (
	`team_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	PRIMARY KEY(`team_id`, `actor_type`, `actor_id`)
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`purpose` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_workspace_name_idx` ON `teams` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_idx` ON `workspaces` (`slug`);