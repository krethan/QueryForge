-- QueryForge metadata schema, version 6: per-user report folders and favorites.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
-- Folders and favorites are personal: they belong to the user who sees the dashboard,
-- never to the report, so a shared report can sit in a different folder (or be starred)
-- for each person it is shared with. Every statement the server issues against these
-- tables is scoped by the signed-in user's ID.

CREATE TABLE {{SCHEMA}}.QF_FOLDERS (
  FOLDER_ID        VARCHAR(36)  NOT NULL,
  OWNER_ID         VARCHAR(36)  NOT NULL,
  FOLDER_NAME      VARCHAR(128) NOT NULL,
  FOLDER_NAME_KEY  VARCHAR(128) NOT NULL,
  CREATED_AT       TIMESTAMP    NOT NULL,
  UPDATED_AT       TIMESTAMP    NOT NULL,
  CONSTRAINT QF_FLDR_PK PRIMARY KEY (FOLDER_ID),
  CONSTRAINT QF_FLDR_UQ_NAME UNIQUE (OWNER_ID, FOLDER_NAME_KEY),
  CONSTRAINT QF_FLDR_FK_OWNER FOREIGN KEY (OWNER_ID) REFERENCES {{SCHEMA}}.QF_USERS (USER_ID) ON DELETE CASCADE
);

-- One row per (user, report) once the user files or stars the report. FOLDER_ID NULL
-- means "Unfiled". Deleting a folder sets FOLDER_ID to NULL (the server also does this
-- explicitly in the same transaction); it never deletes a report.
CREATE TABLE {{SCHEMA}}.QF_REPORT_PREFS (
  USER_ID      VARCHAR(36) NOT NULL,
  REPORT_ID    VARCHAR(36) NOT NULL,
  FOLDER_ID    VARCHAR(36),
  IS_FAVORITE  SMALLINT    NOT NULL DEFAULT 0,
  UPDATED_AT   TIMESTAMP   NOT NULL,
  CONSTRAINT QF_RPRF_PK PRIMARY KEY (USER_ID, REPORT_ID),
  CONSTRAINT QF_RPRF_FK_USER FOREIGN KEY (USER_ID) REFERENCES {{SCHEMA}}.QF_USERS (USER_ID) ON DELETE CASCADE,
  CONSTRAINT QF_RPRF_FK_REPORT FOREIGN KEY (REPORT_ID) REFERENCES {{SCHEMA}}.QF_REPORTS (REPORT_ID) ON DELETE CASCADE,
  CONSTRAINT QF_RPRF_FK_FOLDER FOREIGN KEY (FOLDER_ID) REFERENCES {{SCHEMA}}.QF_FOLDERS (FOLDER_ID) ON DELETE SET NULL,
  CONSTRAINT QF_RPRF_CK_FAV CHECK (IS_FAVORITE IN (0, 1))
);

CREATE INDEX {{SCHEMA}}.QF_RPRF_IX_FOLDER ON {{SCHEMA}}.QF_REPORT_PREFS (FOLDER_ID);

LABEL ON TABLE {{SCHEMA}}.QF_FOLDERS IS 'QueryForge per-user report folders';

LABEL ON TABLE {{SCHEMA}}.QF_REPORT_PREFS IS 'QueryForge per-user report folder and favorite';
