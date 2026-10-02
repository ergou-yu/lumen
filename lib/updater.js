"use strict";
const fs = require("node:fs"), path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");

function createUpdater({ dir, repo, branch = "main", getJson, run, runtimeVersion, runtimeSha }) {
  if (!/^[\w][\w./-]*$/.test(branch) || branch.includes("..")) throw new Error("更新分支非法");
  const version = () => {
    try { return String(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || "?"); }
    catch (_) { return "?"; }
  };
  const startedVersion = runtimeVersion || version();
  let startedSha = runtimeSha;
  if (startedSha === undefined) {
    try { startedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
    catch (_) { startedSha = null; }
  }
  const git = run || ((args, timeout = 8000) => new Promise(resolve => {
    execFile("git", args, { cwd: dir, timeout, maxBuffer: 512 * 1024 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || "") }));
  }));
  let checking = null, applying = null;
  const withRuntime = r => {
    r.runtime = { version: startedVersion, sha: startedSha ? startedSha.slice(0, 12) : null };
    r.restartRequired = r.local.version !== startedVersion || !!(startedSha && r.local.sha && !startedSha.startsWith(r.local.sha));
    return r;
  };
  async function inspect() {
    const r = { repo, branch, local: { version: version(), sha: null }, mode: "git", checked: false,
      updateAvailable: null, behind: 0, ahead: 0, commits: [], note: "", dirty: false };
    const head = await git(["rev-parse", "HEAD"]);
    if (!head.ok) {
      r.mode = "download";
      r.note = "当前目录不是 git 克隆；请下载新版。";
      const raw = await getJson("https://raw.githubusercontent.com/" + repo + "/" + branch + "/package.json");
      if (raw.ok && typeof raw.data?.version === "string") {
        r.remoteVersion = raw.data.version; r.checked = true; r.updateAvailable = r.remoteVersion !== r.local.version;
      } else r.note += " 远端版本获取失败，暂时无法确认是否有更新。";
      return withRuntime(r);
    }
    r.local.sha = head.out.trim().slice(0, 12);
    const st = await git(["status", "--porcelain"]);
    r.dirty = st.ok && !!st.out.trim();
    const ref = "refs/remotes/origin/" + branch;
    const fetched = await git(["fetch", "--quiet", "origin", "+refs/heads/" + branch + ":" + ref], 30000);
    if (fetched.ok) {
      const count = await git(["rev-list", "--left-right", "--count", "HEAD..." + ref]);
      const counts = count.out.trim().match(/^(\d+)\s+(\d+)$/);
      if (count.ok && counts) {
        r.ahead = Number(counts[1]); r.behind = Number(counts[2]); r.checked = true; r.updateAvailable = r.behind > 0;
        if (r.behind) {
          const log = await git(["log", "--format=%s", "-n", "30", "HEAD.." + ref]);
          if (log.ok) r.commits = log.out.split("\n").filter(Boolean);
        }
        if (r.ahead && r.behind) r.note = "本地和远端均有新提交，一键更新不能自动合并；请先处理分支差异。";
        else if (r.ahead) r.note = "本地包含尚未在远端的提交。";
        return withRuntime(r);
      }
    }
    r.mode = "git-api";
    const api = await getJson("https://api.github.com/repos/" + repo + "/compare/" + head.out.trim() + "..." + encodeURIComponent(branch));
    if (api.ok && ["ahead", "behind", "identical", "diverged"].includes(api.data?.status)) {
      r.checked = true; r.behind = Number(api.data.ahead_by) || 0; r.ahead = Number(api.data.behind_by) || 0;
      r.updateAvailable = r.behind > 0;
      r.commits = (api.data.commits || []).slice(0, 30).map(c => String(c.commit?.message || "").split("\n")[0]).filter(Boolean);
      r.note = "git fetch 未完成，已用 GitHub API 比较。";
    } else r.note = "git fetch 和 GitHub API 检查均未完成，暂时无法确认是否有更新。";
    return withRuntime(r);
  }
  function check() {
    if (!checking) checking = inspect().finally(() => { checking = null; });
    return checking;
  }
  async function pull() {
    if (checking) await checking;
    const head = await git(["rev-parse", "HEAD"]);
    if (!head.ok) return { ok: false, error: "当前目录不是 git 克隆，请重新下载新版。" };
    const st = await git(["status", "--porcelain"]);
    if (!st.ok) return { ok: false, error: "无法检查本地改动，已拒绝更新。" };
    if (st.out.trim()) return { ok: false, error: "本地有未提交改动，已拒绝更新。请先提交或妥善保存改动。", dirty: st.out.trim().split("\n").slice(0, 5) };
    const result = await git(["pull", "--ff-only", "--quiet", "origin", branch], 120000);
    if (!result.ok) return { ok: false, error: "git pull 未完成。请检查网络、仓库权限或分支差异后重试。" };
    const after = await git(["rev-parse", "HEAD"]);
    const state = withRuntime({ local: { version: version(), sha: after.ok ? after.out.trim().slice(0, 12) : null } });
    return { ok: true, nowAt: state.local.sha, version: state.local.version, runtime: state.runtime, restartRequired: state.restartRequired,
      note: state.restartRequired ? "代码已更新，服务桥仍在运行旧代码。请重启服务桥，然后刷新网页。" : "代码和当前服务均已是这一版本，无需重启。" };
  }
  function apply() {
    if (!applying) applying = pull().finally(() => { applying = null; });
    return applying;
  }
  return { check, apply };
}
module.exports = { createUpdater };
