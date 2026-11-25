/**
 * What a permission card says about an MCP tool call: a sentence for the deck tools the studio
 * serves, and the call's arguments for any tool. Claude Code names a tool of an MCP server
 * `mcp__<server>__<tool>` and asks for it with that name as the title, so a card would show only the
 * name otherwise.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The prefix Claude Code gives the studio's deck tools: `MCP_SERVER_NAME` in `agent-chats.ts`. */
const DECK_TOOL_PREFIX = "mcp__fuse-deck__";

/** The deck tools' arguments a sentence names, each optional. */
const DeckToolArguments = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  layout: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  step: Schema.optionalKey(Schema.Finite),
});

const decodeArguments = Schema.decodeUnknownOption(DeckToolArguments);
const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

/**
 * A tool call's arguments as they came off the wire, read as JSON: the boundary where the card's
 * helpers take them.
 *
 * @param rawInput - The request's `toolCall.rawInput`.
 * @returns The JSON value, or none when there is none.
 */
export const decodeToolInput = Schema.decodeUnknownOption(Schema.Json);

/** A slide id as the sentence shows it, in backticks, which the card renders as code. */
const code = (text: string) => `\`${text}\``;

/** Where a new or moved slide goes, from its `after` or `before` anchor. */
function place(args: typeof DeckToolArguments.Type, end: string): string {
  if (args.after !== undefined) {
    return ` after ${code(args.after)}`;
  }
  return args.before === undefined ? end : ` before ${code(args.before)}`;
}

/**
 * The sentence for a call of one of the studio's deck tools, or none for any other tool or for
 * arguments the sentence cannot read.
 *
 * @param tool - The tool's name as Claude Code gives it.
 * @param input - The call's arguments.
 * @returns The sentence, with each slide id in backticks.
 */
export function deckToolSummary(tool: string, input: Schema.Json): Option.Option<string> {
  if (!tool.startsWith(DECK_TOOL_PREFIX)) {
    return Option.none();
  }
  const name = tool.slice(DECK_TOOL_PREFIX.length);
  return Option.flatMap(decodeArguments(input), (args): Option.Option<string> => {
    const id = args.id;
    switch (name) {
      case "describe":
        return Option.some("Read what a deck can hold");
      case "slides_list":
        return Option.some("List the slides");
      case "check":
        return Option.some("Check the deck");
      case "view_current":
        return Option.some("Read which slide the preview shows");
      case "slides_add":
        return id === undefined
          ? Option.none()
          : Option.some(
              `Add slide ${code(id)}${place(args, " at the end")}${args.title === undefined ? "" : `, titled “${args.title}”`}${args.layout === undefined ? "" : `, with the ${args.layout} layout`}`
            );
      case "slides_move":
        return id === undefined ? Option.none() : Option.some(`Move slide ${code(id)}${place(args, "")}`);
      case "slides_remove":
        return id === undefined ? Option.none() : Option.some(`Remove slide ${code(id)}`);
      case "view_go":
        return id === undefined
          ? Option.none()
          : Option.some(
              `Show slide ${code(id)} in the preview${args.step === undefined ? "" : `, at step ${String(args.step)}`}`
            );
      default:
        return Option.none();
    }
  });
}

/**
 * A tool call's arguments as indented JSON, or none when it has none to show.
 *
 * @param input - The call's arguments.
 * @returns The JSON text.
 */
export function toolArguments(input: Schema.Json): Option.Option<string> {
  if (input === null || Option.exists(decodeObject(input), (object) => Object.keys(object).length === 0)) {
    return Option.none();
  }
  // The arguments came off the wire as JSON, so they encode back to it.
  return Option.some(JSON.stringify(input, null, 2));
}
