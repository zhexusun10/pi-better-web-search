import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const LOGIN_PROVIDERS = ["deepseek", "exa", "keenable", "perplexity"] as const;
export type LoginProvider = typeof LOGIN_PROVIDERS[number];
export const LOGIN_LABELS: Record<LoginProvider, string> = {
  deepseek: "DeepSeek", exa: "Exa", keenable: "Keenable", perplexity: "Perplexity",
};
type KeyStore = { version: 1; keys: Partial<Record<LoginProvider, string>> };

export function getCredentialsPath(): string {
  return process.env.PI_BETTER_WEB_SEARCH_AUTH?.trim() || join(getAgentDir(), "better-web-search-auth.json");
}

export function isValidApiKey(key: string): boolean {
  return key.length > 0 && key.length <= 8192 && !/[^\x21-\x7e]/.test(key);
}

function decodeStore(text: string): KeyStore {
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid credential storage");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !record.keys || typeof record.keys !== "object" || Array.isArray(record.keys)) {
    throw new Error("Invalid credential storage");
  }
  const source = record.keys as Record<string, unknown>;
  const keys: KeyStore["keys"] = {};
  for (const provider of LOGIN_PROVIDERS) {
    const value = source[provider];
    if (value !== undefined) {
      if (typeof value !== "string" || !isValidApiKey(value)) throw new Error("Invalid credential storage");
      keys[provider] = value;
    }
  }
  return { version: 1, keys };
}

/** Literal API keys only: never execute shell expressions or config expansion. */
export function savedApiKey(provider: LoginProvider): string | undefined {
  try { return decodeStore(readFileSync(getCredentialsPath(), "utf8")).keys[provider]; }
  catch { return undefined; }
}

/** Atomic replacement under a cross-process lock. A corrupt store is never
 * overwritten. Permissions are 0600 (new parent 0700); this is not encryption. */
async function changeKey(provider: LoginProvider, key: string | undefined): Promise<boolean> {
  if (!LOGIN_PROVIDERS.includes(provider) || (key !== undefined && !isValidApiKey(key))) return false;
  const path = getCredentialsPath();
  const lockPath = `${path}.lock`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 80; attempt++) {
      try { lock = await open(lockPath, "wx", 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await delay(25);
      }
    }
    if (!lock) return false;
    let store: KeyStore;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      store = decodeStore(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      store = { version: 1, keys: {} };
    }
    if (key === undefined) delete store.keys[provider];
    else store.keys[provider] = key;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(store, null, 2), "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    return true;
  } catch { return false; }
  finally {
    await unlink(temporary).catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }
}

export function saveApiKey(provider: LoginProvider, key: string): Promise<boolean> {
  return changeKey(provider, key.trim());
}

export function removeApiKey(provider: LoginProvider): Promise<boolean> {
  return changeKey(provider, undefined);
}
