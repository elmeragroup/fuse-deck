/**
 * The built studio backend as a child process, launched the way Electron main launches it: the
 * launch document on stdin, which stays open, and `StudioReady` on stdout.
 */

import * as Schema from "effect/Schema";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { StudioReady } from "../src/contract/studio-launch.ts";

/** The built backend, which turbo builds before the tests. */
const BIN = fileURLToPath(new URL("../dist/server/bin.mjs", import.meta.url));

const decodeReady = Schema.decodeUnknownOption(Schema.fromJsonString(StudioReady));

/** A running backend. */
export type Backend = {
  /** The backend's address, `http://127.0.0.1:<port>/`. */
  readonly url: string;
  /** The bootstrap credential it was launched with. */
  readonly bootstrap: string;
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves with the exit code once the process exits. */
  readonly exited: Promise<number | null>;
  /** Everything it wrote to stderr so far. */
  readonly stderr: () => string;
  /** Resolves once its stderr matches `pattern`. */
  readonly stderrMatches: (pattern: RegExp) => Promise<void>;
  /** Close its stdin, as a parent that goes away does, and wait for it to exit. */
  readonly stop: () => Promise<number | null>;
};

/**
 * Launch the backend for a renderer at `origin`, with `userDataDirectory` for its settings.
 *
 * @returns The backend, once it printed `StudioReady`.
 */
export async function startBackend(origin: string, userDataDirectory: string): Promise<Backend> {
  const bootstrap = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const stderrMatches = (pattern: RegExp) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (pattern.test(stderr)) {
          child.stderr.off("data", check);
          resolve();
        }
      };
      child.stderr.on("data", check);
      check();
    });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
  child.stdin.write(`${JSON.stringify({ bootstrap, origin, userDataDirectory })}\n`);
  const url = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const ready = decodeReady(line);
      if (ready._tag === "Some") {
        resolve(ready.value.url);
      }
    });
    void exited.then((code) => {
      reject(new Error(`The backend exited with ${String(code)} before it was ready:\n${stderr}`));
    });
  });
  return {
    url,
    bootstrap,
    child,
    exited,
    stderr: () => stderr,
    stderrMatches,
    stop: () => {
      child.stdin.end();
      return exited;
    },
  };
}
