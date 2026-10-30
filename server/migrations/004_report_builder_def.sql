-- QueryForge metadata schema, version 4: saved Report Builder definitions.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts.
-- BUILDER_DEF holds the versioned Report Builder JSON ({"version":1,...}) for reports
-- created or last saved in the builder, so they can be reopened and edited there.
-- It is NULL for reports written as SQL. The server re-validates the definition
-- against the catalog and regenerates SQL_TEXT / PARAMETERS_JSON from it on every
-- save, so SQL_TEXT remains the only thing that is ever executed.

ALTER TABLE {{SCHEMA}}.QF_REPORTS ADD COLUMN BUILDER_DEF CLOB(1M) CCSID 1208;

LABEL ON COLUMN {{SCHEMA}}.QF_REPORTS.BUILDER_DEF IS 'Report Builder definition JSON';
