-- Uncle Bob metadata schema, version 8: per-user dashboard tile order.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
-- Additive only: one new table, nothing existing is altered. Like folders and favorites
-- (006), the order belongs to the user who sees the dashboard, never to the report. A user
-- with no rows here simply gets the default (name) order. Rows only ever describe reports
-- the user could see when they were saved; the server ignores rows for reports the user can
-- no longer see and prunes them on the next save. Every statement is scoped by USER_ID.

CREATE TABLE {{SCHEMA}}.QF_TILE_ORDER (
  USER_ID      VARCHAR(36) NOT NULL,
  REPORT_ID    VARCHAR(36) NOT NULL,
  TILE_POS     INTEGER     NOT NULL,
  UPDATED_AT   TIMESTAMP   NOT NULL,
  CONSTRAINT QF_TORD_PK PRIMARY KEY (USER_ID, REPORT_ID),
  CONSTRAINT QF_TORD_FK_USER FOREIGN KEY (USER_ID) REFERENCES {{SCHEMA}}.QF_USERS (USER_ID) ON DELETE CASCADE,
  CONSTRAINT QF_TORD_FK_REPORT FOREIGN KEY (REPORT_ID) REFERENCES {{SCHEMA}}.QF_REPORTS (REPORT_ID) ON DELETE CASCADE,
  CONSTRAINT QF_TORD_CK_POS CHECK (TILE_POS >= 0)
);

LABEL ON TABLE {{SCHEMA}}.QF_TILE_ORDER IS 'Uncle Bob per-user dashboard tile order';
