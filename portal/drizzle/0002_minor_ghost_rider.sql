CREATE TABLE `agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`requested_by_device_id` text NOT NULL,
	`host_device_id` text NOT NULL,
	`project_id` text,
	`channel_id` text DEFAULT '' NOT NULL,
	`requester_run_id` text NOT NULL,
	`input_json` text NOT NULL,
	`status` text NOT NULL,
	`lease_token_hash` text,
	`lease_expires_at` text,
	`result_json` text,
	`error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`claimed_at` text,
	`started_at` text,
	`finished_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_jobs_host_status_idx` ON `agent_jobs` (`host_device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_jobs_requester_status_idx` ON `agent_jobs` (`requested_by_device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_jobs_requester_run_idx` ON `agent_jobs` (`workspace_id`,`requested_by_device_id`,`requester_run_id`);--> statement-breakpoint
ALTER TABLE `agent_profiles` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `agent_profiles` ADD `host_device_id` text;--> statement-breakpoint
ALTER TABLE `agent_profiles` ADD `visibility` text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_profiles` ADD `persona` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_profiles` ADD `cli_args_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_profiles` ADD `source_agent_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `owner_user_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `platform` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `tools_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `devices`
   SET `owner_user_id` = (
     SELECT `created_by`
       FROM `workspaces`
      WHERE `workspaces`.`id` = `devices`.`workspace_id`
   )
 WHERE `owner_user_id` = '';--> statement-breakpoint
UPDATE `agent_profiles`
   SET `owner_user_id` = `created_by`
 WHERE `owner_user_id` IS NULL;
