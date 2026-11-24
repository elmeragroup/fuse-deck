# fuse-deck

fuse-deck builds slide decks from MDX, themed with [Fuse](https://github.com/elmeragroup/fuse). A
deck is a directory with a `deck.json` and one `slides/<id>.mdx` per slide. The `fuse-deck` command
scaffolds a deck, adds and orders its slides, checks it, serves it with live reload and builds it to
static files. Agents drive it: every command takes `--json` and prints exactly one JSON document.

fuse-deck is in development and not yet published to npm.

| Path                 | What it is                                                                 |
| -------------------- | -------------------------------------------------------------------------- |
| `packages/fuse-deck` | The `fuse-deck` command and the shipped skill                              |
| `packages/deck-core` | The deck model, the Vite bundler and the browser runtime; private, inlined |
| `tooling/typescript` | The shared tsconfig base and the Effect language-service preset            |

## Develop

The workspace pins Node 26.13 and pnpm 11 in `package.json`; pnpm installs that Node itself.

```sh
pnpm install
pnpm build                 # the CLI and the browser runtime
pnpm check                 # format, lint, type-check and the unit tests
pnpm test:browser          # a built deck and the studio renderer driven in Chromium
pnpm test:packed-consumer  # the packed tarball installed with npm outside the workspace
```

Then run the CLI from source with `pnpm exec node packages/fuse-deck/src/bin.ts <command>`. The
[package README](packages/fuse-deck/README.md) describes the commands, the deck format and how a
deck builds. The studio, a desktop app for previewing and editing a deck, lives in
[apps/studio](apps/studio/README.md) and [apps/desktop](apps/desktop/README.md).

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)
