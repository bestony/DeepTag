/**
 * Turning an untrusted identifier into a filesystem name.
 *
 * Chat ids and user open_ids arrive from the transport and are used to pick
 * directories and files. Neither may be used as a path segment as-is:
 * `../../etc` would walk straight out of whatever root it was joined to.
 *
 * Everything outside `[A-Za-z0-9_-]` is replaced, which incidentally collapses
 * `..` to `__`. That substitution is lossy, so a digest of the *original* value
 * is appended: two ids that reduce to the same slug still get separate names,
 * while the readable prefix keeps an `ls` of the directory meaningful.
 */

import { createHash } from "node:crypto";

/** How much of the original id survives into the name, in characters. */
const MAX_SLUG_LENGTH = 48;

export const safeName = (id: string): string => {
  const slug = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_SLUG_LENGTH);
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `${slug === "" ? "unnamed" : slug}-${digest}`;
};
