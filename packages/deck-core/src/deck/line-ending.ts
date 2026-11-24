/**
 * A slide file's line ending, which an editor keeps when it writes the file back. A textarea holds
 * its text with LF only, so the editor works on that form and turns it back into the file's
 * ending on save. No Node API, so the studio's renderer imports it.
 */

/** How a file ends its lines. */
export type LineEnding = "LF" | "CRLF";

/**
 * The ending a file uses. A mixed file gets the ending most of its lines have; a tie, and a file
 * with no line break, get LF.
 *
 * @param text - The file's text as read.
 * @returns The file's line ending.
 */
export function detect(text: string): LineEnding {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "CRLF" : "LF";
}

/**
 * The text as a textarea holds it: every CRLF and lone CR becomes LF.
 *
 * @param text - Text with any line endings.
 * @returns The text with LF line endings.
 */
export function toEditor(text: string): string {
  return text.replaceAll(/\r\n?/g, "\n");
}

/**
 * The text as the file stores it: every line ends with `ending`.
 *
 * @param text - Text with any line endings, such as a textarea's.
 * @param ending - The file's line ending.
 * @returns The text with `ending` at the end of every line.
 */
export function toFile(text: string, ending: LineEnding): string {
  const editor = toEditor(text);
  return ending === "CRLF" ? editor.replaceAll("\n", "\r\n") : editor;
}
