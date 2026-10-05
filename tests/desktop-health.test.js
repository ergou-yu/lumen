"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createDesktopHealth } = require("../lib/desktop-health");
test("正在运行的虚拟机以 HTTP 健康为准，不被 Docker CLI 超时误报停止", async () => {
  let dockerCalls = 0;
  const check = createDesktopHealth({ health: async () => ({ ok: true, browser: true, desktopVersion: 3 }), discover: async () => { dockerCalls++; throw new Error("slow Docker CLI"); } });
  const result = await check(); assert.equal(result.live, true); assert.equal(result.imageReady, true); assert.equal(dockerCalls, 0);
});
test("并发状态请求共享检查并短暂缓存，健康失效后重新发现 Docker", async () => {
  let resolve, clock = 0, calls = 0, discoveries = 0;
  const check = createDesktopHealth({ now: () => clock, health: () => { calls++; return new Promise(r => { resolve = r; }); }, discover: async () => { discoveries++; return { live: false, daemon: null }; } });
  const first = check(), other = check(); assert.equal(calls, 1);
  resolve({ ok: true, desktopVersion: 3 }); assert.equal((await first).live, true); assert.deepEqual(await other, await check());
  assert.equal(calls, 1); clock = 3000;
  const refreshed = check(); resolve(null); assert.equal((await refreshed).live, false); assert.equal(discoveries, 1);
});
