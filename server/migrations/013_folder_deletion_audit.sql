-- Uncle Bob metadata schema, version 13: folder deletions in the audit trail.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
--
-- Deleting a folder removes its QF_FOLDERS row, and with it (ON DELETE CASCADE, 009 / 011) its
-- shares, the reports others placed in it and its "share the reports" option. Until now nothing
-- recorded that it happened. One row per deletion is now written here, in the same transaction
-- as the delete: who deleted it, when, the folder's ID, name and owner, and what it had.
--
-- Deliberately no foreign keys: a row must outlive the folder (already gone when it is written)
-- and the users it names. QF_FOLDER_SHARE_AUDIT (009) has no foreign key to QF_FOLDERS either,
-- so a deleted folder's sharing history stays; the delete also writes a REVOKE row there for
-- each share and for the report-sharing option it ended.
--
-- Additive only: one new table and its indexes. Nothing existing is altered and no row is touched.
--   SHARE_COUNT   users / groups the folder was shared with (QF_FOLDER_SHARES rows)
--   PLACED_COUNT  reports others or the owner had placed in it (QF_FOLDER_REPORTS rows)
--   FILED_COUNT   the owner's own reports filed in it (QF_REPORT_PREFS), now Unfiled
--   REPORTS_ROLE  its "also share the reports" level (011) when it was deleted, or NULL (off)
CREATE TABLE {{SCHEMA}}.QF_FOLDER_DELETIONS (
  DELETION_ID   VARCHAR(36)  NOT NULL,
  FOLDER_ID     VARCHAR(36)  NOT NULL,
  FOLDER_NAME   VARCHAR(128) NOT NULL,
  OWNER_ID      VARCHAR(36)  NOT NULL,
  ACTOR_ID      VARCHAR(36)  NOT NULL,
  SHARE_COUNT   INTEGER      NOT NULL,
  PLACED_COUNT  INTEGER      NOT NULL,
  FILED_COUNT   INTEGER      NOT NULL,
  REPORTS_ROLE  VARCHAR(8),
  DELETED_AT    TIMESTAMP    NOT NULL,
  CONSTRAINT QF_FDEL_PK PRIMARY KEY (DELETION_ID),
  CONSTRAINT QF_FDEL_CK_COUNTS CHECK (SHARE_COUNT >= 0 AND PLACED_COUNT >= 0 AND FILED_COUNT >= 0),
  CONSTRAINT QF_FDEL_CK_ROLE CHECK (REPORTS_ROLE IS NULL OR REPORTS_ROLE IN ('VIEWER', 'EDITOR'))
);

CREATE INDEX {{SCHEMA}}.QF_FDEL_IX_TIME ON {{SCHEMA}}.QF_FOLDER_DELETIONS (DELETED_AT DESC, DELETION_ID);

CREATE INDEX {{SCHEMA}}.QF_FDEL_IX_FOLDER ON {{SCHEMA}}.QF_FOLDER_DELETIONS (FOLDER_ID);

LABEL ON TABLE {{SCHEMA}}.QF_FOLDER_DELETIONS IS 'Uncle Bob folder deletion audit trail';
