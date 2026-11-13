-- Uncle Bob metadata schema, version 9: shared folders.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
-- Additive only: three new tables and their indexes; nothing existing is altered and no
-- existing row is touched. A folder with no rows in QF_FOLDER_SHARES stays exactly the
-- personal folder 006 created: only its owner can see it.
--
-- Sharing a folder never shares the reports in it. Report access still comes only from
-- QF_REPORTS.OWNER_ID and QF_REPORT_SHARES; the server shows each person only the reports in
-- a folder that they can already see.

-- Who a folder is shared with, mirroring QF_REPORT_SHARES (002): a user or an app group,
-- as VIEWER (see the folder) or EDITOR (also add, remove and reorder its reports).
CREATE TABLE {{SCHEMA}}.QF_FOLDER_SHARES (
  FOLDER_ID       VARCHAR(36)  NOT NULL,
  PRINCIPAL_TYPE  VARCHAR(8)   NOT NULL,
  PRINCIPAL_ID    VARCHAR(128) NOT NULL,
  SHARE_ROLE      VARCHAR(8)   NOT NULL,
  CREATED_BY      VARCHAR(36)  NOT NULL,
  CREATED_AT      TIMESTAMP    NOT NULL,
  CONSTRAINT QF_FSHR_PK PRIMARY KEY (FOLDER_ID, PRINCIPAL_TYPE, PRINCIPAL_ID),
  CONSTRAINT QF_FSHR_FK_FOLDER FOREIGN KEY (FOLDER_ID) REFERENCES {{SCHEMA}}.QF_FOLDERS (FOLDER_ID) ON DELETE CASCADE,
  CONSTRAINT QF_FSHR_CK_TYPE CHECK (PRINCIPAL_TYPE IN ('USER', 'GROUP')),
  CONSTRAINT QF_FSHR_CK_ROLE CHECK (SHARE_ROLE IN ('VIEWER', 'EDITOR'))
);

CREATE INDEX {{SCHEMA}}.QF_FSHR_IX_COVERS ON {{SCHEMA}}.QF_FOLDER_SHARES
  (PRINCIPAL_ID, PRINCIPAL_TYPE, SHARE_ROLE, FOLDER_ID);

-- Reports placed in a folder by anyone who may edit it (owner, editor or admin). The owner's
-- own filing in QF_REPORT_PREFS (006) still counts as being in the folder; this table adds
-- the reports others put there and the shared order. ITEM_POS NULL means "no saved position"
-- (sorted after positioned reports, by name). Deleting the folder or the report removes the
-- row; it never deletes a report. ADDED_BY has no foreign key so a removed user's additions stay.
CREATE TABLE {{SCHEMA}}.QF_FOLDER_REPORTS (
  FOLDER_ID   VARCHAR(36) NOT NULL,
  REPORT_ID   VARCHAR(36) NOT NULL,
  ITEM_POS    INTEGER,
  ADDED_BY    VARCHAR(36) NOT NULL,
  ADDED_AT    TIMESTAMP   NOT NULL,
  CONSTRAINT QF_FRPT_PK PRIMARY KEY (FOLDER_ID, REPORT_ID),
  CONSTRAINT QF_FRPT_FK_FOLDER FOREIGN KEY (FOLDER_ID) REFERENCES {{SCHEMA}}.QF_FOLDERS (FOLDER_ID) ON DELETE CASCADE,
  CONSTRAINT QF_FRPT_FK_REPORT FOREIGN KEY (REPORT_ID) REFERENCES {{SCHEMA}}.QF_REPORTS (REPORT_ID) ON DELETE CASCADE,
  CONSTRAINT QF_FRPT_CK_POS CHECK (ITEM_POS IS NULL OR ITEM_POS >= 0)
);

CREATE INDEX {{SCHEMA}}.QF_FRPT_IX_REPORT ON {{SCHEMA}}.QF_FOLDER_REPORTS (REPORT_ID);

-- Grant / change / revoke trail for folder sharing, like QF_SHARE_AUDIT (003). Written in the
-- same transaction as the change to QF_FOLDER_SHARES. No foreign key to QF_FOLDERS so the
-- trail survives deletion of the folder.
CREATE TABLE {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT (
  AUDIT_ID        VARCHAR(36)  NOT NULL,
  FOLDER_ID       VARCHAR(36)  NOT NULL,
  ACTION          VARCHAR(8)   NOT NULL,
  PRINCIPAL_TYPE  VARCHAR(8)   NOT NULL,
  PRINCIPAL_ID    VARCHAR(128) NOT NULL,
  OLD_ROLE        VARCHAR(8),
  NEW_ROLE        VARCHAR(8),
  ACTOR_ID        VARCHAR(36)  NOT NULL,
  OCCURRED_AT     TIMESTAMP    NOT NULL,
  CONSTRAINT QF_FSAU_PK PRIMARY KEY (AUDIT_ID),
  CONSTRAINT QF_FSAU_CK_ACTION CHECK (ACTION IN ('GRANT', 'CHANGE', 'REVOKE')),
  CONSTRAINT QF_FSAU_CK_TYPE CHECK (PRINCIPAL_TYPE IN ('USER', 'GROUP')),
  CONSTRAINT QF_FSAU_CK_OLD CHECK (OLD_ROLE IS NULL OR OLD_ROLE IN ('VIEWER', 'EDITOR')),
  CONSTRAINT QF_FSAU_CK_NEW CHECK (NEW_ROLE IS NULL OR NEW_ROLE IN ('VIEWER', 'EDITOR'))
);

CREATE INDEX {{SCHEMA}}.QF_FSAU_IX_FOLDER ON {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT (FOLDER_ID, OCCURRED_AT DESC);

LABEL ON TABLE {{SCHEMA}}.QF_FOLDER_SHARES IS 'Uncle Bob folder user/group Viewer/Editor grants';

LABEL ON TABLE {{SCHEMA}}.QF_FOLDER_REPORTS IS 'Uncle Bob reports placed in shared folders';

LABEL ON TABLE {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT IS 'Uncle Bob folder sharing audit trail';
