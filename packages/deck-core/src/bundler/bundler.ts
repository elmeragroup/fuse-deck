/**
 * Vite behind the deck: the dev server, the static build, the slide compile and the theme check.
 * The bundler owns the whole Vite config: the deck directory is the root, the runtime comes from
 * the host's `runtimeRoot`, and Vite's logs go to stderr so stdout keeps the host's results.
 *
 * A deck is content, and opening one must not run its code in Node. Vite 8.3 would do that through
 * every file it discovers in the root and loads as code, so each one is closed in the config:
 * - `configFile: false`: no `vite.config.*`.
 * - `css.postcss` inline: no `postcss.config.*`, `.postcssrc*` or `package.json#postcss`, which
 *   Vite searches the root for when the server or the build starts, plugins named in them included.
 * - `plainCssPlugin`: no Sass, Less, Stylus or SugarSS compiler loads from the deck, for a module
 *   or through a CSS `@import`, and deck-core inlines the deck's own `@import`s, each a `.css`
 *   file inside the deck. Workers get it too, through `worker.plugins`.
 * - `envDir: false`: no `.env*` file reaches `import.meta.env`.
 * A deck is also self-contained, and holds no symbolic links (see `contained-file.ts`):
 * `containedResolutionPlugin` refuses an import that leads outside the deck, in dev, in the build
 * and in its workers; `containedServingPlugin` refuses a dev request through a link;
 * `build.assetsInlineLimit: 0` makes Vite emit every asset as a file, which the build checks by the
 * file it came from, instead of reading it into a data URL past every check; and the build copies
 * `public/` itself, through the same check, in place of Vite's copier, which follows links.
 * What Vite writes for itself, the optimizer cache, lives in the host's cache directory, never in
 * the deck.
 * The rest of what Vite reads from the root is data it never runs: `tsconfig.json` for the
 * transform, `package.json` fields for resolution, and the deck's own modules, which run only in
 * the page.
 */

import react from "@vitejs/plugin-react";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Console } from "node:console";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { build as viteBuild, createLogger, createServer } from "vite";
import type { InlineConfig, Logger, ServerOptions, ViteDevServer } from "vite";

import { deckEntry, describeRefusal } from "../deck/contained-file.ts";
import { DeckFiles } from "../deck/deck-files.ts";
import type { DeckIoFailed } from "../deck/deck-files.ts";
import type { DeckManifest, DeckManifestInvalid } from "../deck/deck-manifest.ts";
import type { SlideFrontmatterInvalid } from "../deck/slide-source.ts";
import { BUILD_MARKER, resolveBuildOutput } from "./build-output.ts";
import type { BuildOutputRefused } from "./build-output.ts";
import { containedResolutionPlugin } from "./contained-resolution.ts";
import { containedServingPlugin } from "./contained-serving.ts";
import { deckPlugins } from "./deck-plugin.ts";
import type { DeckManifestModule, Embedder } from "./deck-plugin.ts";
import { pollDeck } from "./deck-poll.ts";
import { firstPaint, loadFuseTheme } from "./fuse-theme.ts";
import type { FirstPaint, FuseThemeUnavailable, InvalidTheme } from "./fuse-theme.ts";
import { compileSlide } from "./mdx.ts";
import type { CompiledSlide, SlideCompileFailed, SlideMetadata } from "./mdx.ts";
import { optimizerCache } from "./optimizer-cache.ts";
import type { OptimizerCache } from "./optimizer-cache.ts";
import { plainCssPlugin } from "./plain-css.ts";
import { dependencyPackage, RESOLVE_ANCHOR, RESOLVE_ROOT } from "./resolve-root.ts";
import type { DependencyPackage } from "./resolve-root.ts";

/** Vite failed to start, build or serve the deck. */
export class BundlerFailed extends Schema.TaggedError<BundlerFailed>()("BundlerFailed", {
  message: Schema.String,
}) {}

/** A running dev server. */
export type DevServer = {
  /** The address the deck is served at. */
  readonly url: string;
  /**
   * The absolute path of each file the dev server's watcher sees added, changed or removed, for
   * as long as the stream runs. It is the watcher that drives live reload, not a second one.
   */
  readonly changes: Stream.Stream<string>;
};

