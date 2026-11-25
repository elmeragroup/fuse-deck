# @elmeragroup/effect-acp

An Effect client and agent for the [Agent Client Protocol](https://agentclientprotocol.com) (ACP):
JSON-RPC over NDJSON stdio, typed through `effect/rpc`, for both the v1 and the v2 schema. The
studio backend uses its client to talk to an agent CLI. It is private and never published: the
backend's build inlines it.

## Provenance

Vendored from T3 Code (https://github.com/pingdotgg/t3code, commit 2fe7febc,
`packages/effect-acp`), MIT licence, Copyright (c) 2026 T3 Tools Inc.; the licence is in
[LICENSE](LICENSE). fuse-deck studio is an unofficial project and is not affiliated with, endorsed
by or maintained by T3 Tools Inc.

`src`, `test` and `scripts` are upstream's files, unchanged apart from these edits:

- `src/client.ts`: the default `clientInfo` names `fuse-deck-studio`.

They keep upstream's shape and formatting so they diff against t3code, so `.oxlintrc.json`,
`.oxlintrc.effect.json` and `.oxfmtrc.json` each carry one override for them, and
`tooling/typescript/effect.json` allows the one unstable API they read beyond the repository's list
(`effect/ErrorReporter#CurrentErrorReporters`). Bring an upstream change over as a whole-file copy
and record any local edit in the list above.

## Generated schema

`src/_generated` holds the v2 and v1 schemas and their method maps, generated from the schema files
the Agent Client Protocol project publishes with each release. Both lint passes skip it.
`pnpm --filter @elmeragroup/effect-acp generate` downloads the releases pinned in
`scripts/generate.ts` and writes it again.

## Tests

```sh
pnpm --filter @elmeragroup/effect-acp test
```

Upstream's suite: the protocol, the client and the agent over in-memory and spawned stdio, and the
mock peer in `test/fixtures/acp-mock-peer.ts`, an agent whose behavior `ACP_MOCK_*` variables set.
