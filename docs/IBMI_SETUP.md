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
`QFREPORT` should have **no** authority to `QFMETA` (it is also blocked by the validator).

## 4. Reporting authorities

Grant `QFREPORT` only what reports need, e.g.:

```
GRTOBJAUT OBJ(MYLIB) OBJTYPE(*LIB) USER(QFREPORT) AUT(*USE)
GRANT SELECT ON MYLIB.ORDERS TO QFREPORT;
```

Database authority is the real security boundary; the SQL validator and read-only job are defence in depth.

## 5. Verify (non-production)

```
QF_INTEGRATION=1 npm run test:integration
```