/** How `dev` serves the deck. */
export type DevOptions =
  /**
   * Vite's own server, as `fuse-deck dev` runs it. Vite listens, and it ends the process on SIGTERM
   * or when stdin ends.
   */
  | {
      readonly _tag: "Standalone";
      /** The port to serve on. None takes Vite's default, 5173, or the next free one. */
      readonly port: Option.Option<number>;
    }
  /**
   * Vite in middleware mode on a listener the host owns, for the studio's preview. Vite installs no
   * process handlers, so the host alone decides when its process stops. The deck installs the
   * preview bridge, sends a framing policy for `embedder` and answers no cross-origin read.
   */
  | {
      readonly _tag: "Embedded";
      /** The page allowed to frame the deck. */
      readonly embedder: Embedder;
      /**
       * A server already listening on 127.0.0.1. The deck takes its requests and its HMR socket
       * until the scope closes; the host closes it after that.
       */
      readonly listener: HttpServer;
    };

/** Where the bundler finds the runtime and keeps what Vite generates. */
export type BundlerOptions = {
  readonly runtimeRoot: string;
  readonly cacheRoot: string;
};

/** What `dev` and `build` can fail with before Vite runs. */
export type DeckSiteError =
  | DeckManifestInvalid
  | DeckIoFailed
  | InvalidTheme
  | FuseThemeUnavailable
  | BundlerFailed;

/** Which JSX runtime a compile targets: `dev` serves the development one. */
type Mode = "development" | "production";

/** Serves, builds and compiles the deck. */
export class Bundler extends Context.Service<
  Bundler,
  {
    /** The first-paint attributes and bootstrap for a manifest the caller already loaded. */
    readonly firstPaint: (
      manifest: Pick<DeckManifest, "theme" | "density">
    ) => Effect.Effect<FirstPaint, InvalidTheme | FuseThemeUnavailable>;

    /** Compile one slide through the deck's MDX pipeline, as `build` does. */
    readonly compile: (
      id: string,
      text: string
    ) => Effect.Effect<CompiledSlide, SlideCompileFailed | SlideFrontmatterInvalid>;

    /** Serve the deck until the scope closes. */
    readonly dev: (options: DevOptions) => Effect.Effect<DevServer, DeckSiteError, Scope.Scope>;

    /** Build the deck into `out`, a directory inside the deck or outside it that the build owns. */
    readonly build: (
      out: string
    ) => Effect.Effect<{ readonly out: string }, DeckSiteError | BuildOutputRefused>;
  }
