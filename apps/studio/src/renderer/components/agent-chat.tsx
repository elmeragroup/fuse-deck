/**
 * The agent chat: the message list, tool calls and permission cards, and the composer. The
 * backend holds the chat, so this view only renders the state it streams and sends the user's
 * prompts, Stop and decisions back. Fuse has no message list, composer or tool-call card yet, so
 * these compose Fuse's Card, Badge, Button and Textarea.
 *
 * Agent text renders through `@pierre/words`, which drops raw HTML and unsafe link schemes; the
 * URL filter here also drops every image, so a reply cannot make the studio fetch a remote image.
 */

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { defaultUrlTransform, Markdown } from "@pierre/words/react";
import "@pierre/words/styles.css";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SlideId } from "@elmeragroup/deck-core/deck/slide-id";
import { Alert } from "@elmeragroup/fuse/alert";
import { Badge } from "@elmeragroup/fuse/badge";
import { Button } from "@elmeragroup/fuse/button";
import { Card } from "@elmeragroup/fuse/card";
import { Textarea } from "@elmeragroup/fuse/textarea";

import type { ChatEntry, ChatState, PermissionChoice, ViewContext } from "../../contract/agent-chat.ts";
import type { OpenDeck } from "../../contract/studio-rpc.ts";
import type { PreviewPosition } from "../state/studio-client.ts";
import { useStudio } from "../state/use-studio.ts";
import { FileChangeView, PatchView } from "./diff-view.tsx";
import { RenderBoundary } from "./render-boundary.tsx";

const decodeSlideId = Schema.decodeUnknownOption(SlideId);

/** Keep links that pass Words' own check; drop every image. */
function chatUrl(url: string, key: "href" | "src"): string | null {
  return key === "src" ? null : (defaultUrlTransform(url) ?? null);
}

/** The view a prompt carries: the preview's slide, if its id is one, and step. */
function viewOf(position: PreviewPosition | null): ViewContext | null {
  if (position === null) {
    return null;
  }
  return Option.match(decodeSlideId(position.slideId), {
    onNone: () => null,
    onSome: (slideId) => ({ slideId, step: Math.max(0, Math.trunc(position.step)) }),
  });
}

