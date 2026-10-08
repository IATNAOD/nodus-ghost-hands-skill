// release.js - one release of the skill and the client with one version:
//   npm run release -- [patch | minor | major | 1.2.3] [--dry-run] [--skip-checks]
// 1. checks the repository: branch main, nothing uncommitted, not behind origin, no such tag;
// 2. runs the tests of the skill and the client (unless --skip-checks);
// 3. writes the version to package.json (root and client, with their lock files) and skill/skill.json;
// 4. commits "Release vX.Y.Z", tags vX.Y.Z and pushes both at once.
// The tag starts .github/workflows/release.yml: the skill ZIP and the client installer go
// into one GitHub release marked Latest, installed clients update from it.
// --dry-run only prints the plan.
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const BRANCH = "main";
const REMOTE = "origin";
// package.json files: the version is replaced in the text, the formatting stays
const MANIFESTS = ["package.json", "client/package.json", "skill/skill.json"];
// lock files are written by npm as JSON.stringify(…, null, 2): a round trip keeps them as they are
const LOCKS = ["package-lock.json", "client/package-lock.json"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const bump = args.find((arg) => !arg.startsWith("--")) ?? "patch";
const dryRun = flags.has("--dry-run");

for (const flag of flags) if (!["--dry-run", "--skip-checks"].includes(flag)) fail(`unknown option ${flag}`);

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const git = (...gitArgs) => {
  const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" });

  if (result.error) fail(`git: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${gitArgs.join(" ")}: ${(result.stderr || result.stdout).trim()}`);

  return result.stdout.trim();
};

// npm is npm.cmd on Windows: it starts only through a shell
const run = (command, commandArgs) => {
  console.log(`\n> ${command} ${commandArgs.join(" ")}`);

  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} failed: nothing was changed`);
};

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const versionOf = (file) => JSON.parse(read(file)).version;

const next = (current) => {
  const parts = SEMVER.exec(current)?.slice(1).map(Number);

  if (!parts) fail(`the current version "${current}" is not X.Y.Z`);
  if (SEMVER.test(bump)) {
    const wanted = bump.split(".").map(Number);
    const newer = wanted.findIndex((part, i) => part !== parts[i]);

    if (newer < 0 || wanted[newer] < parts[newer]) fail(`${bump} is not newer than ${current}`);
    return bump;
  }

  const [major, minor, patch] = parts;

  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      return fail(`expected patch, minor, major or X.Y.Z, got "${bump}"`);
  }
};

/** The first "version" of a manifest: the top-level one, before any dependencies. */
const setManifest = (file, version) => {
  const text = read(file);
  const updated = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);

  if (updated === text && versionOf(file) !== version) fail(`no "version" in ${file}`);
  fs.writeFileSync(path.join(root, file), updated);
};

const setLock = (file, version) => {
  const text = read(file);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lock = JSON.parse(text);

  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(lock, null, 2)}\n`.replace(/\n/g, eol));
};

/* ── 1. the repository ── */

const versions = Object.fromEntries(MANIFESTS.map((file) => [file, versionOf(file)]));
const current = versions["package.json"] ?? versions["client/package.json"];
const version = next(current);
const tag = `v${version}`;

if (new Set(Object.values(versions)).size > 1) {
  console.log(`versions differ now (${Object.entries(versions).map(([file, value]) => `${file} ${value}`).join(", ")}): all become ${version}`);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");

if (branch !== BRANCH) fail(`release from ${BRANCH}, not from ${branch}`);
if (git("status", "--porcelain")) fail("commit or stash the changes first (git status)");

git("fetch", "--quiet", "--tags", REMOTE);
if (Number(git("rev-list", "--count", `HEAD..${REMOTE}/${BRANCH}`)) > 0) fail(`${BRANCH} is behind ${REMOTE}: git pull first`);
if (git("tag", "--list", tag)) fail(`tag ${tag} exists already`);

console.log(`Ghost Hands ${current} → ${version} (tag ${tag})`);
console.log(`files: ${[...MANIFESTS, ...LOCKS].join(", ")}`);

if (dryRun) {
  console.log("dry run: nothing changed");
  process.exit(0);
}

/* ── 2. checks: a red release workflow would leave a tag on a broken commit ── */

if (!flags.has("--skip-checks")) {
  run("npm", ["test"]);
  run("npm", ["run", "check"]);
  run("npm", ["run", "routing:assert"]);
  run("npm", ["--prefix", "client", "run", "typecheck"]);
  run("npm", ["--prefix", "client", "test"]);
}

/* ── 3-4. version, commit, tag, push ── */

for (const file of MANIFESTS) setManifest(file, version);
for (const file of LOCKS) setLock(file, version);

git("add", "--", ...MANIFESTS, ...LOCKS);
git("commit", "--quiet", "-m", `Release ${tag}`);
git("tag", "-a", tag, "-m", `Ghost Hands ${version}`);
// both or nothing: a tag without its commit on main would build an unknown state
git("push", "--atomic", REMOTE, `HEAD:refs/heads/${BRANCH}`, `refs/tags/${tag}`);

const remoteUrl = git("remote", "get-url", REMOTE).replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");

console.log(`\n${tag} is pushed. The release builds here: ${remoteUrl}/actions`);
