"use strict";

// 所有状态轮询共享一次检查，避免慢 Docker CLI 被多个页面反复启动。
function createDesktopHealth({ health, discover, now = Date.now, ttl = 2000 }) {
  let pending, cached, checkedAt = -Infinity;
  return function check() {
    if (pending) return pending;
    if (cached && now() - checkedAt < ttl) return Promise.resolve(cached);
    pending = (async () => {
      const environment = await health().catch(() => null);
      const result = environment?.ok && environment.desktopVersion
        ? { live: true, daemon: "已连接", imageReady: true, environment }
        : await discover();
      cached = result; checkedAt = now(); return result;
    })().finally(() => { pending = null; });
    return pending;
  };
}
module.exports = { createDesktopHealth };
