#!/usr/bin/env node
/**
 * Verify the npm tarball contents without publishing.
 *
 * Uses `npm pack --dry-run --json` so the same npm file-selection rules apply.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env.npm_execpath;
const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmExecPath
  ? [npmExecPath, "pack", "--dry-run", "--json"]
  : ["pack", "--dry-run", "--json"];
const result = spawnSync(command, args, {
  cwd: root,
  encoding: "utf8",
  shell: npmExecPath ? false : process.platform === "win32",
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`npm pack --dry-run failed:\n${result.stderr || result.stdout}`);
}

const stdout = result.stdout ?? "";
let parsed;
try {
  parsed = JSON.parse(stdout);
} catch {
  // Older npm versions may surround the JSON with notices on stdout.
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`Could not find npm pack JSON output:\n${stdout}\n${result.stderr}`);
  }
  parsed = JSON.parse(stdout.slice(start, end + 1));
}

// npm 12 returns an object keyed by package name; older npm returns an array.
const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
if (!pack || !Array.isArray(pack.files)) {
  throw new Error(`Unexpected npm pack output:\n${stdout}`);
}

const paths = pack.files.map((file) => String(file.path).replace(/\\/g, "/"));
const pathSet = new Set(paths);
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "extensions/index.ts",
  "lib/format.ts",
  "lib/truncate-json.ts",
  "lib/search.ts",
  "lib/candidates.ts",
  "lib/providers/deepseek.ts",
  "lib/providers/openai.ts",
  "lib/providers/anthropic.ts",
  "lib/providers/google.ts",
  "lib/providers/ollama.ts",
  "docs/README.zh-CN.md",
  "docs/architecture.md",
  "docs/providers.md",
  "docs/testing.md",
  "docs/publishing.md",
  "assets/architecture.svg",
];
const missing = required.filter((path) => !pathSet.has(path));
if (missing.length > 0) {
  throw new Error(`Package is missing required files:\n- ${missing.join("\n- ")}`);
}

const forbidden = [
  /^src\//,
  /^tests\//,
  /^scripts\//,
  /^\.github\//,
  /^node_modules\//,
  /^pi-web-search\//,
  /^DESIGN\.md$/,
  /^\.env/,
  /\.tgz$/,
];
const leaked = paths.filter((path) => forbidden.some((pattern) => pattern.test(path)));
if (leaked.length > 0) {
  throw new Error(`Package contains files that should not be published:\n- ${leaked.join("\n- ")}`);
}

console.log(
  `PASS: ${pack.filename} contains ${pack.entryCount} files (${pack.size} bytes); package contents are restricted to runtime sources, docs, assets, and metadata.`,
);
