# Db2 for i metadata migrations

Files are applied in lexical order by `npm run migrate` and recorded in
`<META_SCHEMA>.QF_SCHEMA_VERSION`. Each file runs once; never edit an applied file —
add a new `NNN_description.sql` instead. Statements are separated by a `;` at end of line.
`{{SCHEMA}}` is substituted with `META_SCHEMA`.

See `docs/IBMI_SETUP.md` for the authorities the migration identity requires and
`npm run migrate -- --print` to emit the SQL for a DBA to run manually.
