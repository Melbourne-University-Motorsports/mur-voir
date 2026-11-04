# Pinned MUR live API

`schema/` is copied byte-for-byte from the private mur-msgs commit recorded in
`SOURCE.json`. This copy contains protocol definitions only, no DBC data or logs.
Public builds need no private repository access.

- `npm run live-api:check`: verifies schema content hashes and regenerated types offline.
  This also runs before `npm test` and in public CI.
- `npm run live-api:check -- --source /path/to/mur-msgs`: additionally compares every
  schema file against the exact pinned commit using Git, including the file list.
- Update: `node tools/live-api.mjs vendor --source /path/to/mur-msgs --commit <full-sha>`.
  This copies committed schema bytes, records their hashes, and regenerates types.
- `npm run live-api:generate`: regenerates `../live-types.ts` from the verified copy.

Review schema/hash/pin changes together; the offline check detects accidental drift,
not a malicious edit of both schema and manifest. A maintainer with private access
should run the upstream comparison when updating the pin. Do not merge the initial
vendoring until mur-msgs PR #6 is merged and this pin names the merged commit.

`../contract.ts` contains runtime helpers. Its exported wire types come entirely
from the generated file; no application code needs to import the mock backend.
The test suite validates real mock HTTP/WebSocket output and descriptor-directed
values. Stateful conformance rules are in the pinned upstream `api/live/v1/README.md`.
Simulation/ROS metadata and stream-aware history are optional. `/api/v1/points`
and `mur-points-v1` remain an experimental binary extension outside the core JSON
contract, with no car requirement.

Proposed release tag after merge: `live-api-v1.0.0`. Runtime `hello.api_version`
and `unsupported_api_version` remain necessary because components deploy separately.

This protocol-only copy exposes no credentials or vendor DBC contents. The public
repository's pre-existing private/vendor DBC copies raise a separate, unresolved
licensing/ownership question; this change does not alter them.
