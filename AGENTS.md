# Working on fuse-deck

fuse-deck builds slide decks from MDX with Fuse components. Read [CONTRIBUTING.md](CONTRIBUTING.md)
before opening a PR, and write the PR body from
[the PR template](.github/pull_request_template.md).

## Code

Write TypeScript under the `coding-standards` skill. Node code (the CLI, the bundler and
`scripts/`) is idiomatic Effect: `effect/cli` commands, `Effect.fn` operations, `Context.Service`
services with their layers, and `Schema.TaggedError` failures. `pnpm lint:effect` runs the
`@effect/tsgo` rules that `tooling/typescript/effect.json` decides; `.oxlintrc.effect.json` lists
every rule that file sets to error, so change both together. A directive that turns a rule off
carries a `-- reason`.

The browser runtime in `src/runtime` is plain React 19 with no Effect and no Node API. Slide motion
uses React's `<ViewTransition>`; keep it to the slide change, `<Step>` and `<Morph>`, and keep the
reduced-motion fallbacks in `deck.css`.

Fuse is a published dependency. Use it through its public subpaths only. When a slide shows a Fuse
bug or a missing theme role, fix it in Fuse and bump the catalog pin here.

## Command line

Agents drive fuse-deck through its commands, so command and flag names, JSON fields, error codes
and exit codes are public behavior. A change to any of them updates `--help`, `skill/SKILL.md` and
the tests together.

## Tests

Assert behavior against independently defined expectations. Never compute an expected result with
the code under test. A test that flakes is made deterministic or deleted in the same change. Put
each test in the cheapest project that can fail: `unit` for the deck model and the spawned CLI,
`browser` for a built deck in Chromium, and the packed smoke test for the installed tarball.

While editing, run `pnpm exec vitest related <files> --run --project unit` in the package. Before
review, run `pnpm check`; CI adds the browser suite and the packed smoke test.

Track open work as GitHub issues, never in a backlog file.
