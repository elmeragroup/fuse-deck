# @elmeragroup/fuse-deck

Builds slide decks from MDX, themed with Fuse. A deck is a directory with a `deck.json` and one
`slides/<id>.mdx` per slide. The `fuse-deck` command scaffolds a deck, keeps its order and files in
step, and checks it. Its output is written for agents first: `--json` prints exactly one JSON
document per run.

The package is private and packable, and is not yet published to npm.

## Use

```sh
fuse-deck create talk --brief "What the talk is for"
cd talk
fuse-deck describe          # the layouts, components, frontmatter, settings and commands
fuse-deck slides add intro --title "Why Fuse"
fuse-deck check             # compiles every slide and validates the theme against Fuse
fuse-deck dev               # serves the deck with live reload
fuse-deck build             # writes the static deck to dist/
```

A slide change is a React view transition: the old slide blurs out and the new one blurs in.
`<Step>` reveals content one key press at a time, and `<Morph name>` moves one element to its partner on the next slide. Arrow keys, Space, Page Up/Down, Home and End
navigate; the URL hash names the slide and step, so links and Back work.

A deck is untrusted input and self-contained. Nothing in it runs in Node, it reads nothing outside
its directory, and it holds no symbolic links: a command on a deck that holds one fails with
`DeckEntryRefused`, naming the link. Slides style with Fuse and plain `.css` files; Sass, Less,
Stylus and CSS Modules do not load. Vite's cache goes to the user cache directory
(`$XDG_CACHE_HOME/fuse-deck`, `~/Library/Caches/fuse-deck` on macOS), never into the deck.

From this checkout, `pnpm exec node packages/fuse-deck/src/bin.ts <command>` runs the CLI from
source through Node's type stripping. It serves the built runtime in `dist/runtime`, so run
`pnpm build` first.
`skill/SKILL.md` ships in the package for agents, and `describe` prints its path.

The package exports no modules (`"exports": {}`). The bin and Vite reach `dist/` by file path, so a
deep import such as `@elmeragroup/fuse-deck/dist/runtime/main.js` fails.

## Exit codes

| Code | Means                                                  |
| ---- | ------------------------------------------------------ |
| 0    | The command did what it says.                          |
| 1    | A domain failure, such as a broken deck or a bad edit. |
| 2    | The command line did not parse.                        |

## How it builds

The deck model, the bundler and the browser runtime live in the private
[`packages/deck-core`](../deck-core), which is never published. tsdown inlines it into
`dist/bin.mjs` and copies its built runtime to `dist/runtime/`, so the tarball needs nothing from
the workspace. The build fails when deck-core imports a package this one does not list in
`dependencies`.

Node never imports Fuse. The bundler resolves `@elmeragroup/fuse/theme` from `dist/bin.mjs` and
loads it with Vite's `runnerImport`, rooted at `dist/`, for the first-paint attributes, the
color-scheme bootstrap and the theme check. React, React DOM and Fuse resolve from the same file.
The bundler owns the whole Vite config: the deck directory is the root, no `vite.config` loads, the
HTML shell comes from the bundler and the runtime from `dist/runtime/`. The runtime keeps React,
Fuse and the deck manifest external. Every asset ships as a file, never inlined, and the build copies
`public/` itself, so each file the build reads from the deck passes the same check.

## Tests

Run the suites from the repository root, which builds this package first:

```sh
pnpm test                  # unit and process tests
pnpm test:browser          # a built deck driven in Chromium
pnpm test:packed-consumer  # the packed tarball installed with npm outside the workspace
```

The process tests spawn `dist/bin.mjs`, the file the packed tarball ships, and the browser suite
drives a deck that bin built. A direct `vitest` run uses whatever `dist/` holds, so rebuild after
each change.
