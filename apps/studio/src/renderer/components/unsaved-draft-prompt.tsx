import { useState } from "react";

import { Button } from "@elmeragroup/fuse/button";
import { Dialog } from "@elmeragroup/fuse/dialog";

import type { UnsavedDraft } from "./source-editor.tsx";

/** A leave the prompt holds back: what it does once the draft is settled. */
export type PendingLeave = {
  /** The draft that would be dropped. */
  readonly draft: UnsavedDraft;
  /** Switch, close or quit, as the user asked. */
  readonly proceed: () => void;
};

/**
 * The question before a deck switch, a close or a quit drops an unsaved draft: Save, Discard or
 * Cancel. Save goes on only once the draft saved, and is off while the draft cannot be saved, as
 * during an agent's turn; a save that fails or conflicts cancels the leave, and `onSaveFailed`
 * shows the editor with the reason. Discard goes on and writes nothing.
 * Cancel, Escape and the close button leave everything as it was.
 */
export function UnsavedDraftPrompt({
  pending,
  onSettled,
  onSaveFailed,
}: {
  readonly pending: PendingLeave | null;
  /** Called when the prompt closes, whatever the answer. */
  readonly onSettled: () => void;
  readonly onSaveFailed: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const file = pending?.draft.file ?? "";
  const blocked = pending?.draft.saveBlocked ?? null;

  const save = () => {
    if (pending === null) {
      return;
    }
    setSaving(true);
    void pending.draft.save().then((saved) => {
      setSaving(false);
      onSettled();
      if (saved) {
        pending.proceed();
      } else {
        onSaveFailed();
      }
    });
  };

  return (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !saving) {
          onSettled();
        }
      }}>
      <Dialog.Content size="md" showCloseButton={false}>
        <Dialog.Header>
          <Dialog.Title>Save your changes to {file}?</Dialog.Title>
          <Dialog.Description>
            The Source tab has edits that are not saved.
            {blocked === null ? null : ` ${blocked}`}
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="outline" disabled={saving} />}>Cancel</Dialog.Close>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              onSettled();
              pending?.proceed();
            }}>
            Discard
          </Button>
          <Button disabled={saving || blocked !== null} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
