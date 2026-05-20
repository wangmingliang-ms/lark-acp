/**
 * Storage backend factory.
 */

import { FileStorageBackend } from "./file.js";
import { PostgresStorageBackend } from "./postgres.js";
import type { StorageBackend } from "./types.js";

export type { SessionRecord, StorageBackend } from "./types.js";
export { FileStorageBackend } from "./file.js";
export { PostgresStorageBackend } from "./postgres.js";

export interface StorageConfig {
  backend: "file" | "postgres";
  /** Directory for file backend (default ~/.lark-acp). */
  dir?: string;
  /** Connection URL for postgres backend. */
  url?: string;
}

export function createStorageBackend(config: StorageConfig): StorageBackend {
  if (config.backend === "postgres") {
    if (!config.url) throw new Error("Postgres backend requires `storage.url`");
    return new PostgresStorageBackend(config.url);
  }
  return new FileStorageBackend(config.dir ?? "");
}
