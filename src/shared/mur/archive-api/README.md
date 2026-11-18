# Pinned MUR run archive API

`schema/` is copied byte-for-byte from the mur-msgs commit recorded in `SOURCE.json`, the same way
as the live API in `../api/` (see its README). `../archive-types.ts` is generated from it, and
`../archive.ts` uses those types.

- `npm run archive-api:check`: verifies the schema hashes and the generated types offline. This also
  runs before `npm test`.
- `npm run archive-api:check -- --source /path/to/mur-msgs`: also compares the files with the pinned
  commit.
- Update: `node tools/live-api.mjs vendor --api archive --source /path/to/mur-msgs --tag vX.Y.Z`.
- `npm run archive-api:generate`: regenerates `../archive-types.ts`.

`test/mur/archive-contract.test.ts` checks the mock backend's archive answers against this schema.
The rules the schema can't express (order, paging, ETag, Range and 202 behaviour, and the
`bus<id>_<name>.dbc` snapshots attached to each run file) are in the pinned upstream
`api/archive/v1/README.md`. The MF4 importer decodes each bus with its attached snapshots
(`src/hub/dataSources/mf4/MDFImporter.ts`).

The current pin is release `v0.2.1`, commit `9e545028194f25f459ba7b42500b0b14e653c178`. Pin
release tags, as the upstream README asks: `SOURCE.json` records the tag and the commit it resolves
to, and `--source` checks the tag still points there.
