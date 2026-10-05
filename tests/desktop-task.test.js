"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { pruneShots, plannerContext, recordResult, repeatedAction } = require("../lib/desktop-task");

test("跨过第10和20步时保留当前截图与最近两张，不误删同目录其他任务", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-shots-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "dt-other-1.png"), "other");
  for (let step = 1; step <= 21; step++) {
    const current = `dt-test-${step}.png`; fs.writeFileSync(path.join(dir, current), "current");
    pruneShots(dir, "dt-test", current);
    assert.equal(fs.readFileSync(path.join(dir, current), "utf8"), "current");
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith("dt-test-")).sort(), Array.from({ length: Math.min(step, 3) }, (_, i) => `dt-test-${step-i}.png`).sort());
  }
  assert.equal(fs.existsSync(path.join(dir, "dt-other-1.png")), true);
});
test("读页和标签页结果进入下一轮规划，凭证填入值不进历史", () => {
  const t = { evidence: [{ title: "配置", url: "https://example.com", text: "限制：Gemini API" }] };
  const obs = { url: "https://example.com", text: "菜单：API 密钥" };
  recordResult(t, { op: "read", args: {} }, { ok: true, text: "当前只存在 Jay 密钥" }, obs);
  recordResult(t, { op: "tablist", args: {} }, { ok: true, tabs: [{ n: 2, title: "凭据" }] }, obs);
  recordResult(t, { op: "fill", args: { n: 1, secret: "account", text: "private-value" } }, { ok: true, filled: { text: "private-value" } }, obs);
  const context = plannerContext(t, obs);
  assert.match(context, /API 密钥/); assert.match(context, /Jay 密钥/); assert.match(context, /凭据/); assert.match(context, /Gemini API/);
  assert.doesNotMatch(context, /private-value/);
});
test("无进展时不重复点击；页面变化后可以继续同名操作", () => {
  const t = {}, act = { op: "click", args: { n: 1 } }, obs = { url: "https://example.com", text: "创建凭证" };
  recordResult(t, act, { ok: true }, obs); recordResult(t, act, { ok: true }, obs);
  assert.equal(repeatedAction(t, act, obs), true);
  assert.equal(repeatedAction(t, act, { ...obs, text: "请选择 API 密钥" }), false);
});
