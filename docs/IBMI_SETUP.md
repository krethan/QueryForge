# IBM i setup (non-production first)

> Nothing in this repository has been run against a real IBM i system yet. Validate every step
> on a development/test partition before considering production.

## 1. Mapepire server

Install and start the Mapepire server on IBM i (see https://mapepire-ibmi.github.io/):

```
yum install mapepire-server
sc start mapepire        # via Service Commander
```

Default port is 8076. Use a CA-signed certificate in production; if you use a self-signed one, give
the app its certificate with `MAPEPIRE_CA_FILE` instead of setting `MAPEPIRE_REJECT_UNAUTHORIZED=false`.

## 2. User profiles (examples — adapt to your security policy)

| Profile    | Purpose                                                   | Notes                                                                 |
| ---------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| `QFAPP`    | Owns/updates metadata in `META_SCHEMA` (default `QFMETA`) | `*USER` class, no special authorities                                 |
| `QFREPORT` | Runs user report SQL                                      | `*USER` class, no special authorities, **read-only** object authority |

```
CRTUSRPRF USRPRF(QFAPP)    PASSWORD(...) USRCLS(*USER) SPCAUT(*NONE) INLMNU(*SIGNOFF) LMTCPB(*YES)
CRTUSRPRF USRPRF(QFREPORT) PASSWORD(...) USRCLS(*USER) SPCAUT(*NONE) INLMNU(*SIGNOFF) LMTCPB(*YES)
```

## 3. Metadata schema

Either let `npm run migrate` create it as `QFAPP` (needs authority to create a schema), or have a DBA run
the SQL from `npm run migrate -- --print` and then:

```
GRANT SELECT, INSERT, UPDATE, DELETE ON QFMETA.QF_USERS, QFMETA.QF_REPORTS,
      QFMETA.QF_EXECUTIONS, QFMETA.QF_SCHEMA_VERSION TO QFAPP;
```

Objects: `QF_USERS`, `QF_REPORTS`, `QF_EXECUTIONS`, `QF_SCHEMA_VERSION` and their indexes.

### Migration 002 — parameters, sharing, schedules

`server/migrations/002_parameters_sharing_schedules.sql` (applied by `npm run migrate`, or print it with
`npm run migrate -- --print` for a DBA) adds:

- `QF_REPORTS.PARAMETERS_JSON` (parameter definitions), `QF_EXECUTIONS.PARAMS_JSON` and `SCHEDULE_ID`,
  and the `QF_EXEC_CK_KIND` check constraint is dropped and re-created to allow kind `SCHEDULE`;
- `QF_USERS.AUTH_SOURCE` / `EXTERNAL_ID` / `EMAIL` (+ unique index) for OIDC/LDAP users;
- new tables `QF_USER_GROUPS`, `QF_REPORT_SHARES`, `QF_SCHEDULES` and `QF_LOCKS` (scheduler lease).

It is additive (no data is dropped) and recorded in `QF_SCHEMA_VERSION`. Run it on a non-production
system first and take a save of `QFMETA` before applying it anywhere else. If a DBA applies it, grant:

```
GRANT SELECT, INSERT, UPDATE, DELETE ON QFMETA.QF_USER_GROUPS, QFMETA.QF_REPORT_SHARES,
      QFMETA.QF_SCHEDULES, QFMETA.QF_LOCKS TO QFAPP;
```

`QFREPORT` still needs no authority to `QFMETA`. Scheduled runs use the same `QFREPORT` read-only job as
interactive runs, so no extra IBM i authority is needed for scheduling. SMTP, OIDC and LDAP traffic
originates from the QueryForge server, not from IBM i.

### Migration 003 — sharing audit

`server/migrations/003_share_audit.sql` adds the table `QF_SHARE_AUDIT` (one row per share grant, role
change or revoke, written in the same transaction as the share change) and the index
`QF_SAUD_IX_REPORT`. It is additive and has no foreign key to `QF_REPORTS`, so the trail is kept when a
report is deleted. The application profile only inserts and reads it; if a DBA applies the migration, grant:

```
GRANT SELECT, INSERT ON QFMETA.QF_SHARE_AUDIT TO QFAPP;
```

(Withholding `UPDATE`/`DELETE` keeps the trail append-only for the application; purge old rows as a DBA task.)
As with 002, apply it to a non-production system first and save `QFMETA` beforehand.

Paged results keep one `QFREPORT` Mapepire job per open cursor for at most `CURSOR_MAX_LIFETIME_MS`
(default 10 minutes); size `MAX_OPEN_CURSORS` with the Mapepire server's job limits in mind.
`QFREPORT` should have **no** authority to `QFMETA` (it is also blocked by the validator).

## 4. Reporting authorities

Grant `QFREPORT` only what reports need, e.g.:

```
GRTOBJAUT OBJ(MYLIB) OBJTYPE(*LIB) USER(QFREPORT) AUT(*USE)
GRANT SELECT ON MYLIB.ORDERS TO QFREPORT;
```

Database authority is the real security boundary; the SQL validator and read-only job are defence in depth.

### Report Builder catalog access

The **Report Builder** page lists tables by reading `QSYS2.SYSTABLES` / `QSYS2.SYSCOLUMNS` as `QFREPORT`
and asking `QSYS2.SQL_CHECK_AUTHORITY(library, file) = 1` for each object, so `QFREPORT` needs:

```
GRTOBJAUT OBJ(QSYS2) OBJTYPE(*LIB) USER(QFREPORT) AUT(*USE)
-- the SQL catalog views themselves are normally PUBLIC *USE / *OBJOPR on IBM i:
GRTOBJAUT OBJ(QSYS2/SYSTABLES) OBJTYPE(*FILE) USER(QFREPORT) AUT(*USE)
GRTOBJAUT OBJ(QSYS2/SYSCOLUMNS) OBJTYPE(*FILE) USER(QFREPORT) AUT(*USE)
```

Notes:

- `SQL_CHECK_AUTHORITY` returns 1 only for objects `QFREPORT` can read directly (or through a group profile,
  `*PUBLIC` authority or an authorization list). If a library is not in `REPORT_LIBRARIES` and not
  `REPORT_DEFAULT_SCHEMA`, `QSYS`, `QSYS2`, `SYSIBM`, `SYSIBMADM`, `SYSCAT`, `SYSSTAT` and the other
  `PROTECTED_SCHEMAS` are hidden from the picker; when `REPORT_LIBRARIES` is set, only those libraries are listed.
- `SQL_CHECK_AUTHORITY` is _not_ a substitute for real object authority: it can miss adopted-authority cases and
  it only answers for the profile that runs it. The reporting profile still cannot read anything Db2 does not
  let it read, and the page only ever issues `SELECT`s.
- The catalog list is cached in memory for `CATALOG_CACHE_TTL_MS` (default 60 s); a newly created table or a new
  grant appears after that TTL (or a server restart), not immediately.

## 5. Verify (non-production)

```
QF_INTEGRATION=1 npm run test:integration
```
