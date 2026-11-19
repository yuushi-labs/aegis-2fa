CREATE TABLE `vaults` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`envelope` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vaults_updated_at_idx` ON `vaults` (`updated_at`);