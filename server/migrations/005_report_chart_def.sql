-- QueryForge metadata schema, version 5: saved chart settings.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts.
-- CHART_DEF holds the versioned chart JSON ({"version":1,"type":"bar",...}) shown with a
-- report's results, on its dashboard tile, in Excel exports and in scheduled emails.
-- It is separate from BUILDER_DEF so SQL-only reports can have charts too, and NULL when
-- the report has no chart. The server validates it on save and again on every read; field
-- names are only compared with result column names and are never part of any SQL.

ALTER TABLE {{SCHEMA}}.QF_REPORTS ADD COLUMN CHART_DEF CLOB(64K) CCSID 1208;

LABEL ON COLUMN {{SCHEMA}}.QF_REPORTS.CHART_DEF IS 'Chart settings JSON';
