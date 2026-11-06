-- QueryForge / Uncle Bob metadata schema, version 7: report sharing access checks.
-- QF_REPORT_SHARES was defined in 002. This additive migration covers effective-role
-- lookups, global-admin visibility, schedule lists and revocation checks in QFMETA.
-- It changes no report data, creates no duplicate sharing tables and needs no browser SQL.
CREATE INDEX {{SCHEMA}}.QF_SHARE_IX_COVERS ON {{SCHEMA}}.QF_REPORT_SHARES
  (PRINCIPAL_ID, PRINCIPAL_TYPE, SHARE_ROLE, REPORT_ID);

CREATE INDEX {{SCHEMA}}.QF_SHARE_IX_REPORT_ROLE ON {{SCHEMA}}.QF_REPORT_SHARES
  (REPORT_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE);

CREATE INDEX {{SCHEMA}}.QF_SCHED_IX_CREATOR ON {{SCHEMA}}.QF_SCHEDULES
  (CREATED_BY, REPORT_ID);

LABEL ON TABLE {{SCHEMA}}.QF_REPORT_SHARES IS 'Uncle Bob user/group Viewer and Editor grants';
