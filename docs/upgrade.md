# Upgrading an existing install

This runbook upgrades an existing Uncle Bob install to the current `main`, which includes metadata
migrations up to **015** and the settings added through PR #34. For what changed, see
[`CHANGELOG.md`](../CHANGELOG.md).

> **Not verified on IBM i.** Nothing in Uncle Bob has run against a real IBM i or Mapepire server yet,
> and migrations 001–015 have never been applied to Db2 for i. The steps and SQL below come from the
> code in this repository. They have not been rehearsed on a real system. Run the
> [verification kit](ibmi-verification.md) on a **non-production** partition first, and rehearse this
> runbook there before using it anywhere that matters. Never run the kit against production.

Contents:

1. [Before you start](#1-before-you-start)
2. [Back up the metadata library](#2-back-up-the-metadata-library)
3. [Review the settings](#3-review-the-settings)
4. [Apply the upgrade](#4-apply-the-upgrade)
5. [Migration reference](#5-migration-reference)
6. [Rollback](#6-rollback)
7. [Post-upgrade checklist](#7-post-upgrade-checklist)

Examples use `QFMETA` for `META_SCHEMA`, `QFAPP` for `META_DB_USER` and `QGPL/QFMETAPRE` for the save
file. Substitute your own names.

## 1. Before you start

### 1.1 Find out where you are

The migrations already applied are recorded in `QF_SCHEMA_VERSION`. Run this in ACS Run SQL Scripts:

```sql
SELECT VERSION, FILE_NAME, APPLIED_AT
  FROM QFMETA.QF_SCHEMA_VERSION
 ORDER BY VERSION;
```

Pending migrations are the files in `server/migrations/` whose number is not in that list. The app does
**not** check the schema version at start-up. New code running against an un-migrated library fails at
runtime with SQL errors. For example, every access check reads `EXPIRES_AT` from migration 014. Always
migrate before you start the new code.

### 1.2 Pre-checks

| Check                | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verified on non-prod | Run `npm run verify:ibmi` on a **non-production** partition: the dry run, the read-only checks, then `--apply-migrations --cleanup <LIB>` ([commands](ibmi-verification.md#3-run-the-verification-kit)). Apply only after it passes and you have worked through the [manual UI checklist](ibmi-verification.md#6-manual-ui-checklist).                                                                                                                                                                 |
| IBM i release        | 7.2 or later. The folder audit and the Deleted folders screen page with `OFFSET … FETCH FIRST`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Node.js              | 22 or 24, the versions CI runs. `engines` allows 20.19 and later, but Node 20 rounds DECIMAL values over 15 digits and BIGINT values.                                                                                                                                                                                                                                                                                                                                                                  |
| Journaling           | The app's transactions run under commitment control, so the metadata tables must be journaled. A library created with SQL `CREATE SCHEMA` has a `QSQJRN` journal, and tables created in it later are journaled automatically. Check with `SELECT OBJNAME FROM TABLE(QSYS2.OBJECT_STATISTICS('QFMETA', '*JRN')) X`. No rows usually means the library was created with `CRTLIB`. **Stop** and have your DBA set up journaling for the library (for example with `STRJRNLIB`) before you continue.       |
| Authority            | The migration identity needs authority to create tables and indexes in `QFMETA` and to alter the existing `QF_*` tables (see [`IBMI_SETUP.md`](IBMI_SETUP.md#3-metadata-schema)). By default `npm run migrate` connects as `META_DB_USER`. Set `MIGRATE_DB_USER` and `MIGRATE_DB_PASSWORD` to run it as a separate, more privileged profile.                                                                                                                                                           |
| Quiet window         | Migration 014 runs six `ALTER TABLE … ADD COLUMN` statements. On IBM i each one rebuilds the table and holds an exclusive lock while it runs. Migrations 012 and 014 also replace check constraints, and Db2 for i re-checks every existing row. Installs older than 005 also get `ADD COLUMN`s on `QF_REPORTS`, `QF_EXECUTIONS` and `QF_USERS` (002, 004, 005). Stop **every** app instance, and schedule the work for a time when nobody else (ACS sessions, queries, jobs) holds locks on `QFMETA`. |
| Locks                | Just before migrating, check that nothing else holds `QFMETA` objects, for example with `WRKOBJLCK OBJ(QFMETA/QF_REPORT_SHARES) OBJTYPE(*FILE)` for each table 014 alters: `QF_REPORT_SHARES`, `QF_FOLDER_SHARES`, `QF_SHARE_AUDIT` and `QF_FOLDER_SHARE_AUDIT`.                                                                                                                                                                                                                                       |
| Backups              | Take a save of `QFMETA` ([section 2](#2-back-up-the-metadata-library)). Also copy `server/.env` and note the commit (`git rev-parse HEAD`) of the build you are replacing.                                                                                                                                                                                                                                                                                                                             |
| Retention decision   | Decide **before** start-up whether old delivery history and reminder rows may be deleted ([section 3.3](#33-history-retention-deletes-rows-by-default)).                                                                                                                                                                                                                                                                                                                                               |

## 2. Back up the metadata library

Back up after the app is stopped, so that the save is consistent:

```text
CRTSAVF FILE(QGPL/QFMETAPRE) TEXT('QFMETA before Uncle Bob upgrade')
SAVLIB  LIB(QFMETA) DEV(*SAVF) SAVF(QGPL/QFMETAPRE)
DSPSAVF FILE(QGPL/QFMETAPRE)
```

If your shop saves objects rather than libraries, use
`SAVOBJ OBJ(*ALL) LIB(QFMETA) DEV(*SAVF) SAVF(QGPL/QFMETAPRE)`. Check with `DSPSAVF` that the save file
lists every `QF_*` file, and the `QSQJRN` journal if you use `SAVLIB`. Keep the save until the upgrade
has been in use long enough that you would no longer roll back. If the library holds anything other than
Uncle Bob metadata, follow your normal backup policy as well.

## 3. Review the settings

Settings live in `server/.env` (the template is [`.env.example`](../.env.example)). The settings below
were added or gained a new use with the features in the changelog. Defaults come from
`server/src/config/config.ts`. An invalid value stops the server at start-up with a configuration error.

### 3.1 E-mail (scheduled delivery and share notifications)

| Setting                                     | Default      | What it does                                                                                                                                                                              |
| ------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_HOST`                                 | none         | Turns e-mail on. Without it, scheduled delivery returns `503 MAIL_NOT_CONFIGURED` when a schedule is saved as active, resumed or run now. Sharing still works but sends no notifications. |
| `SMTP_PORT` / `SMTP_SECURE`                 | 587 / false  | `SMTP_SECURE=false` means STARTTLS is required, with no plaintext fallback                                                                                                                |
| `SMTP_USER` / `SMTP_PASSWORD`               | none         | SMTP credentials. Keep them in `server/.env` only and never commit them.                                                                                                                  |
| `SMTP_FROM`                                 | none         | Sender. **Required** when `SMTP_HOST` is set.                                                                                                                                             |
| `SMTP_REJECT_UNAUTHORIZED` / `SMTP_CA_FILE` | true / none  | TLS certificate checks. `SMTP_CA_FILE` is not in `.env.example`, but `config.ts` reads it.                                                                                                |
| `SCHEDULE_RECIPIENT_DOMAINS`                | none         | Exact-match domain allow-list. Empty disables scheduled e-mail. When it is set, notification e-mails to other domains are skipped.                                                        |
| `SCHEDULE_DEFAULT_TIMEZONE`                 | UTC          | Zone shown first in the schedule editor, and the zone used for end dates in notification e-mails                                                                                          |
| `QF_PUBLIC_BASE_URL`                        | `APP_ORIGIN` | Public `http(s)://` address used for links in e-mails. It is never taken from the request's `Host` header.                                                                                |
| `QF_SHARE_REMINDER_DAYS`                    | 3            | How many days before a share ends its owner is reminded (0–60). `0` turns reminders off.                                                                                                  |
| `QF_SHARE_REMINDER_TO_RECIPIENT`            | false        | Also remind the people whose access is ending                                                                                                                                             |

### 3.2 Scheduler

| Setting                                    | Default        | What it does                                                                                                                                                         |
| ------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCHEDULER_ENABLED`                        | false          | Runs scheduled deliveries, end-date reminders **and automatic history retention** on the instance that holds the `QF_LOCKS` lease (only one instance acts at a time) |
| `SCHEDULER_POLL_MS` / `SCHEDULER_LEASE_MS` | 30000 / 120000 | Poll interval and lease length                                                                                                                                       |

### 3.3 History retention deletes rows by default

Retention (PR #34) needs no migration, but **it is on by default for two tables**:

| Table                                                            | Setting                    | Default  | Allowed values  | Age measured from                               |
| ---------------------------------------------------------------- | -------------------------- | -------- | --------------- | ----------------------------------------------- |
| `QF_SCHEDULE_DELIVERIES`                                         | `QF_RETAIN_DELIVERY_DAYS`  | **365**  | 0, or 7–36500   | `STARTED_AT`                                    |
| `QF_SHARE_REMINDERS`                                             | `QF_RETAIN_REMINDER_DAYS`  | **180**  | 0, or 7–36500   | the share's end date (`EXPIRES_AT`)             |
| `QF_EXECUTIONS`                                                  | `QF_RETAIN_EXECUTION_DAYS` | 0 (keep) | 0, or 30–36500  | `STARTED_AT` (a `RUNNING` row is never deleted) |
| `QF_SHARE_AUDIT`, `QF_FOLDER_SHARE_AUDIT`, `QF_FOLDER_DELETIONS` | `QF_RETAIN_AUDIT_DAYS`     | 0 (keep) | 0, or 365–36500 | `OCCURRED_AT` / `DELETED_AT`                    |
| (all of the above)                                               | `QF_RETAIN_BATCH_SIZE`     | 1000     | 10–10000        | Rows per `DELETE` statement                     |
| (all of the above)                                               | `QF_RETAIN_MAX_BATCHES`    | 100      | 1–10000         | `DELETE` statements per table per run           |

- **What happens on first start.** With `SCHEDULER_ENABLED=true`, the scheduler leader prunes on its
  **first poll after start-up**, then at most once a day. It deletes **delivery history older than 365
  days** and **reminder rows whose share ended more than 180 days ago**. Retention keeps its "once a day"
  timer in memory, so each restart or change of leader runs it again. A repeat run is harmless. An admin
  can also start it from **Data retention** in the side navigation. Deleted rows can only come back by
  restoring a save.
- **To keep everything**, set both to `0` before you start the upgraded app:

  ```dotenv
  QF_RETAIN_DELIVERY_DAYS=0
  QF_RETAIN_REMINDER_DAYS=0
  ```

  When every period is `0`, automatic runs do nothing.

- A value below a setting's minimum, such as `QF_RETAIN_AUDIT_DAYS=90`, stops the server at start-up.
- Each statement deletes at most `QF_RETAIN_BATCH_SIZE` rows and commits on its own. These tables have
  no time-leading indexes, so a batch may scan its table. Rows still left after `QF_RETAIN_MAX_BATCHES`
  statements wait for the next run.
- To see what the first run would delete, count it before you upgrade. Run each query only if its
  migration (010 or 015) is already applied:

  ```sql
  SELECT COUNT(*) FROM QFMETA.QF_SCHEDULE_DELIVERIES
   WHERE STARTED_AT < (CURRENT TIMESTAMP - CURRENT TIMEZONE) - 365 DAYS;
  SELECT COUNT(*) FROM QFMETA.QF_SHARE_REMINDERS
   WHERE EXPIRES_AT < (CURRENT TIMESTAMP - CURRENT TIMEZONE) - 180 DAYS;
  ```

### 3.4 Other settings worth checking

| Setting                                   | Default                     | What it does                                                                      |
| ----------------------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| `DATE_PRESET_TIMEZONE`                    | `SCHEDULE_DEFAULT_TIMEZONE` | IANA zone used to work out rolling date presets ("last month" and so on)          |
| `CATALOG_CACHE_TTL_MS`                    | 60000                       | How long the Report Builder caches catalog reads in memory (`0` disables caching) |
| `MIGRATE_DB_USER` / `MIGRATE_DB_PASSWORD` | none (uses `META_DB_USER`)  | Only read by `npm run migrate`. See [section 4](#4-apply-the-upgrade).            |

## 4. Apply the upgrade

1. **Stop every Uncle Bob instance**, including any instance that runs only the scheduler.
2. **Take the save** ([section 2](#2-back-up-the-metadata-library)).
3. **Deploy the code** on the app server:

   ```bash
   git fetch origin && git checkout main && git pull --ff-only
   npm ci
   npm run build
   ```

4. **Update `server/.env`** ([section 3](#3-review-the-settings)). Decide on retention now.
5. **Preview the SQL.** This connects to nothing, but it reads `server/.env` (for `META_SCHEMA`), so
   the settings must be valid:

   ```bash
   npm run --silent migrate -- --print > migrate.sql
   ```

   The output contains the `QF_SCHEMA_VERSION` DDL and **every** migration file, applied or not, each
   headed `-- NNN_name.sql`. Review the sections for your pending migrations. If npm printed its own
   header lines into the file, delete them.

6. **Apply the migrations:**

   ```bash
   npm run migrate
   # or, with a separate migration profile (do not keep its password in server/.env):
   MIGRATE_DB_USER=QFMIGR MIGRATE_DB_PASSWORD='…' npm run migrate
   ```

   The script prints `= NNN_….sql (already applied)` or `+ NNN_….sql` for each file, then
   `Migrations complete.` It then runs `REVOKE ALL … FROM PUBLIC` on every metadata table. If the
   migration profile is not `META_DB_USER`, it also grants `META_DB_USER`
   `SELECT, INSERT, UPDATE, DELETE` (only `SELECT` on `QF_SCHEMA_VERSION`).

   **If it fails:** the script stops at the failing statement and prints `Migration failed: …`. Each
   statement commits on its own, so objects created earlier **in the same file** remain, and that file's
   `QF_SCHEMA_VERSION` row is **not** written. Running it again would then fail on the objects that
   already exist. Don't patch the file or the version table by hand. Restore the save
   ([section 6](#6-rollback)), fix the cause, and try again.

   **DBA-run alternative:** a DBA can run the pending sections of `migrate.sql` in ACS. After each file
   succeeds, record it:

   ```sql
   INSERT INTO QFMETA.QF_SCHEMA_VERSION (VERSION, FILE_NAME, APPLIED_AT)
   VALUES (14, '014_share_expiry.sql', CURRENT TIMESTAMP - CURRENT TIMEZONE);
   ```

   Then repeat the revoke and grant step yourself for the new tables. For migrations 010–015 those are
   `QF_SCHEDULE_DELIVERIES`, `QF_FOLDER_REPORT_SHARING`, `QF_FOLDER_DELETIONS`, `QF_SHARE_REMINDERS`
   and `QF_USER_SETTINGS`. Alternatively, run `npm run migrate` afterwards: it skips recorded files and
   redoes the revoke and grant.

7. **Check the version table** ([section 1.1](#11-find-out-where-you-are)). You should see one row for
   each of versions 1 to 15.
8. **Start the app** and work through the [post-upgrade checklist](#7-post-upgrade-checklist).

## 5. Migration reference

"Additive" means the migration adds objects or nullable columns and rewrites no existing values. The
previous app version ignores what an additive migration adds. That is expected from the code but has not
been tested, so restoring the save stays the supported rollback.

| #   | Adds or changes                                                                                                                                                                                                               | Additive?                                                             | Locking and risk                                                                                                                                                                        | Rollback                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | `QF_USERS`, `QF_REPORTS`, `QF_EXECUTIONS` and indexes                                                                                                                                                                         | New install                                                           | None                                                                                                                                                                                    | Not applicable                                                                                                                                                              |
| 002 | Columns on `QF_REPORTS`, `QF_EXECUTIONS` and `QF_USERS` (one `NOT NULL DEFAULT 'LOCAL'`), `QF_EXEC_CK_KIND` and `QF_USERS_CK_SOURCE` checks, a unique index, `QF_USER_GROUPS`, `QF_REPORT_SHARES`, `QF_SCHEDULES`, `QF_LOCKS` | Mostly (`AUTH_SOURCE` fills existing rows with `'LOCAL'`)             | `ADD COLUMN` rebuilds three tables under exclusive locks. The check constraints are verified over every row.                                                                            | Restore the save                                                                                                                                                            |
| 003 | `QF_SHARE_AUDIT`                                                                                                                                                                                                              | Yes                                                                   | New table                                                                                                                                                                               | Restore the save                                                                                                                                                            |
| 004 | `QF_REPORTS.BUILDER_DEF` (CLOB, nullable)                                                                                                                                                                                     | Yes                                                                   | Rebuilds `QF_REPORTS` under an exclusive lock                                                                                                                                           | Restore the save                                                                                                                                                            |
| 005 | `QF_REPORTS.CHART_DEF` (CLOB, nullable)                                                                                                                                                                                       | Yes                                                                   | Rebuilds `QF_REPORTS` under an exclusive lock                                                                                                                                           | Restore the save                                                                                                                                                            |
| 006 | `QF_FOLDERS`, `QF_REPORT_PREFS`                                                                                                                                                                                               | Yes                                                                   | New tables                                                                                                                                                                              | Restore the save                                                                                                                                                            |
| 007 | Indexes `QF_SHARE_IX_COVERS`, `QF_SHARE_IX_REPORT_ROLE`, `QF_SCHED_IX_CREATOR`                                                                                                                                                | Yes                                                                   | Index builds over `QF_REPORT_SHARES` and `QF_SCHEDULES`                                                                                                                                 | Restore the save                                                                                                                                                            |
| 008 | `QF_TILE_ORDER`                                                                                                                                                                                                               | Yes                                                                   | New table                                                                                                                                                                               | Restore the save                                                                                                                                                            |
| 009 | `QF_FOLDER_SHARES`, `QF_FOLDER_REPORTS`, `QF_FOLDER_SHARE_AUDIT`                                                                                                                                                              | Yes                                                                   | New tables. The label was shortened to 48 bytes before the file was first applied. A copy of the file from before #28 would fail at its `LABEL ON`.                                     | Restore the save                                                                                                                                                            |
| 010 | `QF_SCHEDULE_DELIVERIES`                                                                                                                                                                                                      | Yes                                                                   | New table                                                                                                                                                                               | Restore the save                                                                                                                                                            |
| 011 | `QF_FOLDER_REPORT_SHARING`                                                                                                                                                                                                    | Yes                                                                   | New table                                                                                                                                                                               | Restore the save                                                                                                                                                            |
| 012 | `QF_FSAU_CK_TYPE` widened to allow `'REPORTS'`                                                                                                                                                                                | No (constraint replaced)                                              | Drop and re-add a check constraint. Every existing row is re-checked under a lock.                                                                                                      | Restore the save. The previous app writes only `USER`/`GROUP`, which the wider check still allows.                                                                          |
| 013 | `QF_FOLDER_DELETIONS`                                                                                                                                                                                                         | Yes                                                                   | New table                                                                                                                                                                               | Restore the save                                                                                                                                                            |
| 014 | `EXPIRES_AT` on `QF_REPORT_SHARES` and `QF_FOLDER_SHARES`, `OLD_EXPIRES_AT` and `NEW_EXPIRES_AT` on `QF_SHARE_AUDIT` and `QF_FOLDER_SHARE_AUDIT`, `EXPIRY` audit action, column labels                                        | Columns are additive (nullable, no default); constraints are replaced | **Highest risk.** Six `ADD COLUMN`s rebuild four tables under exclusive locks, and two check constraints are replaced (each re-validated). Run with the app stopped, in a quiet window. | Restore the save. **Do not** run the previous app against this schema after people have set end dates: it ignores `EXPIRES_AT`, so expired shares would grant access again. |
| 015 | `QF_SHARE_REMINDERS`, `QF_USER_SETTINGS`                                                                                                                                                                                      | Yes                                                                   | New tables                                                                                                                                                                              | Restore the save                                                                                                                                                            |

## 6. Rollback

Migrations have no "down" scripts. Roll back by restoring the save from
[section 2](#2-back-up-the-metadata-library) and redeploying the previous build. Never drop objects by
hand.

1. **Stop every Uncle Bob instance.**
2. **Restore the metadata library.** `RSTLIB` replaces the objects in the save, but it does **not**
   remove objects created after the save, such as the new tables. Restoring a table whose columns changed
   (014) over the newer version may also be refused. The clean path is to remove the library and restore
   it whole. Have your DBA review this first, because `DLTLIB` deletes everything in the library,
   including rows written since the save:

   ```text
   DSPSAVF FILE(QGPL/QFMETAPRE)                         /* confirm the save is the right one */
   DLTLIB  LIB(QFMETA)
   RSTLIB  SAVLIB(QFMETA) DEV(*SAVF) SAVF(QGPL/QFMETAPRE)
   ```

   Then confirm journaling (`OBJECT_STATISTICS(… '*JRN')`) and the version rows
   ([section 1.1](#11-find-out-where-you-are)), and check object authorities with `DSPOBJAUT`.

3. **Redeploy the previous build** (`git checkout <previous commit>`, `npm ci`, `npm run build`) and
   restore the previous `server/.env`.
4. **Start the app** and run the post-upgrade checks that apply to the old version.

What a rollback loses: everything written after the save. That includes new shares and end dates,
folder changes, audit rows, delivery history and reminder claims, plus any rows retention deleted.
Deleted rows come back only from the save.

## 7. Post-upgrade checklist

- [ ] `QF_SCHEMA_VERSION` lists versions 1–15 ([section 1.1](#11-find-out-where-you-are)).
- [ ] The server starts with no configuration error, and its log shows no SQL errors.
- [ ] Sign in, open the dashboard, run a saved report, and export it to Excel.
- [ ] Report Builder: the table list loads and a table's columns load. A table with more than 1,000
      columns shows the "Only the first 1,000" notice.
- [ ] Share dialog (report and folder): the **Until** date and **Notify people by e-mail** controls
      appear. Without SMTP, the dialog says e-mail isn't set up.
- [ ] A test share with an end date stops working after that date (try it on test data, not real users).
- [ ] **Account → Notifications** shows the share e-mail opt-out.
- [ ] As an admin: **Deleted folders** and **Data retention** open. Data retention shows the retention
      periods you intended. If you set both to `0`, nothing is pruned.
- [ ] With `SCHEDULER_ENABLED=true` and any retention period above `0`, check the log after the first
      poll for `history retention` lines. They report rows deleted per table. Compare the counts with what
      you expected ([section 3.3](#33-history-retention-deletes-rows-by-default)), or check **Data
      retention** for the last run's counts.
- [ ] With SMTP: **Run now** on a test schedule sends to a test recipient and appears in delivery
      history.
- [ ] Folder **Access and audit** opens, and **Export CSV** downloads the history.
- [ ] `*PUBLIC` has no access to the new tables, for example
      `DSPOBJAUT OBJ(QFMETA/QF_SHARE_REMINDERS) OBJTYPE(*FILE)`.
- [ ] Keep the save file until you are sure you will not roll back.

Record anything unexpected in the [results template](ibmi-verification.md#7-results-template).
