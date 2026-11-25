/**
 * A patch with its file headers in git's `a/` and `b/` form, relative to the deck.
 *
 * `claude-acp` 0.109.0 sends ACP v2 patches whose headers name absolute paths without git's
 * prefixes (`diff --git /deck/slides/a.mdx /deck/slides/a.mdx`), which `@pierre/diffs` refuses to
 * parse. This rewrites the `diff --git`, `---` and `+++` lines of such headers; hunks and headers
 * already in git's form pass through unchanged.
 */

/**
 * `file` relative to `root`. A file outside the deck climbs out with `../`, so its header shows
 * that it leaves the deck: `/etc/hosts` from `/work/deck` is `../../etc/hosts`.
 */
function relativeTo(root: string, file: string): string {
  const from = root.split("/").filter((part) => part !== "");
  const to = file.split("/").filter((part) => part !== "");
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) {
    shared += 1;
  }
  return [...Array.from({ length: from.length - shared }, () => ".."), ...to.slice(shared)].join("/");
}

/**
 * The two paths of a `diff --git` line's rest, when both are absolute. A path may hold spaces,
 * so equal halves split first; otherwise the split is at the second path's leading ` /`.
 */
function gitPaths(rest: string): readonly [string, string] | null {
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(0, half) === rest.slice(half + 1)) {
    const file = rest.slice(0, half);
    return file.startsWith("/") ? [file, file] : null;
  }
  const split = rest.indexOf(" /", 1);
  return rest.startsWith("/") && split > 0 ? [rest.slice(0, split), rest.slice(split + 1)] : null;
}

/**
 * Rewrite absolute paths in `patch`'s file headers to `a/<path>` and `b/<path>` relative to `root`.
 *
 * @param patch - A patch in git's format.
 * @param root - The deck directory, absolute.
 */
export function relativePatch(patch: string, root: string): string {
  // `---` and `+++` name files only in a file's header, before its first hunk: inside a hunk the
  // same text is a removed or added line.
  let inHeader = true;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        inHeader = true;
        const paths = gitPaths(line.slice("diff --git ".length));
        return paths === null
          ? line
          : `diff --git a/${relativeTo(root, paths[0])} b/${relativeTo(root, paths[1])}`;
      }
      if (line.startsWith("@@")) {
        inHeader = false;
      }
      if (!inHeader) {
        return line;
      }
      for (const [marker, side] of [
        ["--- ", "a"],
        ["+++ ", "b"],
      ] as const) {
        // The path runs to the end of the line or to a tab before a timestamp.
        const file = line.startsWith(marker) ? (line.slice(marker.length).split("\t")[0] ?? "") : "";
        if (file.startsWith("/") && file !== "/dev/null") {
          return `${marker}${side}/${relativeTo(root, file)}`;
        }
      }
      return line;
    })
    .join("\n");
}
