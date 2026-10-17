#!/usr/bin/env node
/**
 * Build the npm tarball in dist/ without publishing.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const npmExecPath = process.env.npm_execpath;
const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmExecPath
  ? [npmExecPath, "pack", "--pack-destination", dist]
  : ["pack", "--pack-destination", dist];
const result = spawnSync(command, args, {
  cwd: root,
  stdio: "inherit",
  shell: npmExecPath ? false : process.platform === "win32",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
