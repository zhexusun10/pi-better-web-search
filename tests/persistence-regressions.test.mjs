import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { getCachePath, readCache, writeCache } from "../lib/cache.ts";
import { getPreferencesPath, readProviderPreferences, writeProviderPreferences } from "../lib/preferences.ts";
import { withEnv, withTempCache } from "./helpers.mjs";

function mockFs(t, name, implementation) {
  const mock = t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

for (const [label, pathFor, read, write, original, updated] of [
  ["settings", getPreferencesPath, readProviderPreferences, writeProviderPreferences,
    { version: 1, search: "exa", apis: { keenable: false, keenableKeyRequired: true } },
    { version: 1, fetch: "deepseek", apis: { exa: true } }],
  ["cache", getCachePath, readCache, writeCache,
    { version: 1, fingerprint: "original", search: { provider: "exa", model: "search" } },
    { version: 1, fingerprint: "updated", fetch: { provider: "deepseek", model: "search-fetch" } }],
]) {
  test(`${label} preserves the previous file when writing fails after partial progress`, async t => {
    await withTempCache(({ directory }) => {
      assert.equal(write(original), true);
      const before = fs.readFileSync(pathFor(), "utf8");
      const writeFile = fs.writeFileSync;
      mockFs(t, "writeFileSync", (target, _contents, options) => {
        writeFile(target, '{"version":', options);
        throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
      });
      assert.equal(write(updated), false);
      assert.equal(fs.readFileSync(pathFor(), "utf8"), before);
      assert.deepEqual(read(), original);
      assert.equal(fs.readdirSync(directory).some(name => name.endsWith(".tmp")), false);
    });
  });

  test(`${label} preserves the previous file and removes temporary files when replacement fails`, async t => {
    await withTempCache(({ directory }) => {
      assert.equal(write(original), true);
      const before = fs.readFileSync(pathFor(), "utf8");
      mockFs(t, "renameSync", () => { throw Object.assign(new Error("simulated rename failure"), { code: "EACCES" }); });
      assert.equal(write(updated), false);
      assert.equal(fs.readFileSync(pathFor(), "utf8"), before);
      assert.equal(fs.readdirSync(directory).some(name => name.endsWith(".tmp")), false);
    });
  });

  test(`${label} does not leave a partial first-time file when writing fails`, async t => {
    await withTempCache(({ directory }) => {
      const writeFile = fs.writeFileSync;
      mockFs(t, "writeFileSync", (target, _contents, options) => {
        writeFile(target, '{"version":', options);
        throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
      });
      assert.equal(write(updated), false);
      assert.equal(fs.existsSync(pathFor()), false);
      assert.deepEqual(fs.readdirSync(directory), []);
    });
  });

  test(`${label} resolves a simulated file symlink without changing the link path`, async t => {
    await withTempCache(({ directory }) => {
      const link = pathFor();
      const target = join(directory, "resolved-target.json");
      const marker = "simulated symlink: leave this path untouched";
      fs.writeFileSync(link, marker);
      fs.writeFileSync(target, JSON.stringify(original));
      const lstat = fs.lstatSync;
      const realpath = fs.realpathSync;
      mockFs(t, "lstatSync", (path, ...args) => path === link
        ? { isSymbolicLink: () => true, isFile: () => false }
        : lstat(path, ...args));
      mockFs(t, "realpathSync", (path, ...args) => path === link ? target : realpath(path, ...args));
      assert.equal(write(updated), true);
      assert.equal(fs.readFileSync(link, "utf8"), marker);
      assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), updated);
      assert.equal(fs.readdirSync(directory).some(name => name.endsWith(".tmp")), false);
    });
  });

  test(`${label} refuses an unresolved simulated symlink instead of replacing it`, async t => {
    await withTempCache(({ directory }) => {
      const link = pathFor();
      const marker = "simulated dangling symlink: leave intact";
      fs.writeFileSync(link, marker);
      const lstat = fs.lstatSync;
      const realpath = fs.realpathSync;
      mockFs(t, "lstatSync", (path, ...args) => path === link
        ? { isSymbolicLink: () => true, isFile: () => false }
        : lstat(path, ...args));
      mockFs(t, "realpathSync", (path, ...args) => {
        if (path === link) throw Object.assign(new Error("missing symlink target"), { code: "ENOENT" });
        return realpath(path, ...args);
      });
      assert.equal(write(updated), false);
      assert.equal(fs.readFileSync(link, "utf8"), marker);
      assert.equal(fs.readdirSync(directory).some(name => name.endsWith(".tmp")), false);
    });
  });

  test(`${label} continues to update a configured symbolic-link target without replacing the link`, async t => {
    await withTempCache(({ directory }) => {
      const target = join(directory, "target.json");
      const link = join(directory, "linked.json");
      fs.writeFileSync(target, JSON.stringify(original));
      try { fs.symlinkSync(target, link, "file"); }
      catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip(`file symlinks unavailable: ${error.code}`); return; }
        throw error;
      }
      const variable = label === "settings" ? "PI_BETTER_WEB_SEARCH_SETTINGS" : "PI_BETTER_WEB_SEARCH_CACHE";
      return withEnv({ [variable]: link }, () => {
        assert.equal(write(updated), true);
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), updated);
      });
    });
  });
}