/** A path the agent named, shown relative to the deck when it lies inside it. */
function deckRelative(deck: OpenDeck, file: string): string {
  const prefix = deck.root.endsWith("/") ? deck.root : `${deck.root}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * A title the agent wrote, with the deck's files named relative to the deck. The session's working
 * directory is not the deck, so claude-acp names them by absolute path (`Edit /work/deck/slides/a.mdx`).
 */
function deckTitle(deck: OpenDeck, title: string): string {
  const prefix = deck.root.endsWith("/") ? deck.root : `${deck.root}/`;
  return title.replaceAll(prefix, "");
}

/** What the session badge says. */
function sessionLabel(chat: ChatState | null): string {
  if (chat === null) {
    return "Connecting";
  }
  switch (chat.session._tag) {
    case "NotStarted":
      return "Not started";
    case "Starting":
      return "Starting";
    case "Ready":
      return chat.turn === "Idle" ? "Ready" : chat.turn === "Stopping" ? "Stopping" : "Working";
    case "Ended":
      return "Stopped";
  }
}

const CHOICE_ORDER = ["allow_once", "allow_always", "reject_once", "reject_always"];

/** The choices, allows first, as the agent's kinds say. */
function orderedChoices(choices: ReadonlyArray<PermissionChoice>): ReadonlyArray<PermissionChoice> {
  const rank = (choice: PermissionChoice) => {
    const index = CHOICE_ORDER.indexOf(choice.kind);
    return index < 0 ? CHOICE_ORDER.length : index;
  };
  return choices.toSorted((a, b) => rank(a) - rank(b));
}

/** The files a tool call or permission request shows: diffs, then named changes, then paths. */
function FileDetail({
  deck,
  entry,
}: {
  readonly deck: OpenDeck;
  readonly entry: Extract<ChatEntry, { readonly _tag: "Tool" | "Permission" }>;
}) {
  return (
    <>
      {entry.diffs.map((diff, index) => (
        <RenderBoundary key={index} label="This diff">
          {diff._tag === "Patch" ? (
            <PatchView patch={diff.text} root={deck.root} />
          ) : (
            <FileChangeView name={deckRelative(deck, diff.path)} before={diff.oldText} after={diff.newText} />
          )}
        </RenderBoundary>
      ))}
      {entry.changes.length > 0 ? (
        <ul className="studio-chat-files" aria-label="Files">
          {entry.changes.map((change) => (
            <li key={`${change.operation}:${change.path}`}>
              <Badge variant="muted">{change.operation}</Badge>{" "}
              <code>
                {change.oldPath === null
                  ? deckRelative(deck, change.path)
                  : `${deckRelative(deck, change.oldPath)} → ${deckRelative(deck, change.path)}`}
              </code>
            </li>
          ))}
        </ul>
      ) : entry.diffs.length === 0 && entry.paths.length > 0 ? (
        <ul className="studio-chat-files" aria-label="Files">
          {entry.paths.map((file) => (
            <li key={file}>
              <code>{deckRelative(deck, file)}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** A permission request: what the agent wants to do and the answers it offers. */
function PermissionCard({
  deck,
  entry,
}: {
  readonly deck: OpenDeck;
  readonly entry: Extract<ChatEntry, { readonly _tag: "Permission" }>;
}) {
  const { client } = useStudio();
  const [failure, setFailure] = useState<string | null>(null);
  const pending = entry.outcome._tag === "Pending";
  return (
    <Card.Root className="studio-chat-permission" data-pending={pending ? "true" : undefined}>
      <Card.Header>
        <Card.Title level={3}>{deckTitle(deck, entry.title)}</Card.Title>
        <Card.Description>
          {entry.outcome._tag === "Pending"
            ? "The agent asks before it goes on."
            : entry.outcome._tag === "Chosen"
              ? `You chose ${entry.outcome.choice.name}.`
              : entry.outcome.reason}
        </Card.Description>
      </Card.Header>
      <Card.Content className="studio-chat-detail">
        {entry.command === null ? null : (
          <pre className="studio-chat-command">
            <code>{entry.command}</code>
          </pre>
        )}
        <FileDetail deck={deck} entry={entry} />
        {failure === null ? null : <p className="studio-chat-failure">{failure}</p>}
      </Card.Content>
      {pending ? (
        <Card.Footer className="studio-chat-choices">
          {orderedChoices(entry.choices).map((choice) => (
            <Button
              key={choice.optionId}
              size="sm"
              variant={choice.kind.startsWith("reject") ? "outline" : "default"}
              onClick={() => {
                setFailure(null);
                void client.decide(deck.scopeId, entry.id, choice.optionId).then((outcome) => {
                  if (outcome._tag === "Failed") {
                    setFailure(outcome.message);
                  }
                });
              }}>
              {choice.name}
            </Button>
          ))}
        </Card.Footer>
      ) : null}
    </Card.Root>
  );
}

/** One chat entry. */
function Entry({
  deck,
  entry,
  streaming,
}: {
  readonly deck: OpenDeck;
  readonly entry: ChatEntry;
  /** Whether this is the agent message still arriving. */
  readonly streaming: boolean;
}) {
  switch (entry._tag) {
    case "User":
      return (
        <div className="studio-chat-user">
          <p>{entry.text}</p>
          {entry.view === null ? null : (
            <p className="studio-chat-view">
              On slide {entry.view.slideId}, step {String(entry.view.step)}
            </p>
          )}
        </div>
      );
    case "Agent":
      return (
        <Markdown className="studio-chat-markdown" isAnimating={streaming} urlTransform={chatUrl}>
          {entry.text}
        </Markdown>
      );
    case "Thought":
      return (
        <details className="studio-chat-thought">
          <summary>Thinking</summary>
          <Markdown className="studio-chat-markdown" urlTransform={chatUrl}>
            {entry.text}
          </Markdown>
        </details>
      );
    case "Tool":
      return (
        <div className="studio-chat-tool">
          <p className="studio-chat-tool-title">
            <span>{deckTitle(deck, entry.title)}</span>
            {entry.status === null ? null : (
              <Badge
                variant={
                  entry.status === "completed"
                    ? "success"
                    : entry.status === "failed"
                      ? "destructive"
                      : "muted"
                }>
                {entry.status.replaceAll("_", " ")}
              </Badge>
            )}
          </p>
          {entry.diffs.length > 0 ? (
            // The permission card that asks about the same edit shows the diff open.
            <details className="studio-chat-tool-diff">
              <summary>Diff</summary>
              <FileDetail deck={deck} entry={entry} />
            </details>
          ) : (
            <FileDetail deck={deck} entry={entry} />
          )}
        </div>
      );
    case "Permission":
      return <PermissionCard deck={deck} entry={entry} />;
    case "Notice":
      return (
        <p className="studio-chat-notice" data-tone={entry.tone}>
          {entry.text}
        </p>
      );
  }
}

/**
 * The chat for the open deck. The composer sends with Enter (Shift+Enter adds a line) while no
 * turn runs; while one runs, Stop ends it.
 */
export function AgentChat({
  deck,
  chat,
  position,
}: {
  readonly deck: OpenDeck;
  /** The chat as the backend last reported it, or null before the first report. */
  readonly chat: ChatState | null;
  /** The preview's position, which the prompt carries as its view. */
  readonly position: PreviewPosition | null;
}) {
  const { client } = useStudio();
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const log = useRef<HTMLOListElement | null>(null);
  const turn = chat?.turn ?? "Idle";
  const entries = chat?.entries ?? [];
  const lastAgent = entries.findLastIndex((entry) => entry._tag === "Agent");

  // Keep the newest entry in view as entries arrive.
  const entryCount = entries.length;
  const lastText = lastAgent < 0 ? "" : entries[lastAgent]?._tag === "Agent" ? entries[lastAgent].text : "";
  useEffect(() => {
    const element = log.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entryCount, lastText]);

  const send = () => {
    const text = draft.trim();
    if (text === "" || turn !== "Idle" || chat === null) {
      return;
    }
    setFailure(null);
    void client.sendPrompt(deck.scopeId, { text, view: viewOf(position) }).then((outcome) => {
      if (outcome._tag === "Failed") {
        setFailure(outcome.message);
      }
    });
    setDraft("");
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="studio-chat">
      <div className="studio-chat-header">
        <h2 className="studio-chat-heading">Agent</h2>
        <Badge variant={turn === "Idle" ? "muted" : "info"}>{sessionLabel(chat)}</Badge>
      </div>
      {chat?.session._tag === "Ended" ? (
        <Alert.Root variant="warning" role="none" className="studio-chat-ended">
          <Alert.Description>{chat.session.reason} The next prompt starts the agent again.</Alert.Description>
        </Alert.Root>
      ) : null}
      <ol
        ref={log}
        className="studio-chat-log"
        aria-label="Messages"
        aria-live="polite"
        aria-busy={turn !== "Idle"}>
        {entries.length === 0 ? (
          <li className="studio-chat-empty">
            Ask the agent to change this deck. It asks before it edits a file, and the Changes tab shows what
            it changed.
          </li>
        ) : (
          entries.map((entry, index) => (
            <li key={entry.id} data-entry={entry._tag}>
              <Entry deck={deck} entry={entry} streaming={turn === "Running" && index === lastAgent} />
            </li>
          ))
        )}
      </ol>
      <form
        className="studio-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}>
        <Textarea
          aria-label="Message the agent"
          placeholder={
            position === null
              ? "Ask the agent…"
              : `Ask the agent about ${position.slideId}, step ${String(position.step)}…`
          }
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
        />
        {failure === null ? null : (
          <p className="studio-chat-failure" role="alert">
            {failure}
          </p>
        )}
        <div className="studio-chat-actions">
          {turn === "Idle" ? (
            <Button type="submit" size="sm" disabled={draft.trim() === "" || chat === null}>
              Send
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={turn === "Stopping"}
              onClick={() => {
                void client.stopAgent(deck.scopeId);
              }}>
              {turn === "Stopping" ? "Stopping…" : "Stop"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
