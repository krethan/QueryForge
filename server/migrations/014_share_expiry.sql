-- Uncle Bob metadata schema, version 14: optional expiry dates on report and folder shares.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
--
-- EXPIRES_AT on QF_REPORT_SHARES (002) and QF_FOLDER_SHARES (009): the first instant at which the
-- share no longer gives access, or NULL for a share that never expires (every existing row, so
-- nothing changes for shares made before this migration). The server compares it with the
-- current time on every request (access granted only while EXPIRES_AT IS NULL OR EXPIRES_AT > now),
-- so a share stops working the moment it expires without any cleanup job. Expired rows stay
-- until the owner renews or removes them, so the share dialogs can show them as "Expired".
--
-- Both audit trails, QF_SHARE_AUDIT (003) and QF_FOLDER_SHARE_AUDIT (009), get OLD_EXPIRES_AT /
-- NEW_EXPIRES_AT (the expiry before and after the change, NULL meaning none) and a new ACTION
-- 'EXPIRY' for a change of expiry alone (set, changed, renewed or cleared) on a share whose role
-- did not change. GRANT, CHANGE and REVOKE rows carry the expiry columns too. The ACTION check
-- constraints are replaced with wider ones, as 012 did for QF_FSAU_CK_TYPE; every existing row
-- ('GRANT', 'CHANGE' or 'REVOKE') satisfies the new constraint, which Db2 for i verifies when it
-- is added.
--
-- Additive only: nullable columns with no default, so no existing row is rewritten with a new
-- value. On IBM i each ALTER TABLE ... ADD COLUMN rebuilds the table and needs an exclusive lock
-- on it while it runs (run this with the app stopped). No index is added: access checks read the
-- shares of one report or folder, or of one person, through the existing indexes (002, 007, 009)
-- and test EXPIRES_AT on those few rows.
ALTER TABLE {{SCHEMA}}.QF_REPORT_SHARES ADD COLUMN EXPIRES_AT TIMESTAMP;

ALTER TABLE {{SCHEMA}}.QF_FOLDER_SHARES ADD COLUMN EXPIRES_AT TIMESTAMP;

ALTER TABLE {{SCHEMA}}.QF_SHARE_AUDIT ADD COLUMN OLD_EXPIRES_AT TIMESTAMP;

ALTER TABLE {{SCHEMA}}.QF_SHARE_AUDIT ADD COLUMN NEW_EXPIRES_AT TIMESTAMP;

ALTER TABLE {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT ADD COLUMN OLD_EXPIRES_AT TIMESTAMP;

ALTER TABLE {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT ADD COLUMN NEW_EXPIRES_AT TIMESTAMP;

ALTER TABLE {{SCHEMA}}.QF_SHARE_AUDIT DROP CONSTRAINT QF_SAUD_CK_ACTION;

ALTER TABLE {{SCHEMA}}.QF_SHARE_AUDIT ADD CONSTRAINT QF_SAUD_CK_ACTION CHECK (ACTION IN ('GRANT', 'CHANGE', 'REVOKE', 'EXPIRY'));

ALTER TABLE {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT DROP CONSTRAINT QF_FSAU_CK_ACTION;

ALTER TABLE {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT ADD CONSTRAINT QF_FSAU_CK_ACTION CHECK (ACTION IN ('GRANT', 'CHANGE', 'REVOKE', 'EXPIRY'));

LABEL ON COLUMN {{SCHEMA}}.QF_REPORT_SHARES.EXPIRES_AT TEXT IS 'Share expires at (UTC), null: never';

LABEL ON COLUMN {{SCHEMA}}.QF_FOLDER_SHARES.EXPIRES_AT TEXT IS 'Share expires at (UTC), null: never';

LABEL ON COLUMN {{SCHEMA}}.QF_SHARE_AUDIT.OLD_EXPIRES_AT TEXT IS 'Expiry before the change (UTC)';

LABEL ON COLUMN {{SCHEMA}}.QF_SHARE_AUDIT.NEW_EXPIRES_AT TEXT IS 'Expiry after the change (UTC)';

LABEL ON COLUMN {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT.OLD_EXPIRES_AT TEXT IS 'Expiry before the change (UTC)';

LABEL ON COLUMN {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT.NEW_EXPIRES_AT TEXT IS 'Expiry after the change (UTC)';
