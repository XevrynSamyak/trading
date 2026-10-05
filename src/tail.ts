import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/** Last lines of a possibly large file, reading only its end. */
export function tailLines(path: string, maxLines: number, maxBytes = 64 * 1024): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8").split("\n").filter(Boolean).slice(-maxLines);
}
