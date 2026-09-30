#!/usr/bin/env node
/* ============================================================
   box-server.js —— LumenBox 容器内控制服务（零依赖 Node）
   只监听容器网络，由宿主服务桥经 docker 端口映射（127.0.0.1）调用。
   职责（浏览器防护原则）：
   · /observe  提供「无障碍树式」的交互元素清单（坐标+文本），不给原始 DOM/JS 执行
   · /act      真实 GUI 输入注入（xdotool 鼠标/键盘），动作可见、可录像
   · /screen   桌面截图（供宿主存档与 UI 展示）
   · /secret-type  凭证直填：值由宿主 Sentinel 获批后送入，只进键盘事件，
                   不回显、不写日志、不进任何模型上下文（对标 hatch-authd 出口替换）
   容器内没有审批逻辑、没有凭证存储——Sentinel 在宿主上。
   ============================================================ */
"use strict";

const http = require("http");
const { execFile, spawn } = require("child_process");

const PORT = parseInt(process.env.BOX_PORT || "3900", 10);
const DISPLAY = process.env.DISPLAY || ":0";
const CDP_HTTP = "http://127.0.0.1:9222";
const ACT_TIMEOUT = 15000;

/* ---------- 小工具 ---------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error("body 超限")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      env: Object.assign({}, process.env, { DISPLAY }),
      timeout: timeoutMs || ACT_TIMEOUT,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || err && err.message || "") });
    });
  });
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 5000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("CDP HTTP 超时")));
    req.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- CDP 客户端（观察 / 导航 / 读正文） ---------- */

let ws = null;          // 当前附着的 page WebSocket
let wsUrl = null;
let msgId = 0;
const pending = new Map();

function wsSend(method, params) {
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error("CDP 会话未建立"));
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP 调用超时: " + method)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function cdpPages() {
  const list = await httpGetJson(CDP_HTTP + "/json/list");
  return (list || []).filter((t) => t.type === "page" && t.webSocketDebuggerUrl && !/^devtools:/i.test(t.url));
}

async function cdpAttach(pageIndex) {
  const pages = await cdpPages();
  if (!pages.length) throw new Error("没有可用的浏览器标签页");
  const target = pages[Math.max(0, Math.min(pageIndex || 0, pages.length - 1))];
  if (ws && wsUrl === target.webSocketDebuggerUrl && ws.readyState === 1) return { pages, target };
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  await new Promise((resolve, reject) => {
    ws = new WebSocket(target.webSocketDebuggerUrl);
    wsUrl = target.webSocketDebuggerUrl;
    const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP 连接失败")); };
    ws.onclose = () => { ws = null; wsUrl = null; };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error.message || "CDP 错误"));
        else p.resolve(m.result);
      }
    };
  });
  return { pages, target };
}

// 页面内提取「可交互元素清单」（无障碍树式：角色/文本/坐标），不回传原始 HTML
const OBSERVE_JS = `(() => {
  const out = [];
  const sel = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[contenteditable="true"]';
  const walk = document.querySelectorAll(sel);
  const vh = window.innerHeight, vw = window.innerWidth;
  for (const el of walk) {
    if (out.length >= 60) break;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || +st.opacity === 0) continue;
    const text = String(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    const label = (el.labels && el.labels[0] && el.labels[0].innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      role: el.getAttribute("role") || "",
      text: text || label,
      id: el.id || "",
      name: el.getAttribute("name") || "",
      placeholder: el.getAttribute("placeholder") || "",
      sensitive: (el.getAttribute("type") === "password") || /password|passwd|secret/i.test(el.getAttribute("name") || "") ,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    pageH: document.documentElement.scrollHeight,
    viewH: vh,
    // 屏幕坐标换算：窗口位置 + 浏览器边框高度（xdotool 用屏幕坐标系）
    sx: Math.round(window.screenX),
    sy: Math.round(window.screenY),
    chromeH: Math.max(0, Math.round(window.outerHeight - window.innerHeight)),
    elements: out,
  });
})()`;

// 视口在屏幕上的真实原点：X11 客户端窗口根坐标（含 WM 边框位移）+ 浏览器 chrome 高度。
// window.screenX/Y 不含窗口管理器画的标题栏，直接用会点偏一个标题栏的高度。
async function viewportOrigin(chromeH) {
  const r = await run("sh", ["-c",
    "W=$(xdotool search --onlyvisible --class chromium | head -1); " +
    'if [ -n "$W" ]; then xdotool getwindowgeometry --shell "$W" | grep -E "^(X|Y)=" | tr "\\n" " "; fi']);
  const m = r.out.match(/X=(-?\d+)\s+Y=(-?\d+)/);
  const x = m ? parseInt(m[1], 10) : 0;
  const y = m ? parseInt(m[2], 10) : 0;
  return { x: x, y: y + (chromeH || 0) };
}

