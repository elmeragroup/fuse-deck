import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import * as LineEnding from "@elmeragroup/deck-core/deck/line-ending";
import type {
  DiskSlide,
  OpenedSlide,
  SlideProblem,
  SlideRevision,
} from "@elmeragroup/deck-core/deck/slide-edit";
import type { SlideId } from "@elmeragroup/deck-core/deck/slide-id";
import { Alert } from "@elmeragroup/fuse/alert";
import { Button } from "@elmeragroup/fuse/button";
import { Kbd, KbdGroup } from "@elmeragroup/fuse/kbd";
import { Textarea } from "@elmeragroup/fuse/textarea";

import type { AgentTurn } from "../../contract/agent-chat.ts";
import type { OpenDeck } from "../../contract/studio-rpc.ts";
import { slideReads } from "../state/slide-reads.ts";
import type { ReadKey, SlideReads } from "../state/slide-reads.ts";
import type { OpenOutcome, SaveOutcome } from "../state/studio-client.ts";
import { useStudio } from "../state/use-studio.ts";

/** What the disk holds when it no longer matches the editor's base: a slide file, none, or no slide. */
type DiskState = DiskSlide | { readonly _tag: "NotInDeck"; readonly message: string };

/** A slide open in the editor. */
type Editing = {
  readonly _tag: "Editing";
  readonly id: SlideId;
  /** The revision the draft saves over, or null to expect no file. */
  readonly base: SlideRevision | null;
  /**
   * The text at `base` with LF line endings, as the textarea holds it. The draft is compared with
   * it to tell whether it is dirty.
   */
  readonly saved: string;
  /** The text in the textarea, with LF line endings. */
  readonly draft: string;
  /** The file's line ending when it was read, which a save writes the draft back with. */
  readonly lineEnding: LineEnding.LineEnding;
  /** What the last save's compile found, or null. */
  readonly problem: SlideProblem | null;
  readonly saving: boolean;
  /** A save that found the disk changed: the draft stays, beside what the disk holds. */
  readonly conflict: DiskState | null;
  /** The slide changed on disk while the draft had edits. */
  readonly changedOnDisk: DiskState | null;
  /** The last save failure that was not a conflict. */
  readonly failure: string | null;
};

/** Where the editor stands. */
type EditorState =
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Loading"; readonly id: SlideId }
  | { readonly _tag: "Gone"; readonly id: SlideId; readonly message: string }
  | Editing;

function isDirty(state: Editing): boolean {
  return state.draft !== state.saved;
}

function slideFile(id: SlideId): string {
  return `slides/${id}.mdx`;
}

/** What a slide read from disk sets in the editor: its revision, its text and its line ending. */
function fromDisk(slide: Pick<OpenedSlide, "source" | "revision">) {
  const text = LineEnding.toEditor(slide.source);
  return {
    base: slide.revision,
    saved: text,
    draft: text,
    lineEnding: LineEnding.detect(slide.source),
  };
}

/** A problem's parser message and hint, as sentences. MDX's messages end without a period. */
function problemText(problem: SlideProblem): string {
  const message = /[.!?]$/.test(problem.message) ? problem.message : `${problem.message}.`;
  return `${message} ${problem.hint}`;
}

/** An unsaved draft, for the prompt that asks before it would be dropped. */
export type UnsavedDraft = {
  /** The slide file the draft is for, such as `slides/intro.mdx`. */
  readonly file: string;
  /** The draft's text, with the line endings the file is saved with. */
  readonly text: string;
  /** Why the draft cannot be saved now, such as an agent's turn, or null when it can. */
  readonly saveBlocked: string | null;
  /** Save the draft over the revision it was opened at; true when it saved. */
  readonly save: () => Promise<boolean>;
};

/** The disk state a save outcome reports, if the save wrote nothing because of it. */
function diskOf(outcome: SaveOutcome): DiskState | null {
  switch (outcome._tag) {
    case "Conflict":
      return outcome.disk;
    case "NotInDeck":
      return { _tag: "NotInDeck", message: outcome.message };
    case "Saved":
    case "Failed":
      return null;
  }
}

/** The next state, and what the status line announces about it, or null. */
type Transition = { readonly state: EditorState; readonly message: string | null };

