-- Uncle Bob metadata schema, version 16: in-app notifications read state.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
--
-- The notifications list (the bell in the header) is worked out from tables that already exist:
-- the share audit trails (003, 009), shares with end dates (014) and scheduled delivery history
-- (010). Nothing is stored per notification. The one thing that has to be kept is, per user,
-- when they last chose "Mark all read": everything newer is unread. No existing column can hold
-- that without changing its meaning (QF_USER_SETTINGS.UPDATED_AT is when a setting changed), so
-- this adds one.
--
-- NOTICES_READ_AT on QF_USER_SETTINGS (015): NULL until the user first marks notifications read
-- (every existing row, so nothing changes for them). The app works without this migration: the
-- list shows everything in its window as unread and "Mark all read" reports that 016 is needed.
--
-- Additive only: one nullable column with no default, so no existing row is rewritten with a new
-- value. On IBM i ALTER TABLE ... ADD COLUMN rebuilds the table and needs an exclusive lock on it
-- while it runs (run this with the app stopped); QF_USER_SETTINGS has at most one row per user.
ALTER TABLE {{SCHEMA}}.QF_USER_SETTINGS ADD COLUMN NOTICES_READ_AT TIMESTAMP;

LABEL ON COLUMN {{SCHEMA}}.QF_USER_SETTINGS.NOTICES_READ_AT TEXT IS 'Notifications read up to (UTC), null: never';
