"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createUpdater } = require("../lib/updater");
const unavailable = async () => ({ ok: false });

test("更新实际仓库后区分磁盘代码与旧进程；同版本的新提交也要求重启", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-update-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "remote.git"), source = path.join(dir, "source"), app = path.join(dir, "app");
  fs.mkdirSync(source);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git(dir, "init", "--bare", remote); git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.com");
  const commit = version => {
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version }));
    git(source, "add", "."); git(source, "commit", "-m", "release " + version);
  };
  commit("1.1.0"); git(source, "remote", "add", "origin", remote); git(source, "push", "origin", "main");
  git(dir, "clone", "--branch", "main", remote, app);
  const old = createUpdater({ dir: app, repo: "fixture/repo", getJson: unavailable });
  commit("1.5.0"); git(source, "push", "origin", "main");
  let state = await old.check();
  assert.equal(state.local.version, "1.1.0"); assert.equal(state.behind, 1); assert.equal(state.updateAvailable, true);
  const result = await old.apply();
  assert.equal(result.ok, true); assert.equal(result.version, "1.5.0"); assert.equal(result.restartRequired, true);
  state = await old.check();
  assert.equal(state.local.version, "1.5.0"); assert.equal(state.runtime.version, "1.1.0");
  assert.equal(state.updateAvailable, false); assert.equal(state.restartRequired, true);
  const fresh = createUpdater({ dir: app, repo: "fixture/repo", getJson: unavailable });
  assert.equal((await fresh.check()).restartRequired, false);
  fs.writeFileSync(path.join(source, "fix.txt"), "same-version fix");
  git(source, "add", "."); git(source, "commit", "-m", "fix without version bump"); git(source, "push", "origin", "main");
  assert.equal((await fresh.apply()).restartRequired, true);
});

test("离线更新检查不能报告已是最新；GitHub比较不会把本地领先当远端更新", async () => {
  const run = async args => args[0] === "rev-parse" ? { ok: true, out: "a".repeat(40) } :
    args[0] === "status" ? { ok: true, out: "" } : { ok: false, out: "" };
  const options = { dir: __dirname, repo: "fixture/repo", runtimeVersion: "1.5.0", runtimeSha: "a".repeat(40), run };
  const offline = await createUpdater({ ...options, getJson: unavailable }).check();
  assert.equal(offline.checked, false); assert.equal(offline.updateAvailable, null);
  const localAhead = await createUpdater({ ...options, getJson: async () => ({ ok: true, data: { status: "behind", ahead_by: 0, behind_by: 2, commits: [] } }) }).check();
  assert.equal(localAhead.checked, true); assert.equal(localAhead.updateAvailable, false); assert.equal(localAhead.ahead, 2);
});

test("ZIP安装离线状态明确；无法检查工作区时拒绝拉取", async () => {
  const zip = await createUpdater({ dir: __dirname, repo: "fixture/repo", runtimeVersion: "1.5.0", runtimeSha: null,
    run: async () => ({ ok: false, out: "" }), getJson: unavailable }).check();
  assert.equal(zip.mode, "download"); assert.equal(zip.checked, false); assert.equal(zip.updateAvailable, null);
  let pulls = 0;
  const updater = createUpdater({ dir: __dirname, repo: "fixture/repo", runtimeSha: null, getJson: unavailable,
    run: async args => { if (args[0] === "pull") pulls++; return { ok: args[0] === "rev-parse", out: "a".repeat(40) }; } });
  assert.equal((await updater.apply()).ok, false); assert.equal(pulls, 0);
});
