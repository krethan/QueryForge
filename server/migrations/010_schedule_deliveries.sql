-- Uncle Bob metadata schema, version 10: scheduled report delivery history.
-- {{SCHEMA}} is replaced with META_SCHEMA by scripts/migrate.ts. All timestamps are UTC.
-- Additive only: one new table and its index; nothing existing is altered and no existing
-- row is touched. Schedules themselves stay in QF_SCHEDULES (002): the friendly cadences
-- (daily, weekdays, weekly, monthly) are stored there as the equivalent 5-field cron
-- expression plus the schedule's IANA time zone, so no column is added to it.
--
-- One row per delivery attempt, written when the attempt finishes, whether the scheduler
-- started it (RUN_TRIGGER 'SCHEDULE') or a person used "Run now" ('MANUAL', REQUESTED_BY set).
-- DELIVERED_TO lists the addresses the e-mail went to; SKIPPED_TO lists recipients that were
-- left out because they could no longer open the report at run time. Deleting a schedule
-- removes its history here; the run itself stays in QF_EXECUTIONS.
CREATE TABLE {{SCHEMA}}.QF_SCHEDULE_DELIVERIES (
  DELIVERY_ID    VARCHAR(36)   NOT NULL,
  SCHEDULE_ID    VARCHAR(36)   NOT NULL,
  REPORT_ID      VARCHAR(36)   NOT NULL,
  RUN_TRIGGER    VARCHAR(8)    NOT NULL,
  REQUESTED_BY   VARCHAR(36),
  STARTED_AT     TIMESTAMP     NOT NULL,
  FINISHED_AT    TIMESTAMP     NOT NULL,
  STATUS         VARCHAR(16)   NOT NULL,
  RESULT_ROWS    INTEGER,
  DELIVERED_TO   VARCHAR(4000),
  SKIPPED_TO     VARCHAR(4000),
  ERROR_MESSAGE  VARCHAR(1000),
  CONSTRAINT QF_SDLV_PK PRIMARY KEY (DELIVERY_ID),
  CONSTRAINT QF_SDLV_FK_SCHED FOREIGN KEY (SCHEDULE_ID) REFERENCES {{SCHEMA}}.QF_SCHEDULES (SCHEDULE_ID) ON DELETE CASCADE,
  CONSTRAINT QF_SDLV_CK_TRIGGER CHECK (RUN_TRIGGER IN ('SCHEDULE', 'MANUAL')),
  CONSTRAINT QF_SDLV_CK_STATUS CHECK (STATUS IN ('SUCCEEDED', 'FAILED'))
);

CREATE INDEX {{SCHEMA}}.QF_SDLV_IX_SCHED ON {{SCHEMA}}.QF_SCHEDULE_DELIVERIES (SCHEDULE_ID, STARTED_AT DESC);

LABEL ON TABLE {{SCHEMA}}.QF_SCHEDULE_DELIVERIES IS 'Uncle Bob scheduled report delivery history';