>()("@elmeragroup/deck-core/Bundler") {
  /**
   * The bundler for the deck `DeckFiles` found.
   *
   * @param options - `runtimeRoot`, the directory holding the built runtime, `main.js` and
   *   `deck.css`, which the host ships (the page loads both from it, and Vite may serve files inside
   *   it); and `cacheRoot`, a directory the host owns for what Vite generates, outside the deck.
   * @returns The layer.
   */
  static readonly layer = ({ runtimeRoot, cacheRoot }: BundlerOptions) =>
    Layer.effect(
      Bundler,
      Effect.gen(function* () {
        const deck = yield* DeckFiles;
        const fs = yield* FileSystem.FileSystem;
        const fuse = yield* Effect.cached(loadFuseTheme(RESOLVE_ROOT));
        const services = yield* Effect.context<DeckFiles>();
        const run = <A>(effect: Effect.Effect<A, HookError, DeckFiles>): Promise<A> =>
          Effect.runPromiseWith(services)(effect.pipe(Effect.mapError(toThrowable)));

        // Each slide compiles once per text: the manifest and Vite's transform both read the result.
        const compiled = new Map<string, { readonly text: string; readonly slide: CompiledSlide }>();
        const compileOnce = (file: string, text: string, mode: Mode) =>
          Effect.suspend(() => {
            const key = `${mode}:${file}`;
            const hit = compiled.get(key);
            return hit?.text === text
              ? Effect.succeed(hit.slide)
              : compileSlide(path.basename(file, ".mdx"), file, text, mode).pipe(
                  Effect.tap((slide) =>
                    Effect.sync(() => {
                      compiled.set(key, { text, slide });
                    })
                  )
                );
          });

        const deckFirstPaint = Effect.gen(function* () {
          const { manifest } = yield* deck.load;
          return yield* firstPaint(yield* fuse, manifest);
        });

        const dependencies = dependencyPackages();
        // The dev server's client, `/@vite/client`, is a file of Vite's own package.
        const viteRoot = Option.toArray(Option.map(dependencyPackage("vite"), ({ root }) => root));
        // The optimizer reads React, React DOM and Fuse, and the runtime imports them.
        const cacheDir = optimizerCache(cacheRoot, deck.root, {
          packages: dependencies,
          runtimeEntry: path.join(runtimeRoot, "main.js"),
          install: RESOLVE_ROOT,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));

        // The build bundles each worker with `worker.plugins` alone, so they hold their own copies.
        // The optimizer cache is trusted: Vite writes it, and the page imports React from it.
        const containmentPlugins = (cache: OptimizerCache) => () => [
          containedResolutionPlugin({
            deckRoot: deck.root,
            trustedRoots: [
              runtimeRoot,
              ...dependencies.map(({ root }) => root),
              ...viteRoot,
              cache.directory,
            ],
          }),
          plainCssPlugin({
            deckRoot: deck.root,
            trustedRoots: [runtimeRoot, ...dependencies.map(({ root }) => root)],
          }),
        ];

        const config = (
          mode: Mode,
          cache: OptimizerCache,
          embedder: Option.Option<Embedder>
        ): InlineConfig => ({
          root: deck.root,
          configFile: false,
          envDir: false,
          // Inline, so Vite searches the deck for no PostCSS config. The deck's CSS needs no plugin.
          css: { postcss: {} },
          mode,
          base: "./",
          cacheDir: cache.directory,
          // Without a lockfile the directory's name cannot follow a dependency of React, React DOM or
          // Fuse, so each start optimizes afresh.
          optimizeDeps: { force: Option.isNone(cache.lockfile) },
          customLogger: stderrLogger(mode),
          appType: "spa",
          worker: { plugins: containmentPlugins(cache) },
          // Every asset ships as a file: an inlined one would be read past the checks.
          build: { assetsInlineLimit: 0 },
          plugins: [
            containedServingPlugin(deck.root),
            ...containmentPlugins(cache)(),
            deckPlugins({
              root: deck.root,
              runtimeRoot,
              resolveAnchor: RESOLVE_ANCHOR,
              embedder,
              title: () => run(Effect.map(deck.load, (loaded) => loaded.manifest.title)),
              firstPaint: () => run(deckFirstPaint),
              manifestModule: () => run(manifestModule(mode, compileOnce, embedder)),
              compileSlide: (file, text) =>
                run(
                  Effect.map(compileOnce(file, text, mode), (slide) => ({
                    code: slide.code,
                    entry: manifestEntry(slide.metadata),
                  }))
                ),
            }),
            react({ include: /\.(?:mdx|[jt]sx?)$/ }),
          ],
          server: {
            // Loopback only, on IPv4 by its literal address: the deck is a local preview, and the
            // studio frames it under a `frame-src http://127.0.0.1:*` policy.
            host: "127.0.0.1",
            fs: {
              allow: [deck.root, runtimeRoot, ...dependencies.map(({ root }) => root), cache.directory],
            },
            // No chokidar: `dev` polls the deck itself and reports each file on `server.watcher`,
            // which drives live reload as chokidar's events would. See `deck-poll.ts`.
            watch: null,
          },
        });

        return Bundler.of({
          firstPaint: (manifest) => Effect.flatMap(fuse, (theme) => firstPaint(theme, manifest)),
          compile: (id, text) => compileOnce(path.join(deck.root, "slides", `${id}.mdx`), text, "production"),
          dev: Effect.fn("Bundler.dev")(function* (options) {
            yield* deckFirstPaint;
            const cache = yield* cacheDir;
            const embedder = options._tag === "Embedded" ? Option.some(options.embedder) : Option.none();
            const devConfig = config("development", cache, embedder);
            // The finalizer holds the server from its creation, so a failed `listen` still closes
            // the watcher and the optimizer that `createServer` started.
            const server = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () =>
                  createServer({
                    ...devConfig,
                    server: { ...devConfig.server, ...serverOptions(options) },
                  }),
                catch: bundlerFailed("create the dev server"),
              }),
              // With Vite 8.3, `close` did not settle when SIGINT followed the page's first module
              // request (with NODE_ENV=test, every time), so the release stops waiting after 3 s.
              // This matches vitejs/vite#22934: the optimizer leaves a discovered dependency's
              // processing promise unsettled on close. Its fix, vitejs/vite#23567, came after 8.3.0.
              (created) =>
                Effect.promise(() => created.close()).pipe(Effect.timeout(VITE_CLOSE_TIMEOUT), Effect.ignore)
            );
            // Vite's watcher is a no-op emitter here; the poll feeds it. It runs before the server
            // listens, and its finalizer runs before the server closes.
            yield* pollDeck(deck.root, (event, file) => {
              server.watcher.emit(event, file);
            }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
            const url =
              options._tag === "Standalone"
                ? yield* listen(server)
                : yield* serveOn(server, options.listener);
            const changes = Stream.callback<string>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const emit = (file: string) => {
                    Queue.offerUnsafe(queue, file);
                  };
                  for (const event of WATCH_EVENTS) {
                    server.watcher.on(event, emit);
                  }
                  return emit;
                }),
                (emit) =>
                  Effect.sync(() => {
                    for (const event of WATCH_EVENTS) {
                      server.watcher.off(event, emit);
                    }
                  })
              )
            );
            return { url, changes };
          }),
          build: Effect.fn("Bundler.build")(function* (out) {
            yield* deckFirstPaint;
            const cache = yield* cacheDir;
            const output = yield* resolveBuildOutput(deck.root, out).pipe(
              Effect.provideService(FileSystem.FileSystem, fs)
            );
            const production = config("production", cache, Option.none());
            yield* Effect.tryPromise({
              try: () =>
                viteBuild({
                  ...production,
                  // Rolldown's build reporter writes its progress straight to stdout, past the
                  // custom logger, and stdout carries the CLI's result. Below info it stays quiet;
                  // warnings and errors still reach stderr.
                  logLevel: "warn",
                  // `copyPublicDir: false`: `copyPublic` below copies `public/` through the checks.
                  build: {
                    ...production.build,
                    outDir: output.directory,
                    emptyOutDir: true,
                    copyPublicDir: false,
                  },
                }),
              catch: bundlerFailed("build the deck"),
            });
            yield* copyPublic(fs, deck.root, output.directory);
            const marker = path.join(output.directory, BUILD_MARKER);
            yield* fs
              .writeFileString(
                marker,
                "fuse-deck build wrote this directory and empties it on the next build.\n"
              )
              .pipe(
                Effect.mapError(
                  (error) => new BundlerFailed({ message: `Could not write ${marker}: ${error.message}` })
                )
              );
            return { out: output.directory };
          }),
        });
      })
    );
}

