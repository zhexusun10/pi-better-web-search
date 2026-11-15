import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname } from "node:path";

/** Replace a small local file only after the new contents are fully written.
 * Failures leave the previous file untouched; configured symlinks keep pointing
 * at the same target. This is atomic replacement, not a read/modify/write lock. */
export function writeFileAtomically(path: string, contents: string): boolean {
  let temporary: string | undefined;
  try {
    let existing: Stats | undefined;
    try { existing = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const destination = existing?.isSymbolicLink() ? realpathSync(path) : path;
    if (existing && !existing.isSymbolicLink() && !existing.isFile()) return false;
    mkdirSync(dirname(destination), { recursive: true });
    const candidate = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const file = openSync(candidate, "wx", 0o600);
    temporary = candidate;
    try {
      writeFileSync(file, contents, "utf8");
      fsyncSync(file);
    } finally { closeSync(file); }
    renameSync(candidate, destination);
    return true;
  } catch { return false; }
  finally {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* Renamed or cleanup unavailable. */ }
    }
  }
}