/**
 * What a read of the open slide from disk does to the editor: nothing when the disk holds the
 * base revision, such as after the editor's own save; a clean draft loads a changed file or
 * reports a gone one; a draft with edits gets a notice.
 */
function afterDiskCheck(editing: Editing, outcome: OpenOutcome): Transition {
  const unchanged = { state: editing, message: null };
  if (editing.saving || editing.conflict !== null || outcome._tag === "Failed") {
    return unchanged;
  }
  if (outcome._tag === "Opened" && outcome.slide.revision === editing.base) {
    return editing.changedOnDisk === null
      ? unchanged
      : { state: { ...editing, changedOnDisk: null }, message: null };
  }
  const file = slideFile(editing.id);
  if (!isDirty(editing)) {
    return outcome._tag === "Opened"
      ? {
          state: { ...editing, ...fromDisk(outcome.slide), problem: null, changedOnDisk: null },
          message: `Loaded ${file}: it changed on disk.`,
        }
      : {
          state: { _tag: "Gone", id: editing.id, message: outcome.message },
          message: `${file} is gone from disk.`,
        };
  }
  return {
    state: {
      ...editing,
      changedOnDisk:
        outcome._tag === "Opened"
          ? { _tag: "Present", source: outcome.slide.source, revision: outcome.slide.revision }
          : { _tag: "Missing" },
    },
    message: null,
  };
}

/** What a save's outcome does to the editor. `draft` is the text the save sent. */
function afterSave(editing: Editing, draft: string, outcome: SaveOutcome): Transition {
  const done = { ...editing, saving: false };
  const file = slideFile(editing.id);
  if (outcome._tag === "Saved") {
    return {
      state: {
        ...done,
        base: outcome.saved.revision,
        saved: draft,
        problem: outcome.saved.problem,
        conflict: null,
        changedOnDisk: null,
      },
      message: outcome.saved.problem === null ? `Saved ${file}.` : `Saved ${file}, which does not compile.`,
    };
  }
  const disk = diskOf(outcome);
  if (disk !== null) {
    return {
      state: { ...done, conflict: disk, changedOnDisk: null },
      message: `Not saved: ${file} changed on disk.`,
    };
  }
  const failure = outcome._tag === "Failed" ? outcome.message : null;
  return { state: { ...done, failure }, message: `Not saved: ${failure ?? ""}` };
}

/**
 * The Source tab: one slide's MDX in a Fuse textarea, saved with Save or Cmd/Ctrl+S over the
 * revision it was opened at. While the draft has no edits it follows the slide the preview shows;
 * with edits, it stays on its slide.
 *
 * A save that finds the file changed or deleted writes nothing and shows the draft beside the
 * disk state, with a choice to save the draft over it or to load the disk version. A change on
 * disk to the open slide loads it when the draft has no edits, and otherwise shows a notice. A
 * saved slide that does not compile shows its problem at its line, or as a banner when MDX gives
 * no line.
 */