/**
 * Copy the deck's `public/` into the build's output, as Vite's copier would, through the deck-path
 * check: a link or special file in it fails the build, and nothing is read through one. A file the
 * build already wrote keeps the build's version, as with Vite.
 */
const copyPublic = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, root: string, out: string) {
  const failed = (message: string) => new BundlerFailed({ message });
  const copy = (relative: string): Effect.Effect<void, BundlerFailed> =>
    Effect.gen(function* () {
      const source = path.join(root, "public", relative);
      const entry = yield* deckEntry(fs, root, source, ["File", "Directory"]).pipe(
        Effect.mapError((error) => failed(`Could not read ${source}: ${error.message}`))
      );
      if (entry._tag === "Missing") {
        return;
      }
      if (entry._tag !== "DeckEntry") {
        return yield* failed(`The build copies public/ as it is: ${describeRefusal(entry)}`);
      }
      const target = path.join(out, relative);
      if (entry.kind === "File") {
        if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) {
          yield* fs
            .copyFile(entry.real, target)
            .pipe(Effect.mapError((error) => failed(`Could not copy ${source}: ${error.message}`)));
        }
        return;
      }
      yield* fs
        .makeDirectory(target, { recursive: true })
        .pipe(Effect.mapError((error) => failed(`Could not make ${target}: ${error.message}`)));
      const names = yield* fs
        .readDirectory(entry.real)
        .pipe(Effect.mapError((error) => failed(`Could not read ${source}: ${error.message}`)));
      for (const name of [...names].sort()) {
        yield* copy(path.join(relative, name));
      }
    });
  yield* copy("");
});

/** The watcher events `DevServer.changes` reports. */
const WATCH_EVENTS = ["add", "change", "unlink"] as const;

/** How long the dev server's release waits for Vite's `close`. */
export const VITE_CLOSE_TIMEOUT = Duration.seconds(3);

/** Vite's server options for each way `dev` serves. */
function serverOptions(options: DevOptions): ServerOptions {
  switch (options._tag) {
    case "Standalone":
      return Option.match(options.port, {
        onNone: () => ({}),
        onSome: (port) => ({ port, strictPort: true }),
      });
    case "Embedded":
      return {
        middlewareMode: true,
        // The HMR socket shares the host's listener, so the page reaches it at its own origin.
        ws: { server: options.listener },
        // Vite answers cross-origin reads from any localhost page by default. A framed deck needs
        // none: the studio talks to it only through the preview bridge.
        cors: false,
      };
  }
}

