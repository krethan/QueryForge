-- Uncle Bob metadata schema, version 12: folder report-sharing changes in the folder audit trail.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
--
-- QF_FOLDER_SHARE_AUDIT (009) only allowed PRINCIPAL_TYPE 'USER' or 'GROUP'. Turning the owner's
-- "also share the reports in this folder" option (011) on, off, or changing its level is now
-- written to the same trail, in the same transaction as the change, as one row with
-- PRINCIPAL_TYPE 'REPORTS' and PRINCIPAL_ID '*REPORTS': ACTION GRANT (turned on), CHANGE (level
-- changed) or REVOKE (turned off), with OLD_ROLE / NEW_ROLE holding the MAX_ROLE before and after.
--
-- The only change is replacing the PRINCIPAL_TYPE check constraint with a wider one. No table,
-- column or row is added, removed or rewritten; every existing row ('USER' or 'GROUP') satisfies
-- the new constraint, which Db2 for i verifies when it is added.
ALTER TABLE {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT DROP CONSTRAINT QF_FSAU_CK_TYPE;

ALTER TABLE {{SCHEMA}}.QF_FOLDER_SHARE_AUDIT ADD CONSTRAINT QF_FSAU_CK_TYPE CHECK (PRINCIPAL_TYPE IN ('USER', 'GROUP', 'REPORTS'));
