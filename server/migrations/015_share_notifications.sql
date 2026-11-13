-- Uncle Bob metadata schema, version 15: share notification e-mails and expiry reminders.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
--
-- QF_SHARE_REMINDERS: one row per reminder that a report or folder share (QF_REPORT_SHARES /
-- QF_FOLDER_SHARES, EXPIRES_AT from 014) is about to end. The scheduler writes the row BEFORE it
-- sends anything, and the unique constraint QF_SREM_UQ_SHARE on (kind, report or folder, principal,
-- EXPIRES_AT) makes that insert the claim: a second app instance, or the same one after a
-- restart, gets a duplicate key (SQLSTATE 23505) and sends nothing. So a reminder goes out at most
-- once per share per end date. Changing a share's end date gives a new EXPIRES_AT, so the new end
-- date can be reminded about once too. A send that fails is marked FAILED and retried on a later
-- poll (up to a small number of ATTEMPTS) by a conditional UPDATE, which is also a claim.
-- Deliberately no foreign keys: a row must outlive the share, report, folder and users it names.
--   SHARE_KIND       'REPORT' (TARGET_ID is a REPORT_ID) or 'FOLDER' (TARGET_ID is a FOLDER_ID)
--   STATUS           CLAIMED (being sent), SENT, SKIPPED (nobody to e-mail), FAILED (will retry)
--   RECIPIENT_COUNT  messages sent (one per person)
--
-- QF_USER_SETTINGS: per-user settings, one row per user who changed one. SHARE_EMAILS = 0 turns
-- off e-mails about shares (being given access, a role change, and end-date reminders). No row
-- means the defaults (e-mails on). Removed with the user (ON DELETE CASCADE).
--
-- Additive only: two new tables and one index. Nothing existing is altered and no row is touched.
CREATE TABLE {{SCHEMA}}.QF_SHARE_REMINDERS (
  REMINDER_ID      VARCHAR(36)   NOT NULL,
  SHARE_KIND       VARCHAR(8)    NOT NULL,
  TARGET_ID        VARCHAR(36)   NOT NULL,
  PRINCIPAL_TYPE   VARCHAR(8)    NOT NULL,
  PRINCIPAL_ID     VARCHAR(128)  NOT NULL,
  EXPIRES_AT       TIMESTAMP     NOT NULL,
  STATUS           VARCHAR(8)    NOT NULL,
  ATTEMPTS         INTEGER       NOT NULL DEFAULT 1,
  RECIPIENT_COUNT  INTEGER       NOT NULL DEFAULT 0,
  CLAIMED_BY       VARCHAR(64)   NOT NULL,
  LAST_ERROR       VARCHAR(1000),
  CREATED_AT       TIMESTAMP     NOT NULL,
  UPDATED_AT       TIMESTAMP     NOT NULL,
  CONSTRAINT QF_SREM_PK PRIMARY KEY (REMINDER_ID),
  CONSTRAINT QF_SREM_UQ_SHARE UNIQUE (SHARE_KIND, TARGET_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, EXPIRES_AT),
  CONSTRAINT QF_SREM_CK_KIND CHECK (SHARE_KIND IN ('REPORT', 'FOLDER')),
  CONSTRAINT QF_SREM_CK_TYPE CHECK (PRINCIPAL_TYPE IN ('USER', 'GROUP')),
  CONSTRAINT QF_SREM_CK_STATUS CHECK (STATUS IN ('CLAIMED', 'SENT', 'SKIPPED', 'FAILED')),
  CONSTRAINT QF_SREM_CK_COUNTS CHECK (ATTEMPTS >= 0 AND RECIPIENT_COUNT >= 0)
);

CREATE INDEX {{SCHEMA}}.QF_SREM_IX_TIME ON {{SCHEMA}}.QF_SHARE_REMINDERS (EXPIRES_AT, STATUS);

CREATE TABLE {{SCHEMA}}.QF_USER_SETTINGS (
  USER_ID       VARCHAR(36)  NOT NULL,
  SHARE_EMAILS  SMALLINT     NOT NULL DEFAULT 1,
  UPDATED_AT    TIMESTAMP    NOT NULL,
  CONSTRAINT QF_USET_PK PRIMARY KEY (USER_ID),
  CONSTRAINT QF_USET_FK_USER FOREIGN KEY (USER_ID) REFERENCES {{SCHEMA}}.QF_USERS (USER_ID) ON DELETE CASCADE,
  CONSTRAINT QF_USET_CK_SHARE CHECK (SHARE_EMAILS IN (0, 1))
);

LABEL ON TABLE {{SCHEMA}}.QF_SHARE_REMINDERS IS 'Uncle Bob share expiry reminders sent';

LABEL ON TABLE {{SCHEMA}}.QF_USER_SETTINGS IS 'Uncle Bob per-user settings';

LABEL ON COLUMN {{SCHEMA}}.QF_SHARE_REMINDERS.EXPIRES_AT TEXT IS 'Share end date reminded about (UTC)';

LABEL ON COLUMN {{SCHEMA}}.QF_USER_SETTINGS.SHARE_EMAILS TEXT IS 'E-mail me about shares: 1 yes, 0 no';