async function observe(max) {
  await cdpAttach(0);
  const r = await wsSend("Runtime.evaluate", { expression: OBSERVE_JS, returnByValue: true });
  const data = JSON.parse(r.result.value || "{}");
  const limit = Math.min(Math.max(parseInt(max, 10) || 40, 10), 60);
  // 双坐标系：vx/vy = 视口坐标（CDP Input 用）；x/y = 屏幕坐标（展示/xdotool 用）
  const origin = await viewportOrigin(data.chromeH);
  data.elements = (data.elements || []).slice(0, limit).map((el, i) => Object.assign({
    n: i + 1,
    vx: el.x || 0, vy: el.y || 0,
    x: (el.x || 0) + origin.x,
    y: (el.y || 0) + origin.y,
  }, el));
  lastObserve = { ts: Date.now(), elements: data.elements };
  return data;
}

let lastObserve = null;

async function readPage() {
  await cdpAttach(0);
  const r = await wsSend("Runtime.evaluate", {
    expression: `JSON.stringify({url: location.href, title: document.title, text: (document.body.innerText||"").slice(0, 9000)})`,
    returnByValue: true,
  });
  return JSON.parse(r.result.value || "{}");
}

/* ---------- 输入注入 ---------- */
// 点击/输入走 CDP Input 域：注入浏览器可信输入事件（视口坐标），对合成鼠标事件免疫坐标误差；
// 组合键与特殊键走 xdotool（浏览器 UI 层键盘事件对其响应正常）。
async function cdpClick(el) {
  await wsSend("Input.dispatchMouseEvent", { type: "mousePressed", x: el.vx, y: el.vy, button: "left", clickCount: 1 });
  await wsSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: el.vx, y: el.vy, button: "left", clickCount: 1 });
  await sleep(350);
}

async function cdpInsertText(text) {
  await wsSend("Input.insertText", { text: String(text).slice(0, 2000) });
  await sleep(200);
}

function elementByN(n) {
  const els = (lastObserve && lastObserve.elements) || [];
  const i = parseInt(n, 10);
  if (!(i >= 1 && i <= els.length)) return null;
  return els[i - 1];
}

async function guiClick(el) {
  const r = await run("xdotool", ["mousemove", "--sync", String(el.x), String(el.y)]);
  if (!r.ok) throw new Error("鼠标移动失败：" + r.err);
  const c = await run("xdotool", ["click", "1"]);
  if (!c.ok) throw new Error("点击失败：" + c.err);
  await sleep(350);
}

async function guiType(text) {
  const r = await run("xdotool", ["type", "--clearmodifiers", "--delay", "30", "--", String(text).slice(0, 2000)]);
  if (!r.ok) throw new Error("键入失败：" + r.err);
  await sleep(250);
}

