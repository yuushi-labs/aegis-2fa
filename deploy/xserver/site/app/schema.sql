-- スキーマは drizzle/0000_certain_ben_parker.sql（Node 版）と同一。
-- 既存の Node 版 DB をそのまま使えるように、型・既定値・インデックス名を揃えている。
CREATE TABLE IF NOT EXISTS `vaults` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`envelope` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS `vaults_updated_at_idx` ON `vaults` (`updated_at`);
