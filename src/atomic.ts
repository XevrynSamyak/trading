import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Crash-safe JSON files: write a temp file, keep the previous version as
 * `.bak`, then rename. A crash at any point leaves either the new file, the
 * old file, or the backup readable — never a half-written file in their place.
 */
export function writeJsonAtomic(path: string, value: unknown, opts: { backup?: boolean; pretty?: boolean } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, opts.pretty ? 2 : undefined));
  if (opts.backup && existsSync(path)) renameSync(path, `${path}.bak`);
  renameSync(tmp, path);
}

/** Reads JSON, falling back to the `.bak` copy if the main file is missing or corrupt. */
export function readJsonWithBackup<T>(path: string): { value: T; fromBackup: boolean } | null {
  for (const [p, fromBackup] of [
    [path, false],
    [`${path}.bak`, true],
  ] as const) {
    if (!existsSync(p)) continue;
    try {
      return { value: JSON.parse(readFileSync(p, "utf8")) as T, fromBackup };
    } catch {
      // corrupt: try the next one
    }
  }
  return null;
}
