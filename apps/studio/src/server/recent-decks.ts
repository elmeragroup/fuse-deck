/**
 * The decks the studio opened, newest first, kept in `recent-decks.json` in the app's user data
 * directory. A file that is missing or does not decode reads as no decks, so a damaged settings
 * file never stops the studio; the next open writes a good one.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { RecentDeck } from "../contract/studio-rpc.ts";

/** How many decks the list keeps. */
export const RECENT_DECKS_LIMIT = 8;

/** The settings file's name in the user data directory. */
export const RECENT_DECKS_FILE = "recent-decks.json";

const RecentDecksFile = Schema.fromJsonString(Schema.Struct({ decks: Schema.Array(RecentDeck) }));
const decodeFile = Schema.decodeUnknownOption(RecentDecksFile);
const encodeFile = Schema.encodeEffect(RecentDecksFile);

/** Reads and records the decks the studio opened. */
export class RecentDecks extends Context.Service<
  RecentDecks,
  {
    /** The recent decks, newest first. */
    readonly list: Effect.Effect<ReadonlyArray<RecentDeck>>;
    /** Put a deck first, dropping an older entry for the same directory and any past the limit. */
    readonly record: (deck: RecentDeck) => Effect.Effect<void>;
  }
>()("@elmeragroup/fuse-deck-studio/server/RecentDecks") {
  /**
   * The recent decks kept in `directory`.
   *
   * @param directory - The app's user data directory.
   */
  static readonly layer = (directory: string) =>
    Layer.effect(
      RecentDecks,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = path.join(directory, RECENT_DECKS_FILE);
        const writes = yield* Semaphore.make(1);

        const list = fs.readFileString(file).pipe(
          Effect.map((text) =>
            Option.match(decodeFile(text), { onNone: () => [], onSome: ({ decks }) => decks })
          ),
          Effect.orElseSucceed((): ReadonlyArray<RecentDeck> => [])
        );

        const record = (deck: RecentDeck) => {
          // Written beside the file and renamed over it, so a crash never leaves half a file.
          const temporary = `${file}.${randomUUID()}.tmp`;
          return writes.withPermits(1)(
            Effect.gen(function* () {
              const previous = yield* list;
              const decks = [deck, ...previous.filter(({ root }) => root !== deck.root)].slice(
                0,
                RECENT_DECKS_LIMIT
              );
              yield* fs.makeDirectory(directory, { recursive: true });
              yield* fs.writeFileString(temporary, yield* encodeFile({ decks }));
              yield* fs.rename(temporary, file);
            }).pipe(
              // A list that cannot be saved costs the user a shortcut, not the open deck.
              Effect.catch((error) => Effect.logWarning(`Could not save the recent decks: ${error.message}`))
            )
          );
        };

        return RecentDecks.of({ list, record });
      })
    );
}
