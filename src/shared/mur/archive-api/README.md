# Pinned MUR run archive API

`schema/` is copied byte-for-byte from the mur-msgs commit recorded in `SOURCE.json`, the same way
as the live API in `../api/` (see its README). `../archive-types.ts` is generated from it, and
`../archive.ts` uses those types.

- `npm run archive-api:check`: verifies the schema hashes and the generated types offline. This also
  runs before `npm test`.
- `npm run archive-api:check -- --source /path/to/mur-msgs`: also compares the files with the pinned
  commit.
- Update: `node tools/live-api.mjs vendor --api archive --source /path/to/mur-msgs --commit <full-sha>`.
- `npm run archive-api:generate`: regenerates `../archive-types.ts`.

`test/mur/archive-contract.test.ts` checks the mock backend's archive answers against this schema.
The rules the schema can't express (order, paging, ETag, Range and 202 behaviour, and the
`bus<id>_<name>.dbc` snapshots attached to each run file) are in the pinned upstream
`api/archive/v1/README.md`. The MF4 importer decodes each bus with its attached snapshots
(`src/hub/dataSources/mf4/MDFImporter.ts`).

The current pin is `1e67d444e48a763759b93847de7b30ffcbd842ee` on mur-msgs branch
`feat/archive-api-v1`, which hasn't merged yet. Re-pin to the merge commit once it lands.
