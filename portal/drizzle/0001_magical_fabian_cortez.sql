CREATE TABLE `connection_secrets` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`encrypted_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`code_verifier` text DEFAULT '' NOT NULL,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_states_expiry_idx` ON `oauth_states` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oauth_states_workspace_idx` ON `oauth_states` (`workspace_id`,`provider`);