export function SourceEditor({
  deck,
  target,
  active,
  agentTurn,
  onUnsavedDraft,
}: {
  readonly deck: OpenDeck;
  readonly target: SlideId | null;
  /** Whether the Source tab shows. A hidden editor reads nothing from the backend. */
  readonly active: boolean;
  /**
   * The agent's turn. While one runs or stops, the editor is read-only and offers Stop: the agent
   * writes to the deck then. The save's revision check stays the guard against a lost edit.
   */
  readonly agentTurn: AgentTurn;
  /** Called with the draft whenever it has edits, and with null when it has none. */
  readonly onUnsavedDraft: (draft: UnsavedDraft | null) => void;
}) {
  const { client, snapshot } = useStudio();
  const [state, setState] = useState<EditorState>({ _tag: "Waiting" });
  // The handlers read the state the last render committed.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const gutter = useRef<HTMLDivElement | null>(null);
  // Every save goes through `save`, which reads the turn the last render committed.
  const agentTurnRef = useRef(agentTurn);
  useLayoutEffect(() => {
    agentTurnRef.current = agentTurn;
  });
  const saveBlocked = saveBlockedBy(agentTurn);

  // Every read of the slide goes through one owner, which drops an answer that a newer read, a
  // reconnect, a reopened deck or another slide made stale.
  const snapshotRef = useRef(snapshot);
  const deckRef = useRef(deck);
  useLayoutEffect(() => {
    snapshotRef.current = snapshot;
    deckRef.current = deck;
  });
  const readKey = useCallback(
    (id: SlideId): ReadKey => ({
      session: snapshotRef.current.session,
      scopeId: deckRef.current.scopeId,
      id,
    }),
    []
  );
  const reads = useRef<SlideReads | null>(null);
  const read = useCallback(
    (id: SlideId, apply: (outcome: OpenOutcome) => void) => {
      reads.current ??= slideReads(client.openSlide, () => {
        const current = stateRef.current;
        return current._tag === "Waiting" ? null : readKey(current.id);
      });
      reads.current.read(readKey(id), apply);
    },
    [client, readKey]
  );

  /** Apply `change` to the editor state, if it still edits slide `id`. */
  const updateEditing = useCallback((id: SlideId, change: (editing: Editing) => EditorState) => {
    setState((current) => (current._tag === "Editing" && current.id === id ? change(current) : current));
  }, []);

  /**
   * Apply a pure transition to the editor state, if it still edits slide `id`, then announce what
   * the transition says about the state the last render committed.
   */
  const transition = useCallback(
    (id: SlideId, change: (editing: Editing) => Transition) => {
      updateEditing(id, (editing) => change(editing).state);
      const current = stateRef.current;
      const message = current._tag === "Editing" && current.id === id ? change(current).message : null;
      if (message !== null) {
        client.announce(message);
      }
    },
    [client, updateEditing]
  );

  const open = useCallback(
    (id: SlideId) => {
      setState({ _tag: "Loading", id });
      // The state shows Loading before the answer can arrive, so the owner reads it as current.
      stateRef.current = { _tag: "Loading", id };
      read(id, (outcome) => {
        setState((current) => {
          if (current._tag !== "Loading" || current.id !== id) {
            return current;
          }
          switch (outcome._tag) {
            case "Opened":
              return {
                _tag: "Editing",
                id,
                ...fromDisk(outcome.slide),
                problem: null,
                saving: false,
                conflict: null,
                changedOnDisk: null,
                failure: null,
              };
            case "Gone":
            case "Failed":
              return { _tag: "Gone", id, message: outcome.message };
          }
        });
      });
    },
    [read]
  );

  /**
   * Compare the open slide with the disk: a clean draft loads what changed, a dirty one gets a
   * notice. The editor's own save comes back with the base revision and changes nothing.
   */
  const checkDisk = useCallback(
    (id: SlideId) => {
      read(id, (outcome) => {
        transition(id, (editing) => afterDiskCheck(editing, outcome));
      });
    },
    [read, transition]
  );

  // Follow the preview's slide while the draft has no edits.
  useEffect(() => {
    if (target === null || !active) {
      return;
    }
    const current = stateRef.current;
    if (
      current._tag === "Editing" &&
      (current.id === target || isDirty(current) || current.conflict !== null)
    ) {
      return;
    }
    if (current._tag === "Loading" && current.id === target) {
      return;
    }
    open(target);
  }, [target, active, open]);

  // A change on disk while the tab was hidden went unchecked; check once as it shows.
  useEffect(() => {
    const current = stateRef.current;
    if (active && current._tag === "Editing") {
      checkDisk(current.id);
    }
  }, [active, checkDisk]);

  // A new session or a reopened deck missed the watcher's reports in between, and a read in flight
  // was dropped: read again, once the tab shows.
  const readFor = useRef<{ readonly session: number; readonly scopeId: string } | null>(null);
  useEffect(() => {
    if (!active) {
      return;
    }
    const before = readFor.current;
    readFor.current = { session: snapshot.session, scopeId: deck.scopeId };
    if (before === null || (before.session === snapshot.session && before.scopeId === deck.scopeId)) {
      return;
    }
    const current = stateRef.current;
    if (current._tag === "Editing") {
      checkDisk(current.id);
    } else if (current._tag !== "Waiting") {
      open(current.id);
    }
  }, [active, snapshot.session, deck.scopeId, checkDisk, open]);

  // A report from the deck's watcher about the open slide, or the order, checks the disk.
  const { diskChange } = snapshot;
  useEffect(() => {
    const current = stateRef.current;
    if (!active || diskChange?.scopeId !== deck.scopeId || current._tag !== "Editing") {
      return;
    }
    if (diskChange.paths.includes(slideFile(current.id)) || diskChange.paths.includes("deck.json")) {
      checkDisk(current.id);
    }
  }, [active, diskChange, deck.scopeId, checkDisk]);

  /**
   * Save the draft over `expected`, the one save operation every control uses. It resolves with
   * the outcome, or null when no save started: none starts while the agent's turn runs or stops.
   */
  const save = useCallback(
    (expected: SlideRevision | null): Promise<SaveOutcome | null> => {
      const current = stateRef.current;
      if (current._tag !== "Editing" || current.saving) {
        return Promise.resolve(null);
      }
      const blocked = saveBlockedBy(agentTurnRef.current);
      if (blocked !== null) {
        client.announce(`Not saved: ${blocked}`);
        return Promise.resolve(null);
      }
      const { id, draft, lineEnding } = current;
      setState({ ...current, saving: true, failure: null });
      return client
        .saveSlide(deck.scopeId, id, expected, LineEnding.toFile(draft, lineEnding))
        .then((outcome) => {
          transition(id, (editing) => afterSave(editing, draft, outcome));
          if (outcome._tag === "Saved") {
            // A change that landed while the save ran was not checked; check once now.
            checkDisk(id);
          }
          return outcome;
        });
    },
    [client, deck.scopeId, transition, checkDisk]
  );

  // The prompt before a deck switch, a close or a quit asks about a draft with edits.
  const unsavedId = state._tag === "Editing" && isDirty(state) ? state.id : null;
  const unsavedText =
    state._tag === "Editing" && isDirty(state) ? LineEnding.toFile(state.draft, state.lineEnding) : null;
  useEffect(() => {
    if (unsavedId === null || unsavedText === null) {
      onUnsavedDraft(null);
      return;
    }
    onUnsavedDraft({
      file: slideFile(unsavedId),
      text: unsavedText,
      saveBlocked,
      save: () => {
        const current = stateRef.current;
        if (current._tag !== "Editing" || current.conflict !== null) {
          return Promise.resolve(false);
        }
        return save(current.base).then((outcome) => outcome?._tag === "Saved");
      },
    });
  }, [unsavedId, unsavedText, saveBlocked, save, onUnsavedDraft]);
  useEffect(
    () => () => {
      onUnsavedDraft(null);
    },
    [onUnsavedDraft]
  );

  const loadDisk = useCallback(
    (disk: DiskState) => {
      const current = stateRef.current;
      if (current._tag !== "Editing") {
        return;
      }
      if (disk._tag === "Present") {
        setState({
          ...current,
          ...fromDisk(disk),
          problem: null,
          conflict: null,
          changedOnDisk: null,
          failure: null,
        });
        client.announce(`Loaded ${slideFile(current.id)} from disk. Your draft was discarded.`);
      } else {
        open(current.id);
      }
    },
    [client, open]
  );

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (
      event.key.toLowerCase() === "s" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      const current = stateRef.current;
      if (current._tag === "Editing" && current.conflict === null) {
        void save(current.base);
      }
    }
  };

  const goToLine = (line: number) => {
    const element = textarea.current;
    if (element === null) {
      return;
    }
    const lines = element.value.split("\n");
    const start = lines.slice(0, line - 1).reduce((sum, each) => sum + each.length + 1, 0);
    element.focus();
    element.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  };

  if (state._tag === "Waiting" || state._tag === "Loading") {
    return (
      <div className="studio-source" aria-busy="true">
        <p className="studio-source-message">Loading the slide's source…</p>
      </div>
    );
  }
  if (state._tag === "Gone") {
    return (
      <div className="studio-source">
        <Alert.Root variant="warning" role="none">
          <Alert.Title level={2}>{slideFile(state.id)} cannot be opened</Alert.Title>
          <Alert.Description>{state.message}</Alert.Description>
        </Alert.Root>
      </div>
    );
  }

  const dirty = isDirty(state);
  const locked = saveBlocked !== null;
  const located =
    state.problem?._tag === "SlideCompileFailed" && state.problem.line !== null ? state.problem : null;
  const problemLine = located?.line ?? null;
  const lineCount = state.draft.split("\n").length;
  const problemId = `source-problem-${state.id}`;

  return (
    <div className="studio-source">
      <div className="studio-source-toolbar">
        <h2 className="studio-source-file">
          {slideFile(state.id)}
          {dirty ? (
            <span className="studio-source-dirty" data-dirty="true">
              <span aria-hidden="true"> ●</span> Unsaved changes
            </span>
          ) : null}
        </h2>
        <KbdGroup aria-hidden="true">
          <Kbd>⌘</Kbd>
          <Kbd>S</Kbd>
        </KbdGroup>
        <Button
          size="sm"
          aria-keyshortcuts="Meta+S Control+S"
          disabled={!dirty || state.saving || state.conflict !== null || locked}
          onClick={() => {
            void save(state.base);
          }}>
          {state.saving ? "Saving…" : "Save"}
        </Button>
      </div>

      {locked ? (
        <Alert.Root variant="info" role="none">
          <Alert.Title level={3}>The agent is working</Alert.Title>
          <Alert.Description>
            Source is read-only until the agent's turn ends.{" "}
            <Button
              size="sm"
              variant="outline"
              disabled={agentTurn === "Stopping"}
              onClick={() => {
                void client.stopAgent(deck.scopeId);
              }}>
              {agentTurn === "Stopping" ? "Stopping…" : "Stop"}
            </Button>
          </Alert.Description>
        </Alert.Root>
      ) : null}
      {state.failure === null ? null : (
        <Alert.Root variant="destructive" role="alert">
          <Alert.Title level={3}>Not saved</Alert.Title>
          <Alert.Description>{state.failure}</Alert.Description>
        </Alert.Root>
      )}
      {state.changedOnDisk === null || state.conflict !== null ? null : (
        <ChangedOnDisk
          id={state.id}
          disk={state.changedOnDisk}
          onLoad={() => {
            if (state.changedOnDisk !== null) {
              loadDisk(state.changedOnDisk);
            }
          }}
        />
      )}
      {state.problem === null || located !== null ? null : (
        <Alert.Root variant="destructive" role="none" id={problemId}>
          <Alert.Title level={3}>This slide does not render</Alert.Title>
          <Alert.Description>{problemText(state.problem)}</Alert.Description>
        </Alert.Root>
      )}

      {state.conflict === null ? (
        <div className="studio-source-editor">
          <div className="studio-source-gutter" ref={gutter} aria-hidden="true">
            {Array.from({ length: lineCount }, (_, index) => (
              <span key={index} data-problem={index + 1 === problemLine ? "true" : undefined}>
                {String(index + 1)}
              </span>
            ))}
          </div>
          <Textarea
            ref={textarea}
            className="studio-source-text"
            aria-label={`Source of ${slideFile(state.id)}`}
            aria-invalid={state.problem === null ? undefined : true}
            aria-describedby={state.problem === null ? undefined : problemId}
            spellCheck={false}
            aria-keyshortcuts="Meta+S Control+S"
            onKeyDown={onKeyDown}
            readOnly={locked}
            value={state.draft}
            onScroll={(event) => {
              if (gutter.current !== null) {
                gutter.current.scrollTop = event.currentTarget.scrollTop;
              }
            }}
            onChange={(event) => {
              const draft = event.currentTarget.value;
              updateEditing(state.id, (editing) => ({ ...editing, draft }));
            }}
          />
        </div>
      ) : (
        <Conflict
          id={state.id}
          draft={state.draft}
          disk={state.conflict}
          saving={state.saving}
          saveBlocked={saveBlocked}
          onKeepDraft={(expected) => {
            void save(expected);
          }}
          onLoadDisk={() => {
            if (state.conflict !== null) {
              loadDisk(state.conflict);
            }
          }}
        />
      )}

      {located === null || state.conflict !== null ? null : (
        <Alert.Root variant="destructive" role="none" id={problemId}>
          <Alert.Title level={3}>
            Line {String(located.line)}
            {located.column === null ? "" : `, column ${String(located.column)}`}: this slide does not compile
          </Alert.Title>
          <Alert.Description>
            <p className="studio-source-problem-text">{problemText(located)}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (located.line !== null) {
                  goToLine(located.line);
                }
              }}>
              Go to line {String(located.line)}
            </Button>
          </Alert.Description>
        </Alert.Root>
      )}
    </div>
  );
}

