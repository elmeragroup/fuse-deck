/**
 * Diffs through `@pierre/diffs`, as t3code renders them: a patch the agent sent, or two versions
 * of one file. The diff draws in its own shadow root and reads its colors and fonts from
 * `--diffs-*` custom properties, which `studio.css` maps onto Fuse's tokens on `.studio-diff`. The
 * light or dark palette follows the `data-theme` Fuse's color-scheme bootstrap sets on `<html>`.
 */

import { useMemo, useSyncExternalStore } from "react";

import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";

import { relativePatch } from "../state/relative-patch.ts";

/** The resolved color scheme Fuse's bootstrap writes to `<html data-theme>`. */
function useDocumentScheme(): "light" | "dark" {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => {
        observer.disconnect();
      };
    },
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light")
  );
}

/** The options every studio diff shares. */
function useDiffOptions() {
  const scheme = useDocumentScheme();
  return {
    theme: { light: "pierre-light", dark: "pierre-dark" },
    themeType: scheme,
    diffStyle: "unified",
    overflow: "wrap",
    lineDiffType: "word",
  } as const;
}

/**
 * The files of a patch, or none when it does not parse. `PatchDiff` throws on a patch with more
 * than one file, so the studio parses the patch itself and draws each file.
 */
function patchFiles(patch: string): ReadonlyArray<FileDiffMetadata> {
  try {
    return parsePatchFiles(patch, { throwOnError: true }).flatMap((parsed) => parsed.files);
  } catch {
    // The library reports a patch it cannot read by throwing; it has no other outcome for it.
    return [];
  }
}

/**
 * A patch in git's format, one or more files, its headers made relative to the deck. A patch that
 * does not parse shows as its text; the changes the agent named show beside it either way.
 */
export function PatchView({ patch, root }: { readonly patch: string; readonly root: string }) {
  const options = useDiffOptions();
  const relative = relativePatch(patch, root);
  const files = useMemo(() => patchFiles(relative), [relative]);
  if (files.length === 0) {
    return <pre className="studio-diff-raw">{relative}</pre>;
  }
  return (
    <>
      {files.map((file, index) => (
        <FileDiff
          key={`${String(index)}:${file.name}`}
          className="studio-diff"
          fileDiff={file}
          options={options}
        />
      ))}
    </>
  );
}

/** One file before and after; an empty side stands for a file that did not exist. */
export function FileChangeView({
  name,
  before,
  after,
}: {
  /** The path the header shows, relative to the deck. */
  readonly name: string;
  readonly before: string | null;
  readonly after: string | null;
}) {
  const options = useDiffOptions();
  return (
    <MultiFileDiff
      className="studio-diff"
      oldFile={{ name, contents: before ?? "" }}
      newFile={{ name, contents: after ?? "" }}
      options={options}
    />
  );
}
