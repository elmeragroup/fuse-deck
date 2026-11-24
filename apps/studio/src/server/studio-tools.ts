/**
 * The studio's MCP server at `/mcp`: deck-core's six deck tools with the view tools, `view_current`
 * and `view_go`. Only an agent session's relay reaches it, with that session's token; `http-app.ts`
 * checks the request and names its caller before any of this runs.
 *
 * Every tool call runs as admitted work on the deck scope its caller's session opened, through
 * `DeckScopes.admit`, so a closing deck refuses it and its drain waits for it. It also runs as a tool
 * call of the caller's chat, which Stop interrupts. The caller comes from the request's token alone,
 * never from the MCP session id.
 */

import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Bundler } from "@elmeragroup/deck-core/bundler/bundler";
import { DeckFiles, DeckIoFailed } from "@elmeragroup/deck-core/deck/deck-files";
import { DeckManifestInvalid, requireSlide, SlideNotInDeck } from "@elmeragroup/deck-core/deck/deck-manifest";
import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";
import { DeckTools, deckToolHandlers } from "@elmeragroup/deck-core/tools/deck-tools";

import { MCP_PATH } from "../contract/studio-launch.ts";
import { DeckScopes } from "./deck-scopes.ts";
import type { AdmittedCall } from "./deck-scopes.ts";
import { PreviewNotShown } from "./deck-view.ts";
import type { DeckView } from "./deck-view.ts";
import type { McpCaller } from "./mcp-tokens.ts";

/** The agent session a `/mcp` request comes from, which `http-app.ts` resolves from its token. */
export class CurrentCaller extends Context.Service<CurrentCaller, McpCaller>()(
  "@elmeragroup/fuse-deck-studio/server/CurrentCaller"
) {}

/** The view of the deck a tool call reaches. */
class CurrentView extends Context.Service<CurrentView, DeckView>()(
  "@elmeragroup/fuse-deck-studio/server/CurrentView"
) {}

/** A `/mcp` call the studio refused: its deck is closing or gone, or its session ended or stopped. */
class DeckUnavailable extends Schema.Error<DeckUnavailable>("@elmeragroup/fuse-deck-studio/DeckUnavailable")({
  ...McpSchema.McpErrorBase.fields,
  _tag: Schema.tag("DeckUnavailable"),
  // The JSON-RPC range for implementation-defined server errors.
  code: Schema.tag(-32001),
}) {}

/** A position the preview committed, as the view tools return it. */
const ViewPositionDocument = Schema.TaggedStruct("ViewPosition", {
  slideId: SlideId,
  step: Schema.Finite,
});

const ViewToolFailure = Schema.Union([PreviewNotShown, SlideNotInDeck, DeckManifestInvalid, DeckIoFailed]);

const ViewCurrent = Tool.make("view_current", {
  description:
    "Get the slide and step the studio's preview shows now, as the user sees it. Call it when the user refers to 'this slide' or 'here'. Returns a ViewPosition document with the slide id and how many of its steps are revealed.",
  success: ViewPositionDocument,
  failure: ViewToolFailure,
  failureMode: "return",
  dependencies: [CurrentView],
})
  .annotate(Tool.Title, "Read the preview's position")
  .annotate(Tool.Readonly, true);

const ViewGo = Tool.make("view_go", {
  description:
    "Show a slide in the studio's preview, at a step, so the user sees what you changed or point at. The slide must be in the deck's order. Returns a ViewPosition document with the position the preview committed; a step past the slide's last shows its last.",
  parameters: Schema.Struct({
    id: SlideId.annotate({ description: "The slide to show." }),
    step: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "How many of the slide's steps to reveal. Default: 0.",
      })
    ),
  }),
  success: ViewPositionDocument,
  failure: ViewToolFailure,
  failureMode: "return",
  dependencies: [CurrentView, DeckFiles],
})
  .annotate(Tool.Title, "Show a slide in the preview")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/** The view tools, which only the studio serves. */
const ViewTools = Toolkit.make(ViewCurrent, ViewGo);

const viewToolHandlers = ViewTools.toLayer({
  view_current: Effect.fnUntraced(function* () {
    const view = yield* CurrentView;
    const position = yield* view.current;
    if (Option.isNone(position)) {
      return yield* new PreviewNotShown({
        message: "The preview has not reported a position yet.",
        hint: "Open the deck's Preview tab in the studio, then call view_current again.",
      });
    }
    return ViewPositionDocument.make(position.value);
  }),
  view_go: Effect.fnUntraced(function* ({ id, step }) {
    const view = yield* CurrentView;
    const files = yield* DeckFiles;
    const { manifest } = yield* files.load;
    yield* Effect.fromResult(requireSlide(manifest, id));
    return ViewPositionDocument.make(yield* view.go(id, step ?? 0));
  }),
});

/** The tools that only read the deck or the view; every other one is admitted as a write. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "describe",
  "slides_list",
  "check",
  "view_current",
  "view_go",
]);

/**
 * MCP middleware that runs each tool call on the deck its caller's session opened: admitted on that
 * deck scope, run as a tool call of its chat, with the scope's files, bundler and view.
 */
const sessionDeck = McpServer.middleware<{ provides: DeckFiles | Bundler | CurrentView }>()(
  Effect.gen(function* () {
    const scopes = yield* DeckScopes;
    return (effect, { target }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller;
        const call: AdmittedCall = READ_TOOLS.has(target) ? "Read" : "Write";
        return yield* scopes.admit(caller.scopeId, call, (deck) =>
          deck.agent.toolCall(
            caller.sessionKey,
            effect.pipe(
              Effect.provideService(DeckFiles, deck.files),
              Effect.provideService(Bundler, deck.bundler),
              Effect.provideService(CurrentView, deck.view)
            )
          )
        );
      }).pipe(
        Effect.catchTags({
          StaleScope: (error) => Effect.fail(new DeckUnavailable({ message: error.message })),
          ToolCallRefused: (error) => Effect.fail(new DeckUnavailable({ message: error.message })),
        })
      );
  })
);

/**
 * The `/mcp` endpoint, Streamable HTTP, serving the revisions the relay's agent may offer.
 *
 * @param skill - The absolute path of the skill the backend ships, which `describe` names.
 * @returns A layer that adds `/mcp` to the router.
 */
export function studioMcpLayer(skill: string) {
  const registrations = Layer.mergeAll(
    McpServer.toolkit(DeckTools).pipe(Layer.provide(deckToolHandlers(skill))),
    McpServer.toolkit(ViewTools).pipe(Layer.provide(viewToolHandlers))
  ).pipe(Layer.provide(sessionDeck.layer));
  return McpServer.layerHttp({
    name: "fuse-deck-studio",
    version: "0.0.0",
    instructions:
      "These tools edit the deck open in the fuse-deck studio and move its preview. Call describe first, then slides_add for each slide and write its content in slides/<id>.mdx. Run check after each round of edits, and view_go to show the user a slide.",
    path: MCP_PATH,
    // So a revoked token's transport sessions can be ended (see `studio-server.ts`).
    allowSessionTermination: true,
    protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
    registrations,
  });
}