async function actOn(body) {
  const op = String(body.op || "");
  const args = body.args || {};
  switch (op) {
    case "navigate": {
      const url = String(args.url || "");
      if (!/^https?:\/\//i.test(url)) throw new Error("仅允许 http(s) 地址");
      await cdpAttach(0);
      await wsSend("Page.navigate", { url });
      await sleep(1200);
      return { ok: true, note: "已导航" };
    }
    case "click": {
      const el = elementByN(args.n);
      if (!el) throw new Error("没有第 " + args.n + " 个元素，请先 observe");
      await cdpClick(el);
      await sleep(500);
      return { ok: true, clicked: { n: el.n, text: el.text, x: el.x, y: el.y } };
    }
    case "fill": {
      const el = elementByN(args.n);
      if (!el) throw new Error("没有第 " + args.n + " 个元素，请先 observe");
      await cdpClick(el);
      await run("xdotool", ["key", "--clearmodifiers", "ctrl+a"]);
      await run("xdotool", ["key", "Delete"]);
      await cdpInsertText(args.text);
      return { ok: true, filled: { n: el.n, text: String(args.text || "").slice(0, 40) } };
    }
    case "secret-type": {
      // 值由宿主 Sentinel 获批后直接注入键盘事件；本服务不回显、不落日志
      const el = elementByN(args.n);
      if (!el) throw new Error("没有第 " + args.n + " 个元素，请先 observe");
      if (typeof args.value !== "string" || !args.value) throw new Error("value 缺失");
      await cdpClick(el);
      await run("xdotool", ["key", "--clearmodifiers", "ctrl+a"]);
      await run("xdotool", ["key", "Delete"]);
      await cdpInsertText(args.value);
      return { ok: true, secretTyped: { n: el.n } }; // 响应里绝无 value
    }
    case "key": {
      const k = String(args.key || "");
      if (!/^[a-z0-9_+\-]+$/i.test(k)) throw new Error("按键名非法");
      const r = await run("xdotool", ["key", "--", k]);
      await sleep(400);
      return { ok: r.ok, note: "key " + k };
    }
    case "scroll": {
      const dy = parseInt(args.dy, 10) || 600;
      const key = dy >= 0 ? "Page_Down" : "Page_Up";
      const times = Math.min(Math.abs(Math.round(dy / 600)) || 1, 5);
      const r = await run("xdotool", ["key", "--repeat", String(times), key]);
      await sleep(400);
      return { ok: r.ok, note: "scroll " + dy };
    }
    case "tablist": {
      const pages = await cdpPages();
      return { ok: true, tabs: pages.map((p, i) => ({ n: i + 1, title: p.title, url: p.url })) };
    }
    case "tabswitch": {
      const pages = await cdpPages();
      const i = Math.max(0, Math.min(parseInt(args.n, 10) - 1 || 0, pages.length - 1));
      await cdpAttach(i);
      await wsSend("Page.bringToFront", {});
      await sleep(300);
      return { ok: true, note: "已切到标签 " + (i + 1) };
    }
    case "tabnew": {
      await run("xdotool", ["key", "ctrl+t"]);
      await sleep(900);
      return { ok: true, note: "新标签页" };
    }
    case "tabclose": {
      await run("xdotool", ["key", "ctrl+w"]);
      await sleep(600);
      return { ok: true, note: "已关闭标签" };
    }
    case "observe": {
      const data = await observe(args.max);
      return Object.assign({ ok: true }, data);
    }
    case "read": {
      const data = await readPage();
      return Object.assign({ ok: true }, data);
    }
    case "wait": {
      await sleep(Math.min(parseInt(args.ms, 10) || 1000, 8000));
      return { ok: true, note: "waited" };
    }
    default:
      throw new Error("未知 op：" + op);
  }
}

/* ---------- 截图（imagemagick import，短缓存） ---------- */

let shotCache = { ts: 0, buf: null };
function screenshot() {
  return new Promise((resolve, reject) => {
    if (shotCache.buf && Date.now() - shotCache.ts < 400) return resolve(shotCache.buf);
    const p = spawn("import", ["-window", "root", "png:-"], {
      env: Object.assign({}, process.env, { DISPLAY }),
    });
    const chunks = [];
    p.stdout.on("data", (c) => chunks.push(c));
    p.on("close", (code) => {
      if (code !== 0 || !chunks.length) return reject(new Error("截图失败"));
      const buf = Buffer.concat(chunks);
      shotCache = { ts: Date.now(), buf };
      resolve(buf);
    });
    p.on("error", reject);
  });
}

/* ---------- HTTP ---------- */

const startedAt = Date.now();
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://box");
  const p = u.pathname;
  try {
    if (req.method === "GET" && p === "/health") {
      let cdp = false;
      try { await httpGetJson(CDP_HTTP + "/json/version", 2500); cdp = true; } catch (e) {}
      return json(res, 200, { ok: true, uptimeMs: Date.now() - startedAt, browser: cdp, display: DISPLAY });
    }
    if (req.method === "GET" && (p === "/screen.png" || p === "/screenshot")) {
      const buf = await screenshot();
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buf.length, "Cache-Control": "no-store" });
      return res.end(buf);
    }
    if (req.method === "GET" && p === "/observe") {
      const data = await observe(u.searchParams.get("max"));
      return json(res, 200, Object.assign({ ok: true }, data));
    }
    if (req.method === "POST" && (p === "/act" || p === "/exec")) {
      let body;
      try { body = JSON.parse((await readBody(req)).toString("utf8")); }
      catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
      const r = await actOn(body);
      return json(res, 200, r);
    }
    json(res, 404, { ok: false, error: "Not Found" });
  } catch (e) {
    json(res, 502, { ok: false, error: String(e && e.message || e) });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log("[box-server] listening on :" + PORT + " display=" + DISPLAY);
});