/** Start Vite's own listener and return its address. */
const listen = Effect.fnUntraced(function* (server: ViteDevServer) {
  yield* Effect.tryPromise({
    try: () => server.listen(),
    catch: bundlerFailed("start the dev server"),
  });
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) {
    return yield* new BundlerFailed({ message: "The dev server started without a local address." });
  }
  return url;
});

/** A listening TCP server's address; a pipe's path or a server not listening has none. */
const decodeTcpAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Int }));

/** Hand the host's listener's requests to Vite until the scope closes, and return its address. */
const serveOn = Effect.fnUntraced(function* (server: ViteDevServer, listener: HttpServer) {
  const address = decodeTcpAddress(listener.address());
  if (Option.isNone(address)) {
    return yield* new BundlerFailed({ message: "The host's listener is not listening on a TCP port." });
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      listener.on("request", server.middlewares);
    }),
    () =>
      Effect.sync(() => {
        listener.off("request", server.middlewares);
      })
  );
  return `http://127.0.0.1:${String(address.value.port)}/`;
});

/** What the manifest emits for a slide besides its id and import, as one comparable string. */
function manifestEntry(metadata: SlideMetadata): string {
  return `title: ${JSON.stringify(Option.getOrNull(metadata.title))}, layout: ${JSON.stringify(metadata.layout)}, steps: ${String(metadata.steps)}`;
}

/**
 * The manifest module: the deck's settings and, per slide, its title, layout, step count and an
 * `import()` of its file. It fails on a dangling id or a slide that does not compile, which Vite
 * shows.
 */
function manifestModule(
  mode: Mode,
  compile: (
    file: string,
    text: string,
    mode: Mode
  ) => Effect.Effect<CompiledSlide, SlideCompileFailed | SlideFrontmatterInvalid>,
  embedder: Option.Option<Embedder>
) {
  return Effect.gen(function* () {
    const deck = yield* DeckFiles;
    const loaded = yield* deck.load;
    const slides: Array<{ readonly id: string; readonly entry: string }> = [];
    const entries = new Map<string, string>();
    for (const { id, file } of loaded.slides) {
      const compiled = yield* compile(file, yield* deck.readSlide(id), mode);
      const entry = manifestEntry(compiled.metadata);
      entries.set(file, entry);
      slides.push({ id, entry });
    }
    return {
      source: manifestSource(loaded.manifest, slides, embedder),
      slides: entries,
    } satisfies DeckManifestModule;
  });
}

/** The manifest module's source, from the deck's settings and each slide's entry. */
function manifestSource(
  manifest: { readonly title: string; readonly aspect: string },
  slides: ReadonlyArray<{ readonly id: string; readonly entry: string }>,
  embedder: Option.Option<Embedder>
): string {
  const items = slides.map(
    ({ id, entry }) =>
      `{ id: ${JSON.stringify(id)}, ${entry}, load: () => import(${JSON.stringify(`/slides/${id}.mdx`)}) }`
  );
  return `export default {
  title: ${JSON.stringify(manifest.title)},
  aspect: ${JSON.stringify(manifest.aspect)},
  embedder: ${JSON.stringify(Option.getOrNull(embedder))},
  slides: [
    ${items.join(",\n    ")}
  ],
};
`;
}

/** What a Vite hook's effect can fail with. */
type HookError =
  | DeckManifestInvalid
  | DeckIoFailed
  | InvalidTheme
  | FuseThemeUnavailable
  | SlideFrontmatterInvalid
  | SlideCompileFailed;

/** Vite's hooks are promise-based; a typed failure crosses them as an `Error` with its message and hint. */
function toThrowable(error: HookError): Error {
  return new Error("hint" in error ? `${error.message}\n${error.hint}` : error.message);
}

function bundlerFailed(operation: string) {
  return (cause: unknown) =>
    new BundlerFailed({
      message: `Vite could not ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
}

/**
 * React, React DOM and Fuse, wherever the install put them. With the deck and the runtime
 * directory, their directories are all Vite may serve; the dependencies they import reach the page
 * through the optimizer's cache.
 */
function dependencyPackages(): DependencyPackage[] {
  return ["react", "react-dom", "@elmeragroup/fuse"].flatMap((name) =>
    Option.toArray(dependencyPackage(name))
  );
}

/**
 * Vite's own logger with both streams on stderr, so stdout carries only the CLI's results. `dev`
 * logs from info up; `build` logs warnings and errors.
 */
function stderrLogger(mode: Mode): Logger {
  return createLogger(mode === "development" ? "info" : "warn", {
    allowClearScreen: false,
    console: new Console(process.stderr, process.stderr),
  });
}
