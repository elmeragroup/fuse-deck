/**
 * The relay's environment, which the backend sets in `session/new` and the relay reads. This module
 * imports nothing, so the relay's entry stays small.
 */

/** The variable that holds the backend's `/mcp` address. */
export const RELAY_ENDPOINT_VARIABLE = "FUSE_DECK_MCP_ENDPOINT";

/** The variable that holds the session's token as an `Authorization` value, `Bearer <token>`. */
export const RELAY_AUTHORIZATION_VARIABLE = "FUSE_DECK_MCP_AUTHORIZATION";

/**
 * The variable that names a file the relay appends each MCP message to, as `outgoing` (to the
 * backend) or `incoming`, a tab and the JSON line. Unset, the relay logs nothing. It logs message
 * bodies only, never the token.
 */
export const RELAY_LOG_VARIABLE = "FUSE_DECK_MCP_LOG";
