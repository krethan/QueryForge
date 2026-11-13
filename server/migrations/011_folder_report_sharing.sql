-- Uncle Bob metadata schema, version 11: sharing the reports in a shared folder.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
-- Additive only: one new table, nothing existing is altered and no existing row is touched.
-- A folder with no row here behaves exactly as in 009: sharing it does not share its reports.
--
-- A row is the folder owner's opt-in. While it exists, everyone the folder is shared with
-- (QF_FOLDER_SHARES) can also open the reports in the folder that the folder owner owns and
-- placed there themselves, with the folder share's role capped at MAX_ROLE. Nothing is copied
-- into QF_REPORT_SHARES: the access is worked out on every request, so taking a report out of
-- the folder, changing or revoking the folder share, turning the option off or deleting the
-- folder removes exactly the access that came through the folder and never touches a report
-- share someone was given directly.
CREATE TABLE {{SCHEMA}}.QF_FOLDER_REPORT_SHARING (
  FOLDER_ID   VARCHAR(36) NOT NULL,
  MAX_ROLE    VARCHAR(8)  NOT NULL,
  UPDATED_BY  VARCHAR(36) NOT NULL,
  UPDATED_AT  TIMESTAMP   NOT NULL,
  CONSTRAINT QF_FRSH_PK PRIMARY KEY (FOLDER_ID),
  CONSTRAINT QF_FRSH_FK_FOLDER FOREIGN KEY (FOLDER_ID) REFERENCES {{SCHEMA}}.QF_FOLDERS (FOLDER_ID) ON DELETE CASCADE,
  CONSTRAINT QF_FRSH_CK_ROLE CHECK (MAX_ROLE IN ('VIEWER', 'EDITOR'))
);

LABEL ON TABLE {{SCHEMA}}.QF_FOLDER_REPORT_SHARING IS 'Uncle Bob folders that also share their reports';
