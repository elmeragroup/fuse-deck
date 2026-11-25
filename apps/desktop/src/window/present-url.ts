/**
 * Which address the Present window may show. The renderer names the address, so main checks it
 * against the deck the backend has open, which it asks the backend for itself.
 */

import * as Option from "effect/Option";

/**
 * The address to present, if it is a page of the open deck: plain http on 127.0.0.1 with no
 * credentials, on the open deck's origin. Any other address, including another 127.0.0.1 port,
 * and any address while no deck is open, is refused.
 *
 * @param requested - The address the renderer asked to present.
 * @param openDeck - The open deck's address as the backend reports it, or none while none is open.
 * @returns The parsed address, or none when Present must refuse it.
 */
export function presentableUrl(requested: string, openDeck: Option.Option<string>): Option.Option<URL> {
  return Option.flatMap(openDeck, (deck) => {
    const parsed = parseUrl(requested);
    const origin = Option.map(parseUrl(deck), (url) => url.origin);
    return Option.filter(
      parsed,
      (url) =>
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.username === "" &&
        url.password === "" &&
        Option.contains(origin, url.origin)
    );
  });
}

function parseUrl(url: string): Option.Option<URL> {
  return URL.canParse(url) ? Option.some(new URL(url)) : Option.none();
}
