"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");

const REVISION_LABEL = "io.lumen.desktop.revision";
const IMAGE_FILES = ["Dockerfile", "box-server.js", "entrypoint.sh", "desktop-theme.js", "appearance.py",
  "assets/lumi-avatar.png", "assets/lumi-oat-rose-wallpaper.png"];
function desktopRevision(dir) {
  const hash = crypto.createHash("sha256");
  for (const file of IMAGE_FILES) hash.update(file + "\0").update(fs.readFileSync(path.join(dir, file))).update("\0");
  return hash.digest("hex");
}
async function inspectDesktop(run, name) {
  const r = await run("docker", ["inspect", "--type", "container", name, "--format", "{{json .}}"], 15000);
  if (!r.ok) return null;
  const info = JSON.parse(r.out);
  return { name, running: !!info.State?.Running, revision: info.Config?.Labels?.[REVISION_LABEL],
    binds: info.HostConfig?.Binds || [] };
}
function belongsToWorkspace(container, downloads) {
  // Docker Desktop 会把 Mac 的宿主路径记录为 /host_mnt/...；Windows 的盘符也会转成 /c/...。
  const canonical = value => value.replace(/\\/g, "/").replace(/^\/host_mnt(?=\/)/, "")
    .replace(/^([a-z]):\//i, (_, drive) => "/" + drive.toLowerCase() + "/");
  const bind = canonical(downloads) + ":/home/node/Downloads";
  return !!container && container.binds.some(value => {
    const actual = canonical(value);
    return actual === bind || actual.startsWith(bind + ":");
  });
}

// 构建完成后才替换旧容器。旧容器留作备份；失败时恢复，home 卷始终复用。
async function ensureDesktop({ run, build, ready, image, name, downloads, revision, args }) {
  const old = await inspectDesktop(run, name);
  if (old && !belongsToWorkspace(old, downloads)) return { ok: false, error: "已有其他工作区的 LumenBox 桌面，请先在该工作区停止它。" };
  if (old?.revision === revision) {
    if (!old.running) {
      const started = await run("docker", ["start", name], 30000);
      if (!started.ok) return { ok: false, error: "桌面启动失败：" + started.err };
    }
    return ready();
  }
  const imageRevision = await run("docker", ["image", "inspect", image, "--format", '{{index .Config.Labels "' + REVISION_LABEL + '"}}'], 15000);
  if (!imageRevision.ok || imageRevision.out.trim() !== revision) {
    const built = await build();
    if (!built.ok) return { ok: false, error: "桌面镜像构建失败，原桌面已保留：\n" + built.err };
  }
  let backup = null;
  if (old) {
    if (old.running) {
      const stopped = await run("docker", ["stop", name], 60000);
      if (!stopped.ok) return { ok: false, error: "无法停止旧桌面：" + stopped.err };
    }
    backup = name + "-previous-" + Date.now();
    const renamed = await run("docker", ["rename", name, backup], 15000);
    if (!renamed.ok) {
      if (old.running) await run("docker", ["start", name], 30000);
      return { ok: false, error: "无法保存旧桌面备份：" + renamed.err };
    }
  }
  let result;
  try {
    const started = await run("docker", ["run", "-d", "--name", name, ...args, image], 60000);
    result = started.ok ? await ready() : { ok: false, error: "桌面启动失败：" + started.err };
  } catch (e) { result = { ok: false, error: e.message }; }
  if (!result.ok && backup) {
    // 只清理由本次升级创建的新容器，不删除卷或原桌面的可写层。
    await run("docker", ["rm", "-f", name], 30000);
    const restored = await run("docker", ["rename", backup, name], 15000);
    const restarted = restored.ok && (!old.running || (await run("docker", ["start", name], 30000)).ok);
    result.error += restarted ? "（已恢复原桌面）" : "（原桌面保存在 " + backup + "，恢复未完成）";
  }
  return result;
}
module.exports = { REVISION_LABEL, IMAGE_FILES, desktopRevision, inspectDesktop, belongsToWorkspace, ensureDesktop };
