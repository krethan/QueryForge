-- QueryForge metadata schema, version 3: audit trail of report sharing changes.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
-- One row per grant, role change or revoke, written in the same commitment-control
-- transaction as the change to QF_REPORT_SHARES. There is deliberately no foreign key
-- to QF_REPORTS so the trail survives deletion of the report.

CREATE TABLE {{SCHEMA}}.QF_SHARE_AUDIT (
  AUDIT_ID        VARCHAR(36)  NOT NULL,
  REPORT_ID       VARCHAR(36)  NOT NULL,
  ACTION          VARCHAR(8)   NOT NULL,
  PRINCIPAL_TYPE  VARCHAR(8)   NOT NULL,
  PRINCIPAL_ID    VARCHAR(128) NOT NULL,
  OLD_ROLE        VARCHAR(8),
  NEW_ROLE        VARCHAR(8),
  ACTOR_ID        VARCHAR(36)  NOT NULL,
  OCCURRED_AT     TIMESTAMP    NOT NULL,
  CONSTRAINT QF_SAUD_PK PRIMARY KEY (AUDIT_ID),
  CONSTRAINT QF_SAUD_CK_ACTION CHECK (ACTION IN ('GRANT', 'CHANGE', 'REVOKE')),
  CONSTRAINT QF_SAUD_CK_TYPE CHECK (PRINCIPAL_TYPE IN ('USER', 'GROUP')),
  CONSTRAINT QF_SAUD_CK_OLD CHECK (OLD_ROLE IS NULL OR OLD_ROLE IN ('VIEWER', 'EDITOR')),
  CONSTRAINT QF_SAUD_CK_NEW CHECK (NEW_ROLE IS NULL OR NEW_ROLE IN ('VIEWER', 'EDITOR'))
);

CREATE INDEX {{SCHEMA}}.QF_SAUD_IX_REPORT ON {{SCHEMA}}.QF_SHARE_AUDIT (REPORT_ID, OCCURRED_AT DESC);

LABEL ON TABLE {{SCHEMA}}.QF_SHARE_AUDIT IS 'QueryForge report sharing audit trail';