/** Why no save can start during `turn`, or null when one can: the agent writes to the deck then. */
function saveBlockedBy(turn: AgentTurn): string | null {
  return turn === "Idle" ? null : "Source is read-only until the agent's turn ends.";
}

/** The notice for a slide that changed on disk while the draft had edits. */
function ChangedOnDisk({
  id,
  disk,
  onLoad,
}: {
  readonly id: SlideId;
  readonly disk: DiskState;
  readonly onLoad: () => void;
}) {
  if (disk._tag !== "Present") {
    return (
      <Alert.Root variant="warning" role="none">
        <Alert.Title level={3}>{slideFile(id)} was deleted on disk</Alert.Title>
        <Alert.Description>Your draft is still here. Saving it shows your choices.</Alert.Description>
      </Alert.Root>
    );
  }
  return (
    <Alert.Root variant="warning" role="none" onAction={onLoad} actionLabel="Load the disk version">
      <Alert.Title level={3}>{slideFile(id)} changed on disk</Alert.Title>
      <Alert.Description>
        Your draft has edits. Save to choose between them, or load the disk version.
      </Alert.Description>
    </Alert.Root>
  );
}

/** A save that found the disk changed: the draft beside the disk state, with the choices. */
function Conflict({
  id,
  draft,
  disk,
  saving,
  saveBlocked,
  onKeepDraft,
  onLoadDisk,
}: {
  readonly id: SlideId;
  readonly draft: string;
  readonly disk: DiskState;
  readonly saving: boolean;
  /** Why the draft cannot be saved now, or null. */
  readonly saveBlocked: string | null;
  readonly onKeepDraft: (expected: SlideRevision | null) => void;
  readonly onLoadDisk: () => void;
}) {
  const title =
    disk._tag === "Present"
      ? `${slideFile(id)} changed on disk since you opened it`
      : disk._tag === "Missing"
        ? `${slideFile(id)} was deleted on disk since you opened it`
        : `The deck no longer has the slide ${id}`;
  return (
    <section className="studio-conflict" aria-labelledby="studio-conflict-title">
      <Alert.Root variant="warning" role="alert">
        <Alert.Title level={3} id="studio-conflict-title">
          {title}
        </Alert.Title>
        <Alert.Description>Nothing was saved. Your draft is kept below.</Alert.Description>
      </Alert.Root>
      <div className="studio-conflict-columns">
        <div className="studio-conflict-column">
          <h3 id="studio-conflict-draft">Your draft</h3>
          <Textarea
            className="studio-source-text"
            aria-labelledby="studio-conflict-draft"
            readOnly
            spellCheck={false}
            value={draft}
          />
        </div>
        <div className="studio-conflict-column">
          <h3 id="studio-conflict-disk">On disk</h3>
          {disk._tag === "Present" ? (
            <Textarea
              className="studio-source-text"
              aria-labelledby="studio-conflict-disk"
              readOnly
              spellCheck={false}
              value={LineEnding.toEditor(disk.source)}
            />
          ) : (
            <p className="studio-source-message">
              {disk._tag === "Missing" ? "The file is gone." : disk.message}
            </p>
          )}
        </div>
      </div>
      <div className="studio-conflict-actions">
        {disk._tag === "NotInDeck" ? null : (
          <Button
            disabled={saving || saveBlocked !== null}
            onClick={() => {
              onKeepDraft(disk._tag === "Present" ? disk.revision : null);
            }}>
            {disk._tag === "Present" ? "Save my draft over it" : "Save my draft as the slide"}
          </Button>
        )}
        <Button variant="outline" disabled={saving} onClick={onLoadDisk}>
          {disk._tag === "Present" ? "Discard my draft and load the disk version" : "Discard my draft"}
        </Button>
      </div>
    </section>
  );
}
