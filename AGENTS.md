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

`packages/deck-core` holds the deck model, the bundler and the browser runtime. It is private and
never published: fuse-deck's build inlines it, so a runtime dependency it adds goes into
fuse-deck's `dependencies` too, or the build fails. deck-core takes the runtime directory and the
skill path from its host and resolves React, React DOM, Fuse and Vite's anchors from the running
module.

A deck is untrusted, self-contained input. Nothing in it runs in Node, nothing outside its directory
is read, served or written for it, and it holds no symbolic links. Every path a host or the bundler
reads, writes, lists, serves or copies goes through the one guard in
`packages/deck-core/src/deck/contained-file.ts` (`deckEntry`, `deckEntrySync`); opening a deck
refuses a link with `DeckEntryRefused`. Decks style slides with plain CSS: no Sass, Less, Stylus
or CSS Modules. What Vite generates lives in storage the host owns (`Bundler.layer`'s
`cacheRoot`), never in the deck.

The browser runtime in `packages/deck-core/src/runtime` is plain React 19 with no Effect and no
Node API. Slide motion uses React's `<ViewTransition>`; keep it to the slide change, `<Step>` and
`<Morph>`, and keep the reduced-motion fallbacks in `deck.css`.

Fuse is a published dependency. Use it through its public subpaths only. When a slide shows a Fuse
bug or a missing theme role, fix it in Fuse and bump the catalog pin here.

## Command line

Agents drive fuse-deck through its commands, so command and flag names, JSON fields, error codes
and exit codes are public behavior. A change to any of them updates `--help`, `skill/SKILL.md` and
the tests together.

## Tests

Assert behavior against independently defined expectations. Never compute an expected result with
the code under test. A test that flakes is made deterministic or deleted in the same change. Put
each test in the cheapest project that can fail: `unit` for the deck model (in deck-core), the spawned CLI
and the studio backend (in-process services and the spawned backend), `browser` for a built deck or
the built studio renderer in Chromium, the packed smoke test for the installed tarball, and
`test:packaged` in `apps/desktop` for the packaged desktop app.

## Studio

`apps/studio` is the studio's backend and renderer, `apps/desktop` its Electron shell. The backend
admits a renderer by exact Origin plus a bearer-for-ticket exchange; keep CORS to the renderer's
origin, never `*`, and set no cookie. Every call about an open deck carries its scope id and is
refused before it runs when the scope is closing or gone. The renderer and the shared contract in
`apps/studio/src/contract` import no Node API.

While editing, run `pnpm exec vitest related <files> --run --project unit` in the package. Before
review, run `pnpm check`; CI adds the browser suite, the packed smoke test and, on macOS, the
packaged desktop app's smoke test.

Track open work as GitHub issues, never in a backlog file.
