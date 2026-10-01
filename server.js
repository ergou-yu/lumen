#!/usr/bin/env node
/* ============================================================
   Lumen · 本地服务桥（v3）
   ------------------------------------------------------------
  0) 网站伺服：http://127.0.0.1:8787 直接打开 Lumen 应用（同源，
     无 CORS 顾虑；启动时自动弹出浏览器）。
  1) 服务端模型（可选，自带 Key）：通过环境变量接入任意 Anthropic 兼容端点
     LUMEN_MODEL_API_KEY + LUMEN_MODEL_BASE (+ LUMEN_MODEL_NAME)，
     仅供服务侧功能（桌面虚拟机任务、监控判断）使用；
     聊天模型由用户在设置页自带 Key 浏览器直连，密钥只存本机浏览器。
  2) 技能服务：扫描 skills 目录下各技能的 SKILL.md，输出清单与全文。
  3) QCU 执行桥：POST /qcu/exec 受控执行本机 qcu CLI（observe/act/…），
     供 Lumi 的「电脑操作」能力使用。只绑 127.0.0.1，绝不出本机。
  4) 虚拟计算机 LumenBox：Lumi「自己的电脑」（本地常驻执行环境）
     ——虚拟浏览器（真实检索/打开/点链接/阅读）+ 囚笼工作区 vm-home/ +
     软沙箱终端（默认关）。浏览类任务优先在这里完成，不操控用户本机。

   启动：node server.js   （PORT=8787 可改；LUMEN_NO_OPEN=1 禁止自动开浏览器）
   ============================================================ */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const os = require("os");

const PORT = parseInt(process.env.PORT || "8787", 10);
// 默认只绑本机回环；手机等同网段设备访问请用 LUMEN_HOST=0.0.0.0 启动（详见 README「手机访问」）
const HOST = process.env.LUMEN_HOST || "127.0.0.1";
const LUMEN_DIR = __dirname;
// 服务端模型（可选）：自带 Key，绝不读取任何第三方工具的本地配置
const MODEL_KEY = process.env.LUMEN_MODEL_API_KEY || null;
const MODEL_BASE = (process.env.LUMEN_MODEL_BASE || "").replace(/\/+$/, "");
const MODEL_NAME = process.env.LUMEN_MODEL_NAME || "glm-4.7-flash";
const SKILLS_DIR = path.join(LUMEN_DIR, "skills");
const QCU_BIN = process.env.QCU_BIN || "qcu";
const QCU_TIMEOUT_MS = parseInt(process.env.QCU_TIMEOUT_MS || "90000", 10);
const MAX_BODY = 4 * 1024 * 1024;

// —— 技能分类（按 id 归组；exec=true 表示该技能有可执行通道） ——
const SKILL_META = {
  "quick-computer-use":        { category: "电脑操作", exec: true },
  "motion-skill-kit":          { category: "前端艺术" },
  "discover-learning-resources": { category: "学习研究" },
  "build-knowledge-relations":   { category: "学习研究" },
  "build-adaptive-learning-handbook": { category: "学习研究" },
  "research-evidence-packager":   { category: "学习研究" },
  "learning-guidance-orchestrator": { category: "学习研究" },
  "research-budget-controller":    { category: "学习研究" },
  "deepseek-harness-audit":    { category: "审计" },
  "mirroria-delivery-debate":  { category: "交付评审" },
};

// 服务端模型是否就绪（需要 Key 与 Base 同时给出；未配置时相关功能优雅降级）
function serverModelReady() {
  return !!(MODEL_KEY && MODEL_BASE);
}
function serverModelHint() {
  if (serverModelReady()) return "已配置（LUMEN_MODEL_API_KEY）";
  if (MODEL_KEY && !MODEL_BASE) return "缺少 LUMEN_MODEL_BASE";
  return "未配置（可选：桌面虚拟机任务需要，聊天不受影响）";
}

// —— CORS：Lumen 是浏览器页面（file:// 下 Origin 为 null），必须放行 ——
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, x-api-key, authorization, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
  "Access-Control-Max-Age": "86400",
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  }, CORS));
  res.end(body);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on("data", function (c) {
      size += c.length;
      if (size > limit) { reject(new Error("body 超限")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

/* ============ 技能服务 ============ */

// 解析 SKILL.md 头部 frontmatter（name / description），失败则回退目录名
function parseSkill(dir) {
  const id = path.basename(dir);
  const file = path.join(dir, "SKILL.md");
  let name = id, desc = "";
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      const nameMatch = m[1].match(/^name:\s*(.+)$/m);
      const descMatch = m[1].match(/^description:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) desc = descMatch[1].trim();
    } else {
      // 无 frontmatter：取第一个标题行当名字
      const h1 = text.match(/^#\s+(.+)$/m);
      if (h1) name = h1[1].trim();
      const para = text.split(/\r?\n/).map(function (l) { return l.trim(); })
        .find(function (l) { return l && !l.startsWith("#") && l !== "---"; });
      if (para) desc = para.slice(0, 120);
    }
    if (desc.length > 160) desc = desc.slice(0, 160) + "…";
  } catch (e) { return null; }
  const meta = SKILL_META[id] || {};
  return {
    id: id,
    name: name,
    desc: desc,
    category: meta.category || "通用",
    exec: !!meta.exec,
  };
}

function listSkills() {
  let dirs = [];
  try { dirs = fs.readdirSync(SKILLS_DIR); } catch (e) {}
  const out = [];
  for (const d of dirs) {
    const st = parseSkill(path.join(SKILLS_DIR, d));
    if (st) out.push(st);
  }
  return out;
}

function skillContent(id) {
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) return null; // 防路径穿越
  const file = path.join(SKILLS_DIR, id, "SKILL.md");
  try {
    let text = fs.readFileSync(file, "utf8");
    if (text.length > 60 * 1024) text = text.slice(0, 60 * 1024) + "\n\n…（内容过长已截断）";
    return text;
  } catch (e) { return null; }
}

/* ============ QCU 执行桥 ============ */

const QCU_SUBCOMMANDS = new Set([
  "session", "browser", "daemon", "observe", "find", "inspect",
  "act", "batch", "route", "stats", "schema", "doctor", "--version", "--help",
]);

function runQcu(argv) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    const child = spawn(QCU_BIN, argv, {
      cwd: LUMEN_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", errOut = "", done = false;
    const cap = 128 * 1024;
    child.stdout.on("data", function (d) { if (out.length < cap) out += d.toString(); });
    child.stderr.on("data", function (d) { if (errOut.length < cap) errOut += d.toString(); });
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch (e) {}
      resolve({ ok: false, code: -1, timedOut: true, stdout: out, stderr: errOut + "\n[qcu 超时 " + QCU_TIMEOUT_MS + "ms 已终止]", durationMs: Date.now() - t0 });
    }, QCU_TIMEOUT_MS);
    child.on("error", function (e) {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, code: -1, error: "无法启动 " + QCU_BIN + "：" + e.message, stdout: "", stderr: "", durationMs: Date.now() - t0 });
    });
    child.on("close", function (code) {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: code === 0, code: code, stdout: out, stderr: errOut, durationMs: Date.now() - t0 });
    });
  });
}

async function handleQcuExec(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req, MAX_BODY)).toString("utf8")); }
  catch (e) { return json(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
  const argv = body.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 16) {
    return json(res, 400, { ok: false, error: "argv 必须是 1~16 个元素的字符串数组" });
  }
  for (const a of argv) {
    if (typeof a !== "string" || a.length === 0 || a.length > 300 ||
        /[\u0000-\u001f]/.test(a) || /^\s*$/.test(a)) {
      return json(res, 400, { ok: false, error: "argv 含非法参数（空串/过长/控制字符）" });
    }
  }
  if (!QCU_SUBCOMMANDS.has(argv[0])) {
    return json(res, 400, { ok: false, error: "不支持的 qcu 子命令：" + argv[0] });
  }
  const result = await runQcu(argv);
  json(res, 200, result);
}

/* ============ 静态网站伺服（同源即本地网址） ============ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// 只放行应用自身的前端资源目录（skills/ 走 /skills API，不在此暴露）
const STATIC_ROOTS = ["css", "js", "assets"];

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "/index.html") rel = "/index.html";
  rel = rel.replace(/^\/+/, "");
  const first = rel.split("/")[0];
  if (rel !== "index.html" && STATIC_ROOTS.indexOf(first) === -1) return false;

  const file = path.resolve(LUMEN_DIR, rel);
  if (file !== LUMEN_DIR && file.indexOf(LUMEN_DIR + path.sep) !== 0) return false; // 防路径穿越
  let st;
  try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": "no-cache", // 本地开发友好：改完刷新即生效
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

/* ============ OpenAI 兼容层（/chat/completions → Anthropic 上游转译） ============ */

// OpenAI messages → Anthropic（system 抽出；合并连续同角色；首条必须 user）
function oaiToAnthropic(body) {
  const system = [];
  const msgs = [];
  for (const m of (body.messages || [])) {
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter(function (p) { return p && p.type === "text"; })
        .map(function (p) { return p.text || ""; }).join("\n");
    }
    if (m.role === "system" || m.role === "developer") { if (text) system.push(text); continue; }
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: text || " " });
  }
  const merged = [];
  for (const m of msgs) {
    if (merged.length && merged[merged.length - 1].role === m.role) {
      merged[merged.length - 1].content += "\n\n" + m.content;
    } else merged.push({ role: m.role, content: m.content });
  }
  if (!merged.length) merged.push({ role: "user", content: " " });
  if (merged[0].role !== "user") merged.unshift({ role: "user", content: "（请开始）" });
  return {
    model: body.model || MODEL_NAME,
    max_tokens: Math.min(body.max_tokens || 8192, 32768),
    temperature: body.temperature,
    system: system.join("\n\n") || undefined,
    messages: merged,
    stream: !!body.stream,
  };
}

const STOP_MAP = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length" };

function upstreamRequest(upBody, onRespond) {
  const upUrl = new URL(MODEL_BASE + "/v1/messages");
  const upReq = https.request({
    hostname: upUrl.hostname,
    port: upUrl.port || 443,
    path: upUrl.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(upBody),
      "x-api-key": MODEL_KEY || "",
      "anthropic-version": "2023-06-01",
    },
    timeout: 300000,
  }, onRespond);
  upReq.on("timeout", function () { upReq.destroy(new Error("上游超时")); });
  return upReq;
}

function handleChatCompletions(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody.toString("utf8")); }
  catch (e) { return json(res, 400, { error: { message: "请求体不是合法 JSON" } }); }
  if (!serverModelReady()) {
    return json(res, 502, { error: { message: "服务端模型未配置。请设置环境变量 LUMEN_MODEL_API_KEY 与 LUMEN_MODEL_BASE（自带 Key，任意 Anthropic 兼容端点）后重启服务桥。" } });
  }
  const upBody = JSON.stringify(oaiToAnthropic(body));
  const upReq = upstreamRequest(upBody, function (upRes) {
    // 上游报错：尽量把上游信息塞进 OpenAI 风格的 error 里
    if (upRes.statusCode !== 200) {
      const chunks = [];
      upRes.on("data", function (c) { chunks.push(c); });
      upRes.on("end", function () {
        let msg = "";
        try { const j = JSON.parse(Buffer.concat(chunks).toString("utf8")); msg = j.error && j.error.message || JSON.stringify(j).slice(0, 300); }
        catch (e) { msg = Buffer.concat(chunks).toString("utf8").slice(0, 300); }
        json(res, upRes.statusCode, { error: { message: "上游 " + upRes.statusCode + " · " + msg } });
      });
      return;
    }
    if (!body.stream) {
      // 非流式：整包读完后一次性转译
      const chunks = [];
      upRes.on("data", function (c) { chunks.push(c); });
      upRes.on("end", function () {
        try {
          const a = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const text = (a.content || []).filter(function (b) { return b.type === "text"; })
            .map(function (b) { return b.text || ""; }).join("");
          json(res, 200, {
            id: a.id || "chatcmpl-lumen",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: a.model || body.model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: STOP_MAP[a.stop_reason] || "stop",
            }],
            usage: {
              prompt_tokens: (a.usage && a.usage.input_tokens) || 0,
              completion_tokens: (a.usage && a.usage.output_tokens) || 0,
              total_tokens: ((a.usage && a.usage.input_tokens) || 0) + ((a.usage && a.usage.output_tokens) || 0),
            },
          });
        } catch (e) {
          json(res, 502, { error: { message: "上游响应解析失败：" + e.message } });
        }
      });
      return;
    }
    // 流式：Anthropic SSE → OpenAI chunk SSE 逐事件转译（thinking 不外漏）
    res.writeHead(200, Object.assign({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    }, CORS));
    const id = "chatcmpl-" + Date.now().toString(36);
    const model = body.model || MODEL_NAME;
    let started = false, finish = "stop";
    let buffer = "";
    function chunk(delta, finishReason) {
      const payload = {
        id: id, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: model,
        choices: [{ index: 0, delta: delta, finish_reason: finishReason === undefined ? null : finishReason }],
      };
      res.write("data: " + JSON.stringify(payload) + "\n\n");
    }
    upRes.on("data", function (data) {
      buffer += data.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t.indexOf("data:") !== 0) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch (e) { continue; }
        if (ev.type === "message_start") {
          started = true;
          chunk({ role: "assistant", content: "" }, null);
        } else if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta.text === "string") {
          chunk({ content: ev.delta.text }, null); // thinking_delta 自然被忽略
        } else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) {
          finish = STOP_MAP[ev.delta.stop_reason] || "stop";
        } else if (ev.type === "message_stop") {
          chunk({}, finish);
          res.write("data: [DONE]\n\n");
        }
      }
    });
    upRes.on("end", function () {
      if (!started) chunk({ role: "assistant", content: "" }, null);
      if (!res.writableEnded) { try { res.write("data: [DONE]\n\n"); } catch (e) {} res.end(); }
    });
    upRes.on("error", function () { try { res.end(); } catch (e) {} });
  });
  upReq.on("error", function (err) {
    if (res.headersSent) return res.end();
    json(res, 502, { error: { message: "上游请求失败：" + err.message } });
  });
  upReq.end(upBody);
}

/* ============ 真实网络层：/web/search + /web/fetch（服务端抓取，无 CORS 顾虑） ============ */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function httpGet(url, timeoutMs, maxBytes) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(url, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8", "Accept": "text/html,application/xhtml+xml,*/*" },
      timeout: timeoutMs,
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let loc = res.headers.location;
        if (loc.indexOf("http") !== 0) loc = new URL(loc, url).href;
        return resolve(httpGet(loc, timeoutMs, maxBytes)); // 跟随跳转（含 http↔https 切换）
      }
      const chunks = [];
      let size = 0;
      res.on("data", function (c) {
        size += c.length;
        if (size <= maxBytes) chunks.push(c);
        else req.destroy();
      });
      res.on("end", function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
      res.on("close", function () { if (!res.complete) resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
    });
    req.on("timeout", function () { req.destroy(new Error("抓取超时")); });
    req.on("error", function (e) { reject(e); });
  });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;|&ensp;|&emsp;/g, " ")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/&ldquo;/g, "\u201c").replace(/&rdquo;/g, "\u201d")
    .replace(/&lsquo;/g, "\u2018").replace(/&rsquo;/g, "\u2019")
    .replace(/&hellip;/g, "…").replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); });
}

// HTML → 纯文本（去脚本样式，压缩空白，保留段落感）
function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  ).replace(/[ \t\u00a0]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

// —— 搜索：DuckDuckGo HTML 版（质量最佳）→ Bing → 百度，多级回退合并 ——
function parseDDG(html) {
  const out = [];
  // 锚点属性顺序不固定（href/class 先后皆有），先抓整标签再取 href
  const re = /<a\b([^>]*class="result__a"[^>]*)>([\s\S]*?)<\/a>/g;
  const snips = html.match(/<a[^>]*class="result__snippet"[^>]*>[\s\S]*?<\/a>/g) || [];
  let m, idx = 0;
  while ((m = re.exec(html)) && out.length < 12) {
    const i = idx++;
    const hrefM = m[1].match(/href="([^"]+)"/);
    if (!hrefM) continue;
    let url = hrefM[1];
    // DDG 链接是双层包裹：先解出真实目标，再判断是否广告
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) {
      try { url = decodeURIComponent(uddg[1]); } catch (e) { continue; }
    } else if (url.indexOf("//") === 0) {
      url = "https:" + url;
    }
    if (url.indexOf("http") !== 0) continue;
    // 广告位解包后暴露真身（y.js 跳转链 / ad_ 参数）；仍留在 DDG 域内的也丢弃
    if (/duckduckgo\.com\/y\.js|[?&]ad_(domain|provider|type)=/.test(url)) continue;
    if (/(^|\.)duckduckgo\.com\//.test(url.replace(/^https:\/\//, ""))) continue;
    const title = htmlToText(m[2]);
    const snippet = snips[i] ? htmlToText(snips[i].replace(/^<a[^>]*>|<\/a>$/g, "")) : "";
    if (title) out.push({ title: title, url: url, snippet: snippet.slice(0, 260) });
  }
  return out;
}

function parseBing(html) {
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    const title = htmlToText(m[2]);
    const snipMatch = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = snipMatch ? htmlToText(snipMatch[1]) : "";
    if (title && m[1].indexOf("http") === 0) out.push({ title: title, url: m[1], snippet: snippet.slice(0, 260) });
  }
  return out;
}

function parseBaidu(html) {
  const out = [];
  const re = /<div class="result c-container[\s\S]*?<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<span class="content-right_[^"]*">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    const title = htmlToText(m[2]);
    const snippet = htmlToText(m[3]);
    if (title) out.push({ title: title, url: m[1], snippet: snippet.slice(0, 260) });
  }
  // 百度结果链接是跳转链，标题仍有价值；无 snippet 的兜底
  if (!out.length) {
    const re2 = /<h3[^>]*>\s*<a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re2.exec(html)) && out.length < 10) {
      const title = htmlToText(m[2]);
      if (title) out.push({ title: title, url: m[1], snippet: "" });
    }
  }
  return out;
}

// 查询词相关度打分：丢弃零相关结果、按命中排序，并返回最高分供引擎降级判断
function scoreResults(query, results) {
  const q = String(query).toLowerCase();
  const tokens = q.split(/[\s,，。;；、]+/).map(function (t) { return t.trim(); })
    .filter(function (t) {
      if (/[\u4e00-\u9fff]/.test(t)) return t.length >= 2; // 中文词 ≥2 字
      return t.length >= 3; // 拉丁词 ≥3 字符（排除 to/of/the 等虚词刷分）
    });
  const scored = [];
  let max = 0;
  for (const r of results) {
    const hay = (r.title + " " + (r.snippet || "") + " " + r.url).toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.indexOf(t) !== -1) score++;
    if (score > 0) {
      if (score > max) max = score;
      r._score = score;
      scored.push(r);
    }
  }
  scored.sort(function (a, b) { return (b._score || 0) - (a._score || 0); });
  for (const r of scored) delete r._score;
  return { list: scored, max: max };
}

// 搜索缓存（30 分钟）：同查询不重复打引擎，缓解公共引擎限流
const searchCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

async function webSearch(query, count) {
  const cacheKey = String(query).trim().toLowerCase();
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_TTL && hit.data.results && hit.data.results.length) {
    return hit.data; // 缓存命中，不打引擎
  }
  const enc = encodeURIComponent(query);
  const attempts = [
    { url: "https://html.duckduckgo.com/html/?q=" + enc, parse: parseDDG },
    { url: "https://www.bing.com/search?q=" + enc + "&count=10&setlang=zh-hans", parse: parseBing },
    { url: "https://www.baidu.com/s?wd=" + enc + "&rn=10", parse: parseBaidu },
  ];
  const errors = [];
  const merged = [];
  const seen = new Set();
  let bestScore = 0;
  for (const a of attempts) {
    try {
      const r = await httpGet(a.url, 15000, 1024 * 1024);
      // 打分过滤：引擎偶发返回无关填充结果（限流降级），零相关直接丢弃
      const s = scoreResults(query, a.parse(r.body));
      if (s.max > bestScore) bestScore = s.max;
      errors.push(a.url.split("/")[2] + "：" + s.list.length + " 条/最高" + s.max + "分");
      for (const it of s.list) {
        if (!seen.has(it.url)) { seen.add(it.url); merged.push(it); }
      }
      // 数量够 且 出现过高相关结果（≥2 词命中）才停；否则继续打下一家引擎
      if (merged.length >= 5 && bestScore >= 2) break;
    } catch (e) {
      errors.push(a.url.split("/")[2] + "：" + e.message);
    }
  }
  if (merged.length) {
    const data = { ok: true, engine: "ddg+", results: merged.slice(0, count || 6) };
    searchCache.set(cacheKey, { t: Date.now(), data: data });
    return data;
  }
  return { ok: false, error: errors.join("；") || "所有引擎均无结果" };
}

async function webFetch(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("仅支持 http(s) 地址");
  const r = await httpGet(url, 20000, 2 * 1024 * 1024);
  const titleMatch = r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = htmlToText(r.body);
  return {
    ok: r.status === 200,
    status: r.status,
    title: titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 120) : "",
    text: text.slice(0, 12000),
    finalUrl: url,
  };
}

/* ============ 虚拟计算机 LumenBox（Lumi 自己的电脑） ============
 * Lumi 不再操控用户本机：浏览/检索/阅读在服务桥进程内的「虚拟浏览器」完成，
 * 产物落在囚笼工作区目录 vm-home/，终端为 cwd/HOME 受限的软沙箱（默认关）。
 * 全部动作可观测（/vm/state）、可审计（调用方写审计日志）、可一键清空。
 * ============ */

const VM_HOME = path.join(LUMEN_DIR, "vm-home");
const VM_STATE_FILE = path.join(LUMEN_DIR, "lumen-vm.json");
const VM_TEXT_CAP = 9000;      // 单页正文上限（字符）
const VM_HISTORY_MAX = 30;     // 浏览历史条数
const VM_SHELL_TIMEOUT_MS = parseInt(process.env.VM_SHELL_TIMEOUT_MS || "20000", 10);
const VM_SHELL_SERVER_ON = process.env.LUMEN_VM_SHELL !== "0"; // 服务端总闸（设 LUMEN_VM_SHELL=0 可彻底禁用终端）

try { fs.mkdirSync(VM_HOME, { recursive: true }); } catch (e) {}

// —— 虚拟浏览器状态：{ current: {url,title,kind}, history: [{url,title}] } ——
let vmBrowser = { current: null, history: [] };
try {
  const saved = JSON.parse(fs.readFileSync(VM_STATE_FILE, "utf8"));
  if (saved && typeof saved === "object") vmBrowser = Object.assign(vmBrowser, saved);
} catch (e) {}

function vmSaveState() {
  try { fs.writeFileSync(VM_STATE_FILE, JSON.stringify(vmBrowser, null, 2)); } catch (e) {}
}

function vmNormalizeUrl(u) {
  let s = String(u || "").trim();
  if (!s) return null;
  if (/^lumenbox:\/\//.test(s)) return s; // 虚拟内页（搜索结果页等）
  if (!/^https?:\/\//i.test(s)) {
    if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(s)) s = "https://" + s;
    else return null;
  }
  try { return new URL(s).href; } catch (e) { return null; }
}

// 从 HTML 抽链接（虚拟浏览器里可「点击」的锚点，去重、限量）
function vmExtractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 24) {
    let href = m[1];
    if (/^(javascript:|mailto:|tel:)/i.test(href)) continue;
    try { href = new URL(href, baseUrl).href; } catch (e) { continue; }
    if (!/^https?:/i.test(href)) continue;
    const title = htmlToText(m[2]).slice(0, 90);
    if (!title || seen.has(href)) continue;
    seen.add(href);
    out.push({ title: title, url: href });
  }
  return out;
}

// 打开一个真实网页 → 虚拟浏览器的「当前页」（原始 HTML 独立抓一次，链接是可点击性的关键）
async function vmOpenReal(url) {
  const r = await httpGet(url, 20000, 2 * 1024 * 1024);
  const titleMatch = r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const cur = {
    url: url,
    finalUrl: url,
    kind: "page",
    title: titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 120) : url,
    text: htmlToText(r.body).slice(0, VM_TEXT_CAP),
    links: (function () { try { return vmExtractLinks(r.body, url); } catch (e) { return []; } })(),
    openedAt: Date.now(),
  };
  vmPushHistory(cur);
  return cur;
}

// 搜索结果页：虚拟内页 lumenbox://search?q=…，结果条目就是可点击链接
async function vmSearchPage(query) {
  const sr = await webSearch(query, 8);
  if (!sr.ok) return { error: sr.error || "检索失败" };
  const results = (sr.results || []).map(function (r) {
    return { title: r.title, url: r.url, snippet: (r.snippet || "").slice(0, 160) };
  });
  const cur = {
    url: "lumenbox://search?q=" + encodeURIComponent(query),
    kind: "search",
    title: "搜索：「" + query + "」 · " + results.length + " 条结果",
    text: results.map(function (r, i) {
      return "[" + (i + 1) + "] " + r.title + "\n    " + r.url + (r.snippet ? "\n    " + r.snippet : "");
    }).join("\n"),
    links: results.map(function (r) { return { title: r.title, url: r.url }; }),
    snippets: results,
    openedAt: Date.now(),
  };
  vmPushHistory(cur);
  return cur;
}

function vmPushHistory(cur) {
  vmBrowser.current = { url: cur.url, kind: cur.kind, title: cur.title, openedAt: cur.openedAt };
  vmBrowser.history.unshift({ url: cur.url, title: cur.title, t: Date.now(), kind: cur.kind });
  vmBrowser.history = vmBrowser.history.slice(0, VM_HISTORY_MAX);
  vmSaveState();
}

// 当前页快照（给模型/面板的可观察输出）
function vmCurrentDigest() {
  const c = vmPageCache;
  if (!c) return { page: null };
  return {
    page: {
      url: c.url, kind: c.kind, title: c.title,
      excerpt: String(c.text || "").slice(0, 1600),
      chars: String(c.text || "").length,
      links: (c.links || []).slice(0, 12).map(function (l, i) {
        return { n: i + 1, title: l.title, url: l.url };
      }),
    },
  };
}

// 最近一次打开的完整页面缓存（进程内；重启后需重新打开）
let vmPageCache = null;

async function vmBrowserExec(op, arg) {
  if (op === "state") { const d = vmCurrentDigest(); d.current = vmBrowser.current; d.history = vmBrowser.history.slice(0, 10); return d; }
  if (op === "search") {
    const q = String(arg && arg.query || "").trim().slice(0, 120);
    if (!q) return { error: "query 必填" };
    const page = await vmSearchPage(q);
    if (page.error) return page;
    vmPageCache = page;
    return vmCurrentDigest();
  }
  if (op === "open") {
    const url = vmNormalizeUrl(arg && arg.url);
    if (!url) return { error: "url 非法（需 http(s) 或域名）" };
    const page = await vmOpenReal(url);
    vmPageCache = page;
    return vmCurrentDigest();
  }
  if (op === "click") {
    const n = parseInt(arg && arg.n, 10);
    const links = (vmPageCache && vmPageCache.links) || [];
    if (!(n >= 1 && n <= links.length)) return { error: "当前页没有第 " + (arg && arg.n) + " 个链接（共 " + links.length + " 个）" };
    const target = links[n - 1];
    const page = await vmOpenReal(target.url);
    vmPageCache = page;
    const d = vmCurrentDigest();
    d.clicked = target;
    return d;
  }
  if (op === "read") {
    if (!vmPageCache) return { error: "虚拟浏览器还没有打开任何页面" };
    const c = vmPageCache;
    return { page: { url: c.url, kind: c.kind, title: c.title, text: String(c.text || "").slice(0, VM_TEXT_CAP), links: (c.links || []).slice(0, 12).map(function (l, i) { return { n: i + 1, title: l.title, url: l.url }; }) } };
  }
  if (op === "back") {
    if (!vmBrowser.history.length) return { error: "没有更早的历史" };
    vmBrowser.history.shift(); // 弹掉当前
    const prev = vmBrowser.history[0];
    if (!prev) { vmBrowser.current = null; vmSaveState(); vmPageCache = null; return { page: null, note: "已回到空白页" }; }
    const page = await vmOpenReal(prev.url);
    vmPageCache = page;
    return vmCurrentDigest();
  }
  return { error: "未知 browser 操作：" + op };
}

// —— 虚拟文件系统：一切囚于 vm-home/，禁止任何形式的越界 ——
function vmSafeName(name) {
  const n = String(name || "").trim();
  // 只拦真正危险的：控制字符、反斜杠与保留字符、.. 穿越、隐藏段；
  // 中文、空格、括号（浏览器重名会生成 "(1)"）等一律放行
  if (!n || n.length > 160) return null;
  if (/[\u0000-\u001f\\:*?"<>|]/.test(n)) return null;
  const segs = n.split("/");
  if (segs.some(seg => !seg || seg === "." || seg === ".." || seg.startsWith("."))) return null;
  const full = path.resolve(VM_HOME, n);
  if (full !== VM_HOME && full.indexOf(VM_HOME + path.sep) !== 0) return null;
  return full;
}

function vmFilesExec(op, arg) {
  if (op === "ls") {
    const out = [];
    const walk = function (dir, prefix) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const nm of names) {
        if (nm.startsWith(".")) continue;
        const f = path.join(dir, nm);
        let st = null;
        try { st = fs.statSync(f); } catch (e) { continue; }
        const rel = prefix + nm;
        if (st.isDirectory()) walk(f, rel + "/");
        else out.push({ name: rel, size: st.size, mtime: st.mtimeMs });
      }
    };
    walk(VM_HOME, "");
    out.sort(function (a, b) { return b.mtime - a.mtime; });
    return { files: out.slice(0, 100) };
  }
  if (op === "read") {
    const full = vmSafeName(arg && arg.name);
    if (!full) return { error: "文件名非法" };
    try {
      const text = fs.readFileSync(full, "utf8");
      return { name: arg.name, content: text.slice(0, 60000) };
    } catch (e) { return { error: "读取失败：" + e.message }; }
  }
  if (op === "write") {
    const full = vmSafeName(arg && arg.name);
    if (!full) return { error: "文件名非法（只允许 vm-home 内的相对路径）" };
    const content = String(arg && arg.content || "").slice(0, 200 * 1024);
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return { ok: true, name: arg.name, bytes: Buffer.byteLength(content) };
    } catch (e) { return { error: "写入失败：" + e.message }; }
  }
  if (op === "rm") {
    const full = vmSafeName(arg && arg.name);
    if (!full) return { error: "文件名非法" };
    try { fs.unlinkSync(full); return { ok: true }; } catch (e) { return { error: "删除失败：" + e.message }; }
  }
  if (op === "clear") {
    let n = 0;
    const walk = function (dir) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const nm of names) {
        if (nm.startsWith(".")) continue;
        const f = path.join(dir, nm);
        let st = null;
        try { st = fs.statSync(f); } catch (e) { continue; }
        if (st.isDirectory()) { walk(f); try { fs.rmdirSync(f); } catch (e) {} }
        else { try { fs.unlinkSync(f); n++; } catch (e) {} }
      }
    };
    walk(VM_HOME);
    vmBrowser = { current: null, history: [] };
    vmPageCache = null;
    vmSaveState();
    return { ok: true, removed: n };
  }
  return { error: "未知 files 操作：" + op };
}

// —— 虚拟终端：软沙箱（进程真实运行于本机，仅 cwd/HOME 被钉在 vm-home）——
// 默认关闭；开启需同时满足：服务端总闸开 + 请求方声明用户已在设置里打开。
let vmShellLog = [];
function vmShellExec(cmd) {
  const shell = process.env.SHELL || (process.platform === "win32" ? "cmd" : "/bin/bash");
  const argv = process.platform === "win32" ? ["/c", cmd] : ["-c", cmd];
  return new Promise(function (resolve) {
    const t0 = Date.now();
    const child = spawn(shell, argv, {
      cwd: VM_HOME,
      env: Object.assign({}, process.env, { HOME: VM_HOME }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", done = false;
    const cap = 24 * 1024;
    child.stdout.on("data", function (d) { if (out.length < cap) out += d.toString(); });
    child.stderr.on("data", function (d) { if (out.length < cap) out += d.toString(); });
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch (e) {}
      out += "\n[超时 " + VM_SHELL_TIMEOUT_MS + "ms 已终止]";
      finish(-1);
    }, VM_SHELL_TIMEOUT_MS);
    function finish(code) {
      const record = { t: Date.now(), cmd: cmd, code: code, out: out.slice(0, 8000), ms: Date.now() - t0 };
      vmShellLog.unshift(record);
      vmShellLog = vmShellLog.slice(0, 20);
      resolve({ ok: code === 0, code: code, output: record.out, ms: record.ms });
    }
    child.on("error", function (e) { if (done) return; done = true; clearTimeout(timer); out = "无法启动：" + e.message; finish(-1); });
    child.on("close", function (code) { if (done) return; done = true; clearTimeout(timer); finish(code); });
  });
}

async function handleVmExec(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req, 512 * 1024)).toString("utf8")); }
  catch (e) { return json(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
  const tool = String(body.tool || ""), op = String(body.op || "");
  try {
    if (tool === "browser") {
      const r = await vmBrowserExec(op, body.args || {});
      return json(res, 200, Object.assign({ ok: !r.error }, r));
    }
    if (tool === "files") {
      const r = vmFilesExec(op, body.args || {});
      return json(res, 200, Object.assign({ ok: !r.error }, r));
    }
    if (tool === "shell") {
      if (!VM_SHELL_SERVER_ON) return json(res, 403, { ok: false, error: "虚拟终端已被服务端禁用（LUMEN_VM_SHELL=0）" });
      if (!body.shellEnabled) return json(res, 403, { ok: false, error: "虚拟终端未开启：请先在 Lumen 设置 → 虚拟计算机里打开（软沙箱，请知悉边界）" });
      const cmd = String(body.args && body.args.cmd || "").slice(0, 500);
      if (!cmd.trim() || /[\r\n]/.test(cmd)) return json(res, 400, { ok: false, error: "cmd 必填且为单条命令" });
      const r = await vmShellExec(cmd);
      return json(res, 200, r);
    }
    return json(res, 400, { ok: false, error: "未知工具：" + tool + "（browser | files | shell）" });
  } catch (e) {
    return json(res, 502, { ok: false, error: "VM 执行失败：" + e.message });
  }
}

function vmPublicState() {
  const d = vmCurrentDigest();
  return {
    ok: true,
    current: vmBrowser.current,
    history: vmBrowser.history.slice(0, 10),
    page: d.page,
    files: vmFilesExec("ls").files,
    shell: { enabled: VM_SHELL_SERVER_ON, log: vmShellLog.slice(0, 10) },
    home: "vm-home/",
  };
}

/* ============ LumenBox Desktop：容器化桌面虚拟机（Sentinel 全程审查） ============
 * 架构原则：
 * · 每用户一台独立 Linux 虚拟机（这里是本机 Docker 非特权容器）：完整桌面 +
 *   真实 Chromium + VNC，Cookie/历史落在私有卷 lumen-box-home，与宿主隔离。
 * · App 只是遥控器：桌面任务循环跑在服务桥（宿主）里，浏览器关了也继续。
 * · Sentinel 是唯一审批权威，且在容器外（宿主）运行：容器内只有执行器，
 *   每个动作先经 Sentinel 判定 放行 / 阻止 / 交用户批准；批准结果是绑定
 *   动作摘要 + 10 分钟期限的能力凭证（同类动作期内免再次打扰）。
 * · 凭证安全区（hatch-authd 的本地等价物）：明文只存宿主 0600 文件，模型
 *   与审计只能看到「名称」；获批后由服务桥直接注入容器键盘事件，值永不
 *   进入模型上下文、页面快照或日志。
 * · 恶意站点名单 + 私网地址（SSRF）拦截；用户接管（在 noVNC 画面里亲手
 *   操作）时，代理的下一个动作前强制重新观察，避免与人的操作打架。
 * ============ */

const BOX_IMAGE = "lumen-box";
const BOX_NAME = "lumen-box";
const BOX_DIR = path.join(LUMEN_DIR, "vm-box");
const VAULT_FILE = path.join(LUMEN_DIR, "lumen-vault.json");
const DTASKS_FILE = path.join(LUMEN_DIR, "lumen-desktop-tasks.json");
const SHOT_DIR = path.join(LUMEN_DIR, "vm-home", ".shots");

/* ============ 版本与更新（检查 + 一键 git pull；绝不静默自动更新） ============
 * 用户克隆的是本地运行的应用：没有中心服务器替他们部署。
 * 这里提供两条能力，均需用户主动触发：
 *  · GET  /update/check  本地 HEAD vs origin/main（git fetch 精确计数），
 *                         非 git 克隆（ZIP 下载）降级为版本号比较
 *  · POST /update/apply  git pull --ff-only（脏工作区拒绝；执行后需重启服务桥）
 * ============ */

const PKG = require("./package.json");
const LUMEN_REPO = process.env.LUMEN_REPO || "ergou-yu/lumen";

async function ghJson(path) {
  try {
    const r = await httpGet("https://api.github.com" + path, 10000, 512 * 1024);
    return { ok: r.status === 200, status: r.status, data: JSON.parse(r.body) };
  } catch (e) { return { ok: false, error: e.message }; }
}

let lastUpdateInfo = null; // 供诊断页展示最近一次检查结果

async function updateCheck() {
  const res = {
    repo: LUMEN_REPO,
    local: { version: PKG.version, sha: null },
    mode: "git", updateAvailable: false, behind: 0, commits: [], note: "", dirty: false,
  };
  const head = await sh("git", ["rev-parse", "HEAD"], 8000);
  if (!head.ok) {
    // ZIP 下载等非 git 环境：用版本号比较（raw package.json）
    res.mode = "download";
    res.note = "当前目录不是 git 克隆（可能来自 ZIP 下载）";
    try {
      const raw = await httpGet("https://raw.githubusercontent.com/" + LUMEN_REPO + "/main/package.json", 10000, 64 * 1024);
      const remote = JSON.parse(raw.body);
      res.remoteVersion = remote.version || "?";
      res.updateAvailable = String(remote.version || "") !== PKG.version;
    } catch (e) { res.note += "；远端版本获取失败（离线？）"; }
    return res;
  }
  res.local.sha = head.out.trim().slice(0, 12);
  const st = await sh("git", ["status", "--porcelain"], 8000);
  res.dirty = st.ok && st.out.trim().length > 0; // 有未提交改动：一键更新会拒绝

  const fetch = await sh("git", ["fetch", "--quiet", "origin", "main"], 30000);
  if (fetch.ok) {
    const cnt = await sh("git", ["rev-list", "--count", "HEAD..FETCH_HEAD"], 8000);
    res.behind = parseInt(cnt.out.trim(), 10) || 0;
    if (res.behind > 0) {
      res.updateAvailable = true;
      const log = await sh("git", ["log", "--oneline", "--no-decorate", "-n", "30", "HEAD..FETCH_HEAD"], 8000);
      res.commits = log.out.split("\n").map(l => l.trim()).filter(Boolean)
        .slice(0, 30).map(l => l.replace(/^[0-9a-f]{7,} /, ""));
    }
    return res;
  }
  // fetch 失败（网络/权限）：退回 GitHub API 比较
  res.mode = "git-api";
  res.note = "git fetch 失败，改用 GitHub API 比较（" + String(fetch.err || "").slice(0, 60) + "）";
  const api = await ghJson("/repos/" + LUMEN_REPO + "/commits?per_page=10");
  if (api.ok && Array.isArray(api.data) && api.data.length) {
    res.remoteSha = api.data[0].sha.slice(0, 12);
    if (res.remoteSha !== res.local.sha) {
      res.updateAvailable = true;
      res.commits = api.data.map(c => String((c.commit && c.commit.message) || "").split("\n")[0].slice(0, 80)).filter(Boolean);
    }
  } else {
    res.note += "；GitHub API 不可达";
  }
  return res;
}

async function updateApply() {
  const head = await sh("git", ["rev-parse", "HEAD"], 8000);
  if (!head.ok) {
    return { ok: false, error: "当前目录不是 git 克隆。请到 " + LUMEN_REPO + " 重新下载新版，或先 git clone 后再使用一键更新。" };
  }
  const st = await sh("git", ["status", "--porcelain"], 8000);
  if (st.ok && st.out.trim().length) {
    return { ok: false, error: "本地有未提交的改动，为避免覆盖已拒绝更新。请先 git stash / 提交，或手动处理后再试。", dirty: st.out.trim().split("\n").slice(0, 5) };
  }
  const pull = await sh("git", ["pull", "--ff-only", "--quiet", "origin", "main"], 120000);
  if (!pull.ok) {
    return { ok: false, error: "git pull 失败（" + String(pull.err || pull.out || "").slice(0, 200) + "）。请手动执行 git pull 排查。" };
  }
  const after = await sh("git", ["rev-parse", "--short", "HEAD"], 8000);
  let newVer = PKG.version;
  try { newVer = JSON.parse(fs.readFileSync(path.join(LUMEN_DIR, "package.json"), "utf8")).version || PKG.version; } catch (e) {}
  return {
    ok: true,
    nowAt: after.out.trim(),
    version: newVer,
    note: "更新完成：请重启服务桥（Ctrl+C 停止后重新 node server.js）让新代码生效；浏览器随后刷新页面。",
  };
}

const SENTINEL_GRANT_MS = 10 * 60 * 1000; // 能力凭证有效期（对标：绑定用途与期限）
const DTASK_MAX_STEPS = 14;

try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch (e) {}

function sh(cmd, args, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(cmd, args, { timeout: timeoutMs || 30000, maxBuffer: 8 * 1024 * 1024 },
      function (err, stdout, stderr) {
        resolve({ ok: !err, code: err && err.code, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") });
      });
  });
}

/* ---------- 动作规则（对标 dots 的 Custom Rules：允许/先问/转交本人） ----------
 * 规则由用户在设置页维护、实时同步到服务桥（lumen-rules.json），Sentinel 审查动作时优先查规则：
 *   auto    —— 命中即放行（等效 dots 的“无需询问直接做”）
 *   ask     —— 命中必须用户批准（“行动前先问”）
 *   handoff —— 命中直接拒绝并转交本人执行（“转交给你”）
 * 规则只能放宽“要不要问”，永远不能越过硬拦截（SSRF/恶意站点/敏感字段审批）。
 * ---------- */

const NOTIFY_FILE = path.join(LUMEN_DIR, "lumen-notify.json");
let notifyCfg = { webhook: "" };
try { notifyCfg = Object.assign(notifyCfg, JSON.parse(fs.readFileSync(NOTIFY_FILE, "utf8")) || {}); } catch (e) {}
function fireWebhook(title, text) {
  return new Promise(function (resolve) {
    if (!notifyCfg.webhook) return resolve({ sent: false, reason: "未配置 Webhook" });
    let u;
    try { u = new URL(notifyCfg.webhook); } catch (e) { return resolve({ sent: false, reason: "Webhook 地址非法" }); }
    const payload = JSON.stringify({ title: title, text: text, ts: Date.now(), source: "lumen" });
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 8000 }, function (res) { res.resume(); resolve({ sent: res.statusCode < 500, status: res.statusCode }); });
    req.on("timeout", function () { req.destroy(new Error("webhook 超时")); });
    req.on("error", function (e) { resolve({ sent: false, reason: e.message }); });
    req.end(payload);
  });
}

const RULES_FILE = path.join(LUMEN_DIR, "lumen-rules.json");
let customRules = [];
try { customRules = JSON.parse(fs.readFileSync(RULES_FILE, "utf8")) || []; } catch (e) { customRules = []; }
function rulesSave() {
  try { fs.writeFileSync(RULES_FILE, JSON.stringify(customRules, null, 2)); } catch (e) {}
}
// 规则匹配：关键词按 空格/、/｜/， 拆分，全部子串命中才算匹配（AND 语义，避免误伤）
function matchRule(text) {
  const hay = String(text || "");
  for (const r of customRules) {
    if (!r || !r.keywords || !r.mode) continue;
    const kws = String(r.keywords).split(/[\s、|｜，,]+/).map(k => k.trim()).filter(Boolean);
    if (!kws.length) continue;
    if (kws.every(k => hay.includes(k))) return r;
  }
  return null;
}

/* ---------- 凭证安全区（模型永远拿不到明文） ---------- */

function vaultLoad() {
  try { return JSON.parse(fs.readFileSync(VAULT_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function vaultSave(v) {
  fs.writeFileSync(VAULT_FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
  try { fs.chmodSync(VAULT_FILE, 0o600); } catch (e) {}
}
// 对外只暴露名称与类型，绝不暴露值
function vaultPublic() {
  const v = vaultLoad();
  return Object.keys(v).map(function (name) { return { name: name, kind: v[name].kind || "文本" }; });
}

/* ---------- Sentinel：唯一审批权威（容器之外） ---------- */

// 已知恶意/高风险站点模式（可用项目根 vm-denylist.txt 一行一条追加）
let denylistExtra = [];
try { denylistExtra = fs.readFileSync(path.join(LUMEN_DIR, "vm-denylist.txt"), "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean); } catch (e) {}
const DENYLIST = [
  /\.(zip|tk|top|xyz)\/.*(login|verify|wallet|metamask)/i,
  /-?(coinbase|metamask|ledger|trezor)[a-z0-9-]*\.(?!com)/i,
  /free-[a-z0-9-]+-(nitro|gift|giveaway)/i,
  /(porn|casino|betting|gambling)\./i,
].concat(denylistExtra.map(function (s) { try { return new RegExp(s, "i"); } catch (e) { return null; } }).filter(Boolean));

// 私网/回环地址（SSRF 拦截，对标 Sentinel 的 L4 审查）
function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(10\.|127\.|169\.254\.|0\.)/.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.includes(":") && /^(fc|fd|fe80)/i.test(h)) return true; // IPv6 内网
  return false;
}

// 对外动作/敏感字段关键词（触发用户审批；对标「发送邮件、支付须确认」）
const SENSITIVE_ACT = /支付|付款|下单|购买|订[单阅]|结[算账]|转账|充值|确认订单|提交订单|buy|pay|checkout|subscribe/i;
const SENSITIVE_FIELD = /password|passwd|密码|cvv|cvc|card[_-]?num|卡号|验证码|otp|身份证|证件号|手机号|tel|phone|邮箱|email/i;
const SENSITIVE_SECRET_VALUE = /^\d{12,19}$/; // 长数字串视作卡号类

const grants = []; // 已发放的能力凭证 {digest, exp, scope}
function grantToken(digest, scope) {
  grants.push({ digest: digest, exp: Date.now() + SENTINEL_GRANT_MS, scope: scope || "action" });
  if (grants.length > 50) grants.splice(0, grants.length - 50);
}
function hasGrant(digest) {
  const now = Date.now();
  for (let i = grants.length - 1; i >= 0; i--) {
    if (grants[i].exp < now) { grants.splice(i, 1); continue; }
    if (grants[i].digest === digest) return true;
  }
  return false;
}
function digestOf(action) {
  return [action.op, action.url || "", action.n || "", action.secret || "", action.sensitive ? "s" : ""].join("|");
}

/**
 * Sentinel 审查：返回 {verdict: "allow"|"block"|"ask", reason, approval?}
 * 设计语义：干净的低风险动作直接放行（免打扰）；触网敏感动作必须交用户批准；
 * 恶意目标直接阻止；批准后发限时能力凭证，同类动作 10 分钟内不再打扰。
 */
function sentinelReview(action, observeCtx) {
  const op = action.op;
  const a = action.args || {};

  if (op === "navigate") {
    let u;
    try { u = new URL(a.url); } catch (e) { return { verdict: "block", reason: "地址不合法" }; }
    if (!/^https?:$/.test(u.protocol)) return { verdict: "block", reason: "仅允许 http(s)" };
    // 豁免：容器内浏览器访问宿主上的本服务桥（host.docker.internal:自身端口）——
    // 这是「下载直通」等本地能力的合法通道；其余私网地址仍然全部拦截
    const isLocalBridge = u.hostname === "host.docker.internal" && (u.port === String(PORT) || (u.port === "" && PORT === "80"));
    if (isPrivateHost(u.hostname) && !isLocalBridge) return { verdict: "block", reason: "SSRF 拦截：私网/回环地址禁止访问" };
    for (const re of DENYLIST) if (re.test(u.href)) return { verdict: "block", reason: "命中恶意站点拦截名单" };
    {
      const r = matchRule("navigate " + u.hostname + " " + u.href);
      if (r) {
        if (r.mode === "handoff") return { verdict: "block", reason: "按你的规则「" + r.keywords + "」：转交本人执行" };
        if (r.mode === "ask") return { verdict: "ask", reason: "命中规则「" + r.keywords + "」：打开 " + u.hostname + " 需你确认", approval: { title: "规则要求确认", detail: "你的规则「" + r.keywords + "」要求打开此类页面前先问你：\n" + u.href, digest: "rule|" + u.hostname } };
        return { verdict: "allow", reason: "规则「" + r.keywords + "」放行" };
      }
    }
    return { verdict: "allow", reason: "导航到 " + u.hostname };
  }

  if (op === "fill") {
    const text = String(a.text || "");
    const el = findElementMeta(a.n, observeCtx);
    const sensitiveField = (el && (el.sensitive || SENSITIVE_FIELD.test((el.name || "") + (el.placeholder || "") + (el.text || "") + (el.type || "")))) ||
      SENSITIVE_SECRET_VALUE.test(text.replace(/\s/g, ""));
    const digest = digestOf({ op: "fill", n: a.n, sensitive: true });
    if (sensitiveField) {
      const frule = matchRule("fill " + ((el && (el.placeholder || el.name || el.text)) || "敏感字段"));
      if (frule && frule.mode === "handoff") return { verdict: "block", reason: "按你的规则「" + frule.keywords + "」：转交本人填写" };
      if (frule && frule.mode === "auto") return { verdict: "allow", reason: "规则「" + frule.keywords + "」放行" };
      if (hasGrant(digest)) return { verdict: "allow", reason: "能力凭证有效期内" };
      return {
        verdict: "ask",
        reason: "向敏感字段输入内容（" + ((el && (el.placeholder || el.name || el.text)) || "字段") + "）",
        approval: {
          title: "填写敏感字段",
          detail: "Lumi 要在页面的「" + ((el && (el.placeholder || el.name || el.text)) || "敏感") +
            "」字段里输入一段内容（已掩码：「" + String(text).slice(0, 2) + "••••••」，长度 " + text.length + "）。\n建议：涉及密码/卡号/验证码时，可改用「安全区凭证」（设置 → 虚拟计算机 → 安全区），获批后由服务桥直接注入，模型全程看不到明文。",
          digest: digest,
        },
      };
    }
    return { verdict: "allow", reason: "普通输入" };
  }

  if (op === "click") {
    const el = findElementMeta(a.n, observeCtx);
    const label = (el && (el.text || el.placeholder || el.name || el.tag)) || ("元素 #" + a.n);
    const rule = matchRule("click " + label);
    if (SENSITIVE_ACT.test(label)) {
      const digest = digestOf({ op: "click", n: a.n, sensitive: true });
      if (rule && rule.mode === "auto") return { verdict: "allow", reason: "规则「" + rule.keywords + "」放行（敏感动作）" };
      if (hasGrant(digest)) return { verdict: "allow", reason: "能力凭证有效期内" };
      return {
        verdict: "ask",
        reason: "点击对外动作按钮：「" + label.slice(0, 30) + "」",
        approval: {
          title: "执行对外动作",
          detail: "Lumi 要点击「" + label.slice(0, 40) + "」。这可能产生下单、支付、发送或提交等对外后果，需要你批准。（已保存支付方式的商家，每次购买都会请你确认；也可在 设置 → 规则 里为此类动作配置放行/转交规则）",
          digest: digest,
        },
      };
    }
    if (rule) {
      if (rule.mode === "handoff") return { verdict: "block", reason: "按你的规则「" + rule.keywords + "」：转交本人执行" };
      if (rule.mode === "ask") return { verdict: "ask", reason: "命中规则「" + rule.keywords + "」：点击「" + label.slice(0, 24) + "」需你确认", approval: { title: "规则要求确认", detail: "你的规则「" + rule.keywords + "」要求此类点击先问你：\n点击「" + label.slice(0, 50) + "」", digest: "rule|" + label.slice(0, 30) } };
      return { verdict: "allow", reason: "规则「" + rule.keywords + "」放行" };
    }
    return { verdict: "allow", reason: "点击「" + String(label).slice(0, 24) + "」" };
  }

  // key/scroll/tab/wait/read/observe：本地操作，放行
  return { verdict: "allow", reason: op };
}

// 从最近一次观察里找元素元信息（Sentinel 判定要用，不能只信任务侧）
let lastObserveCtx = null;
function findElementMeta(n, ctx) {
  const src = ctx && ctx.elements ? ctx : lastObserveCtx;
  if (!src || !src.elements) return null;
  for (const el of src.elements) if (el.n === parseInt(n, 10)) return el;
  return null;
}

/* ---------- 容器生命周期 ---------- */

const box = { state: "unknown", ports: null, error: "" }; // state: unknown|building|starting|running|stopped|nodocker

async function dockerAvailable() {
  const r = await sh("docker", ["info", "--format", "{{.ServerVersion}}"], 10000);
  return r.ok ? r.out.trim() : null;
}

async function boxImageExists() {
  const r = await sh("docker", ["images", "-q", BOX_IMAGE], 15000);
  return r.ok && r.out.trim().length > 0;
}

async function boxBuild(onLog) {
  box.state = "building";
  const r = await new Promise(function (resolve) {
    const child = spawn("docker", ["build", "-t", BOX_IMAGE, BOX_DIR], { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    child.stdout.on("data", function (d) { tail = (tail + d.toString()).slice(-4000); if (onLog) onLog(d.toString()); });
    child.stderr.on("data", function (d) { tail = (tail + d.toString()).slice(-4000); if (onLog) onLog(d.toString()); });
    child.on("error", function (e) { resolve({ ok: false, err: e.message }); });
    child.on("close", function (code) { resolve({ ok: code === 0, err: tail.slice(-1500) }); });
  });
  box.state = r.ok ? "stopped" : "unknown";
  return r;
}

async function boxContainerStatus() {
  const r = await sh("docker", ["ps", "-a", "--filter", "name=^" + BOX_NAME + "$", "--format", "{{.Names}} {{.Status}}"], 15000);
  if (!r.ok || !r.out.trim()) return null;
  const m = r.out.trim().match(/^(\S+)\s+(.*)$/);
  return { name: m[1], status: m[2], running: /Up /i.test(m[2]) };
}

// 服务桥重启后内存状态会丢：从 docker 现场重新发现容器与端口（幂等，便宜）
async function boxSyncState() {
  if (box.state === "running" && box.ports) return true;
  try {
    const st = await boxContainerStatus();
    if (st && st.running) {
      const pm = await sh("docker", ["port", BOX_NAME], 15000);
      const ports = { http: null, vnc: null };
      for (const line of pm.out.split("\n")) {
        const m = line.match(/^(3900|6901)\/tcp -> 127\.0\.0\.1:(\d+)/);
        if (m) ports[m[1] === "3900" ? "http" : "vnc"] = parseInt(m[2], 10);
      }
      if (ports.http && ports.vnc) {
        box.ports = ports;
        box.state = "running";
        return true;
      }
    }
  } catch (e) {}
  return false;
}

async function boxStart() {
  const daemon = await dockerAvailable();
  if (!daemon) { box.state = "nodocker"; return { ok: false, error: "Docker 未安装或未启动（请先打开 Docker Desktop）" }; }
  const st = await boxContainerStatus();
  if (st && st.running) { /* 已在跑，直接探测端口 */ }
  else {
    if (st) await sh("docker", ["rm", "-f", BOX_NAME], 30000); // 残留容器清理
    if (!(await boxImageExists())) {
      const b = await boxBuild();
      if (!b.ok) return { ok: false, error: "镜像构建失败：\n" + b.err };
    }
    box.state = "starting";
    // 非特权 + 最小能力（对标 systemd-nspawn 的攻击面收缩）
    const r = await sh("docker", ["run", "-d", "--name", BOX_NAME,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "512", "--memory", "2g", "--cpus", "1.5",
      "--shm-size", "512m", "--tmpfs", "/tmp:rw,size=128m",
      "--init", "--restart", "unless-stopped",
      "-v", "lumen-box-home:/home/node",
      // 下载直通：容器浏览器的下载目录 = 宿主 vm-home（「计算机」页实时可见、可下载；
      // 反向上传到 vm-home 的文件也会出现在容器 Downloads 里供代理使用）
      "-v", path.join(VM_HOME, "") + ":/home/node/Downloads",
      "-p", "127.0.0.1::3900", "-p", "127.0.0.1::6901",
      BOX_IMAGE], 60000);
    if (!r.ok) { box.state = "stopped"; return { ok: false, error: "容器启动失败：" + r.err.slice(0, 400) }; }
  }
  // 发现宿主端口（随机映射 → docker port 查询）
  const pm = await sh("docker", ["port", BOX_NAME], 15000);
  const ports = { http: null, vnc: null };
  for (const line of pm.out.split("\n")) {
    const m = line.match(/^(3900|6901)\/tcp -> 127\.0\.0\.1:(\d+)/);
    if (m) ports[m[1] === "3900" ? "http" : "vnc"] = parseInt(m[2], 10);
  }
  if (!ports.http || !ports.vnc) { box.state = "stopped"; return { ok: false, error: "端口发现失败：" + pm.out }; }
  box.ports = ports;
  // 等健康（Chromium 冷启动可能 10s+）
  for (let i = 0; i < 40; i++) {
    try {
      const h = await new Promise(function (resolve, reject) {
        const req = http.get("http://127.0.0.1:" + ports.http + "/health", { timeout: 3000 }, function (res) {
          const chunks = []; res.on("data", c => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
        });
        req.on("timeout", () => req.destroy(new Error("t")));
        req.on("error", reject);
      });
      if (h && h.ok) { box.state = "running"; return { ok: true, ports: ports, health: h }; }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  box.state = "stopped";
  return { ok: false, error: "容器健康检查超时（docker logs " + BOX_NAME + " 查看）" };
}

async function boxStop() {
  await sh("docker", ["stop", BOX_NAME], 60000);
  box.state = "stopped";
  box.ports = null;
  return { ok: true };
}

async function boxFetch(pathname, options) {
  if (box.state !== "running" || !box.ports) throw new Error("桌面虚拟机未运行");
  return new Promise(function (resolve, reject) {
    const req = http.request("http://127.0.0.1:" + box.ports.http + pathname,
      Object.assign({ timeout: 30000 }, options || {}), function (res) {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
    req.on("timeout", () => req.destroy(new Error("box 请求超时")));
    req.on("error", reject);
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

async function boxJson(pathname, body) {
  const r = await boxFetch(pathname, body ? {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : {});
  let data = null;
  try { data = JSON.parse(r.body.toString("utf8")); } catch (e) { data = { ok: false, error: r.body.toString().slice(0, 200) }; }
  return data;
}

/* ---------- 桌面任务运行器（宿主侧 7×24；浏览器只是遥控器） ---------- */

let dtasks = [];
try { dtasks = JSON.parse(fs.readFileSync(DTASKS_FILE, "utf8")) || []; } catch (e) { dtasks = []; }
let dtasksSaveTimer = null;
function dtasksSave() {
  if (dtasksSaveTimer) clearTimeout(dtasksSaveTimer);
  dtasksSaveTimer = setTimeout(function () {
    try { fs.writeFileSync(DTASKS_FILE, JSON.stringify(dtasks.slice(0, 40), null, 2)); } catch (e) {}
  }, 400);
}

function dtaskPublic(t) {
  return {
    id: t.id, goal: t.goal, status: t.status, steps: t.steps.slice(-24),
    evidence: (t.evidence || []).slice(-6).map(e => ({ title: e.title, url: e.url, text: String(e.text || "").slice(0, 1800) })),
    summary: t.summary || "", pendingApproval: t.pendingApproval || null,
    createdAt: t.createdAt, updatedAt: t.updatedAt, modelCalls: t.modelCalls || 0,
    shot: t.shot || null, noteFile: t.noteFile || "",
  };
}

function dstep(t, kind, label, extra) {
  t.steps.push(Object.assign({ t: Date.now(), kind: kind, label: String(label).slice(0, 160) }, extra || {}));
  t.updatedAt = Date.now();
  dtasksSave();
}

// 任务内轮询：等待用户在浏览器里对 pendingApproval 做决定
function waitApproval(t) {
  return new Promise(function (resolve) {
    const started = Date.now();
    const timer = setInterval(function () {
      if (t.status === "stopped") { clearInterval(timer); resolve("stopped"); return; }
      if (!t.pendingApproval) { clearInterval(timer); resolve(t._lastDecision || "deny"); return; }
      if (Date.now() - started > 10 * 60 * 1000) { // 10 分钟无人应答 → 视为拒绝
        t.pendingApproval = null;
        t._lastDecision = "deny";
        clearInterval(timer); resolve("deny");
      }
    }, 800);
  });
}

async function dtaskModel(prompt, shotPath) {
  if (!serverModelReady()) return { error: "服务端模型未配置（环境变量 LUMEN_MODEL_API_KEY / LUMEN_MODEL_BASE），桌面任务需要它驱动" };
  // 视觉观察：把最近桌面截图一并交给模型（Canvas/WebGL 游戏没有 DOM 元素，只能看画面）
  let content = [{ type: "text", text: prompt }];
  if (shotPath) {
    try {
      const buf = fs.readFileSync(shotPath);
      if (buf.length > 0 && buf.length < 3 * 1024 * 1024) {
        content.unshift({ type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } });
      }
    } catch (e) {}
  }
  const body = JSON.stringify({
    model: MODEL_NAME,
    max_tokens: 4096, // 思考型模型：推理计入输出配额，太低会把 JSON 正文截空
    system: "你是 LumenBox 桌面虚拟机的操作规划器。你在自己的隔离虚拟机里操作真实浏览器（用户可实时观看）。你会同时收到：一张当前桌面截图 + 页面元素清单。画面内容以截图为准（很多游戏是纯 Canvas，元素清单为空时完全靠截图）。思考要短，最终只输出一个 JSON 动作，不要任何多余文字。",
    messages: [{ role: "user", content: content }],
  });
  return new Promise(function (resolve) {
    const upReq = upstreamRequest(body, function (upRes) {
      const chunks = [];
      upRes.on("data", c => chunks.push(c));
      upRes.on("end", function () {
        try {
          const a = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const text = (a.content || []).filter(b => b.type === "text").map(b => b.text).join("");
          resolve({ text: text });
        } catch (e) { resolve({ error: "模型响应解析失败" }); }
      });
    });
    upReq.on("error", () => resolve({ error: "模型调用失败" }));
    upReq.end(body);
  });
}

// 暂停：任务循环在每步之间挂起（不撤销已做动作；Resume 继续 —— 对标 dots 的 Pause/Resume）
function waitIfPaused(t) {
  return new Promise(function (resolve) {
    const timer = setInterval(function () {
      if (t.status !== "paused" || t.status === "stopped") { clearInterval(timer); resolve(); }
    }, 800);
  });
}

async function runDesktopTask(t) {
  t.status = "running";
  dstep(t, "phase", "唤醒桌面虚拟机");
  const start = await boxStart();
  if (!start.ok) {
    dstep(t, "error", "虚拟机启动失败：" + start.error.slice(0, 120));
    t.status = "failed";
    t.summary = "虚拟机不可用：" + start.error.slice(0, 200);
    dtasksSave();
    return;
  }
  dstep(t, "phase", "虚拟机就绪（端口 " + box.ports.http + "/" + box.ports.vnc + " · 可在「计算机」页实时观看）");

  let steps = 0;
  let lastObs = null;
  let deniedStreak = 0;

  while (steps < DTASK_MAX_STEPS && t.status !== "stopped") {
    if (t.status === "paused") await waitIfPaused(t);
    if (t.status === "stopped") break;
    steps++;
    // 1) 观察
    let obs;
    try {
      obs = await boxJson("/observe?max=40");
      lastObserveCtx = obs;
      lastObs = obs;
    } catch (e) {
      dstep(t, "error", "观察失败：" + e.message);
      break;
    }
    if (!obs || !obs.ok) { dstep(t, "error", "观察失败：" + String(obs && obs.error || "").slice(0, 120)); break; }

    // 存档截图（限最近 3 张，避免膨胀）
    try {
      const shot = await boxFetch("/screen.png");
      const file = path.join(SHOT_DIR, t.id + "-" + steps + ".png");
      fs.writeFileSync(file, shot.body);
      t.shot = path.basename(file);
      const olds = fs.readdirSync(SHOT_DIR).filter(f => f.startsWith(t.id + "-")).sort();
      while (olds.length > 3) { try { fs.unlinkSync(path.join(SHOT_DIR, olds.shift())); } catch (e) {} }
      dtasksSave();
    } catch (e) {}

    // 2) 模型规划
    const elLines = (obs.elements || []).slice(0, 40).map(el =>
      el.n + ". <" + el.tag + (el.type ? " type=" + el.type : "") + (el.sensitive ? " [敏感]" : "") + "> " + (el.text || el.placeholder || el.name || "") +
      " @(" + el.x + "," + el.y + ")"
    ).join("\n");
    const vaultLine = vaultPublic().length ? "可用安全区凭证（用 secret 引用，值你拿不到）：" + vaultPublic().map(v => v.name).join("、") : "";
    const prompt = [
      "任务目标：" + t.goal,
      "",
      "当前页面：" + obs.url,
      "标题：" + obs.title + "（滚动 " + obs.scrollY + "/" + obs.pageH + "）",
      "可交互元素（n 为编号，@ 后是屏幕坐标）：",
      elLines || "（无可交互元素）",
      vaultLine,
      "",
      "已执行 " + (steps - 1) + "/" + DTASK_MAX_STEPS + " 步。" + (t._lastNote || ""),
      "已收集证据页：" + ((t.evidence || []).map(e => e.title).join("、") || "无"),
      "",
      "只输出一个 JSON（无多余文字），动作从这些里选：",
      '{"op":"navigate","args":{"url":"https://…"},"why":"…"} 打开网址',
      '{"op":"click","args":{"n":1},"why":"…"} 点击第 n 个元素',
      '{"op":"fill","args":{"n":2,"text":"要输入的文本"},"why":"…"} 往第 n 个元素输入文本（敏感信息禁止写明文，用 secret）',
      '{"op":"fill","args":{"n":2,"secret":"安全区凭证名"},"why":"…"} 获批后由服务桥把凭证值直接注入该字段（你不知道值）',
      '{"op":"key","args":{"key":"Left/Right/Up/Down/Return/Escape/space/w/a/s/d 等"},"why":"…"} 按键（游戏操控主要靠它；截图里看到的操作提示照着按）',
      '{"op":"scroll","args":{"dy":600},"why":"…"} 滚动页面',
      '{"op":"read","args":{},"why":"…"} 读取当前页正文作为证据',
      '{"op":"tabnew","args":{},"why":"…"} / {"op":"tablist","args":{},"why":"…"} / {"op":"tabswitch","args":{"n":1},"why":"…"} 标签页',
      '{"op":"wait","args":{"ms":1500},"why":"…"} 等页面加载',
      '{"op":"done","args":{"summary":"一句话成果"},"why":"…"} 任务完成',
      "规则：信息足够就 done；被 Sentinel 拒绝过的动作换路径；不要重复无效动作；Canvas 游戏元素清单为空时，依据截图判断当前状态并用 key 动作操作。",
    ].join("\n");
    const rep = await dtaskModel(prompt, t.shot ? path.join(SHOT_DIR, t.shot) : null);
    if (rep.error) { dstep(t, "error", "模型调用失败：" + rep.error); break; }
    t.modelCalls = (t.modelCalls || 0) + 1;
    const m = String(rep.text || "").match(/\{[\s\S]*\}/);
    if (!m) {
      // 模型没按 JSON 说话：纠偏重试一次；仍不行就把这段话当成果总结收工（模型收尾爱总结）
      if (!t._jsonRetry) {
        t._jsonRetry = true;
        t._lastNote = "你上一条输出不是 JSON。请严格只输出一个 JSON 动作对象，不要任何解释文字。";
        dstep(t, "info", "模型输出格式异常，已要求严格 JSON 重试");
        continue;
      }
      t.summary = String(rep.text || "").trim().slice(0, 400) || "任务结束（模型未给出动作）";
      dstep(t, "done", "完成：" + t.summary.slice(0, 80));
      break;
    }
    let act;
    try { act = JSON.parse(m[0]); } catch (e) {
      if (!t._jsonRetry) {
        t._jsonRetry = true;
        t._lastNote = "上一条 JSON 解析失败。请严格只输出一个合法的 JSON 动作对象。";
        dstep(t, "info", "动作 JSON 解析失败，已纠偏重试");
        continue;
      }
      t.summary = "任务结束（动作 JSON 无法解析）";
      dstep(t, "done", "完成：" + t.summary);
      break;
    }
    t._jsonRetry = false;
    if (!act.op) { dstep(t, "error", "动作缺少 op"); break; }

    // 3) 完成
    if (act.op === "done") {
      t.summary = String(act.args && act.args.summary || act.why || "任务完成").slice(0, 400);
      dstep(t, "done", "完成：" + t.summary);
      break;
    }

    // 4) Sentinel 审查（容器之外、任务循环之内）
    const review = sentinelReview(act, lastObs);
    if (review.verdict === "block") {
      t._lastNote = "Sentinel 阻止了 " + act.op + "：" + review.reason;
      dstep(t, "sentinel", "⛔ 阻止 " + act.op + " —— " + review.reason);
      deniedStreak++;
      if (deniedStreak >= 3) break;
      continue;
    }
    if (review.verdict === "ask") {
      t.pendingApproval = Object.assign({ id: "apr-" + Date.now().toString(36), t: Date.now() }, review.approval);
      t.status = "waiting_approval";
      fireWebhook("⚠️ 桌面任务等你批准", "目标：" + t.goal.slice(0, 60) + "\n动作：" + review.reason.slice(0, 60));
      dstep(t, "sentinel", "⚠ 请求批准 —— " + review.reason);
      dtasksSave();
      const decision = await waitApproval(t);
      t.pendingApproval = null;
      t.status = "running";
      delete t._lastDecision;
      if (decision === "stopped") { dstep(t, "info", "任务在等待批准时被停止"); break; }
      if (decision === "deny") {
        t._lastNote = "用户拒绝了：" + review.reason + "；换路径或收尾。";
        dstep(t, "sentinel", "🚫 你拒绝了 —— " + review.reason);
        deniedStreak++;
        if (deniedStreak >= 3) break;
        continue;
      }
      grantToken(review.approval.digest, review.reason); // 发放限时能力凭证
      dstep(t, "sentinel", "✅ 已批准（能力凭证 10 分钟）—— " + review.reason);
    }

    // 5) 凭证替换：secret 引用 → 宿主取值直注容器，值不进任何日志/上下文
    let execAct = act;
    if (act.op === "fill" && act.args && act.args.secret) {
      const v = vaultLoad();
      const ent = v[act.args.secret];
      if (!ent) {
        t._lastNote = "安全区里没有凭证「" + act.args.secret + "」";
        dstep(t, "sentinel", "⛔ 安全区无此凭证：" + act.args.secret);
        continue;
      }
      execAct = { op: "secret-type", args: { n: act.args.n, value: ent.value }, _secretName: act.args.secret };
      dstep(t, "act", "注入安全区凭证「" + act.args.secret + "」→ 字段 #" + act.args.n + "（明文不进上下文）");
    } else {
      dstep(t, "act", (act.op === "fill" ? "输入" : act.op) + " —— " + String(act.why || describeAct(act)).slice(0, 90));
    }

    // 6) 执行（容器内真实 GUI 事件）
    let result;
    try {
      result = await boxJson("/act", { op: execAct.op, args: execAct.args });
    } catch (e) { result = { ok: false, error: e.message }; }
    if (!result || !result.ok) {
      t._lastNote = "动作失败：" + String(result && result.error || "").slice(0, 80);
      dstep(t, "act", "动作失败 —— " + t._lastNote);
      continue;
    }
    deniedStreak = 0;
    delete t._lastNote;

    // 7) 证据页收集（导航/点击后读正文；read 动作直接返回正文）
    if (act.op === "read" && result.text) {
      pushEvidence(t, obs.title, obs.url, result.text);
      dstep(t, "evidence", "读取正文 —— " + String(obs.title || "").slice(0, 50) + "（" + result.text.length + " 字）");
    } else if ((act.op === "navigate" || act.op === "click") ) {
      await new Promise(r => setTimeout(r, 700));
      try {
        const rd = await boxJson("/act", { op: "read", args: {} });
        if (rd && rd.ok && rd.text) pushEvidence(t, rd.title, rd.url, rd.text);
      } catch (e) {}
    }
  }

  if (t.status !== "stopped" && t.status !== "paused") t.status = "done";
  t.updatedAt = Date.now();
  fireWebhook("✅ 桌面任务结束：" + t.status, "目标：" + t.goal.slice(0, 60) + "\n" + (t.summary || "共 " + (t.steps || []).length + " 步").slice(0, 120));

  // 笔记落进 LumenBox 工作区（任务草稿保存在虚拟机内）
  if ((t.evidence || []).length) {
    const d = new Date();
    const dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const fname = "notes/" + dateStr + "-" + String(t.goal).replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 18) + ".md";
    const content = "# 桌面虚拟机任务笔记 · " + dateStr + "\n\n> 目标：" + t.goal + "\n> 在 LumenBox Desktop（容器化桌面虚拟机）上完成，Sentinel 全程审查。\n\n" +
      t.steps.map(s => "- " + s.label).join("\n") + "\n\n## 证据页\n\n" +
      t.evidence.map((e, i) => "### " + (i + 1) + ". " + e.title + "（" + e.url + "）\n" + String(e.text || "").slice(0, 1800)).join("\n\n");
    try { vmFilesExec("write", { name: fname, content: content }); t.noteFile = fname; } catch (e) {}
  }
  dtasksSave();
}

function describeAct(act) {
  const a = act.args || {};
  if (act.op === "navigate") return "打开 " + String(a.url || "").slice(0, 60);
  if (act.op === "click") return "点击 #" + a.n;
  if (act.op === "fill") return "填写 #" + a.n;
  return act.op;
}

function pushEvidence(t, title, url, text) {
  t.evidence = t.evidence || [];
  if (t.evidence.some(e => e.url === url)) return;
  t.evidence.push({ title: String(title || url).slice(0, 90), url: url, text: String(text || "").slice(0, 4000) });
  if (t.evidence.length > 8) t.evidence.shift();
}

function desktopStatus() {
  return {
    ok: true,
    state: box.state,
    ports: box.ports,
    novncUrl: box.state === "running" && box.ports ? "http://127.0.0.1:" + box.ports.vnc + "/vnc.html?autoconnect=1&resize=scale" : null,
    image: BOX_IMAGE,
  };
}

/* ============ 后台监控任务（7×24：浏览器关了也继续跑） ============
 * 云端常驻执行的本地形态：任务存 lumen-tasks.json，
 * 服务桥进程内定时器驱动——真实检索 → 模型判断是否命中 → 记录结果。
 * 浏览器只是遥控器：重连后经 /tasks 拉取状态与命中记录。
 * ============ */

const TASKS_FILE = path.join(LUMEN_DIR, "lumen-tasks.json");
let bgTasks = [];
try { bgTasks = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")) || []; } catch (e) { bgTasks = []; }
let tasksSaveTimer = null;
function saveTasks() {
  if (tasksSaveTimer) clearTimeout(tasksSaveTimer);
  tasksSaveTimer = setTimeout(function () {
    try { fs.writeFileSync(TASKS_FILE, JSON.stringify(bgTasks, null, 2)); } catch (e) { console.warn("任务保存失败", e.message); }
  }, 300);
}

function taskPublic(t) {
  return {
    id: t.id, query: t.query, condition: t.condition, intervalMin: t.intervalMin,
    enabled: t.enabled, created: t.created, lastRun: t.lastRun, nextRun: t.nextRun,
    runCount: t.runCount, hits: t.hits || [],
  };
}

// 让上游模型判断：检索结果是否满足监控条件（模型不可用时退化为关键词包含判断）
function judgeTaskHit(task, searchResults) {
  const cfgReady = serverModelReady();
  const listText = searchResults.map(function (r, i) {
    return "[" + (i + 1) + "] " + r.title + " — " + r.url + "\n    " + (r.snippet || "").slice(0, 180);
  }).join("\n");
  if (!cfgReady) {
    // 无模型兜底：条件词出现在任一结果里即视为命中
    const cond = (task.condition || "").slice(0, 40);
    const hit = cond && searchResults.some(function (r) {
      return (r.title + r.snippet).indexOf(cond.slice(0, 6)) !== -1;
    });
    return Promise.resolve({ hit: hit, summary: hit ? "关键词命中（未接模型，粗判）" : "无关键词命中", results: listText });
  }
  const body = JSON.stringify({
    model: MODEL_NAME,
    max_tokens: 600,
    system: "你是监控判断器。基于检索结果判断用户的监控条件是否满足。只输出 JSON：" +
      '{"hit":true或false,"summary":"一句话：发生了什么/为什么算命中（或没命中）"}',
    messages: [{
      role: "user",
      content: "监控目标：" + task.query + "\n触发条件：" + (task.condition || "出现相关新变化") +
        "\n\n本轮检索结果：\n" + listText.slice(0, 6000),
    }],
  });
  return new Promise(function (resolve) {
    const upReq = upstreamRequest(body, function (upRes) {
      const chunks = [];
      upRes.on("data", function (c) { chunks.push(c); });
      upRes.on("end", function () {
        try {
          const a = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const text = (a.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("");
          const m = text.match(/\{[\s\S]*\}/);
          const j = m ? JSON.parse(m[0]) : { hit: false, summary: "判断输出无法解析" };
          resolve({ hit: !!j.hit, summary: String(j.summary || "").slice(0, 200), results: listText });
        } catch (e) {
          resolve({ hit: false, summary: "判断调用失败", results: listText });
        }
      });
    });
    upReq.on("error", function () { resolve({ hit: false, summary: "判断调用失败", results: listText }); });
    upReq.end(body);
  });
}

async function runTaskOnce(t) {
  t.lastRun = Date.now();
  t.nextRun = t.lastRun + (t.intervalMin || 30) * 60000;
  t.runCount = (t.runCount || 0) + 1;
  saveTasks();
  try {
    const sr = await webSearch(t.query, 6);
    const results = (sr && sr.ok && sr.results) || [];
    const judge = await judgeTaskHit(t, results);
    const record = { t: Date.now(), hit: judge.hit, summary: judge.summary, top: results.slice(0, 3).map(function (r) { return { title: r.title, url: r.url }; }) };
    if (judge.hit) {
      (t.hits = t.hits || []).unshift(record);
      t.hits = t.hits.slice(0, 20);
      console.log("🔔 监控命中 [" + t.query + "] " + judge.summary);
      fireWebhook("🔔 监控命中：" + t.query.slice(0, 30), judge.summary); // 主动通知（对标 dots 的主动汇报）
    }
    (t.log = t.log || []).unshift({ t: record.t, hit: record.hit, summary: record.summary });
    t.log = t.log.slice(0, 10);
    saveTasks();
  } catch (e) {
    (t.log = t.log || []).unshift({ t: Date.now(), hit: false, summary: "执行失败：" + e.message });
    saveTasks();
  }
}

// 每 20 秒扫描一次到期任务
setInterval(function () {
  const now = Date.now();
  for (const t of bgTasks) {
    if (!t.enabled) continue;
    if (!t.nextRun || t.nextRun <= now) runTaskOnce(t); // async 触发即走，不阻塞扫描
  }
}, 20000);
// 启动时给已有任务排期（错峰 10s，避免冷启动打爆引擎）
setTimeout(function () {
  for (const t of bgTasks) {
    if (t.enabled && !t.nextRun) t.nextRun = Date.now() + 10000 + Math.random() * 20000;
  }
}, 1000);

/* ============ HTTP 服务 ============ */

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, "http://" + HOST);
  const p = u.pathname.replace(/\/{2,}/g, "/");
  const t0 = Date.now();
  // 请求日志：一眼定位「谁打了什么路径、什么结果」
  res.on("finish", function () {
    console.log("  " + new Date().toLocaleTimeString("zh-CN", { hour12: false }) +
      "  " + req.method + " " + p + " → " + res.statusCode + "（" + (Date.now() - t0) + "ms）");
  });

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  // —— 状态页（应用本体在 / ，这里只做诊断）——
  if (req.method === "GET" && (p === "/healthz" || p === "/bridge")) {
    const skills = listSkills();
    res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS));
    return res.end(
      "<meta charset='utf-8'><body style=\"font-family:system-ui;max-width:600px;margin:60px auto;line-height:1.9\">" +
      "<h2>🌊 Lumen · 本地服务桥</h2>" +
      "<p>服务端模型：<b style='color:" + (serverModelReady() ? "#2e7d4f" : "#9a6b1a") + "'>" + serverModelHint() + "</b>" +
      (serverModelReady() ? " · 模型 <code>" + MODEL_NAME + "</code>" : "") + "</p>" +
      "<p>聊天模型由用户在设置页自带 Key 浏览器直连（六家厂商 + 自定义端点）；不支持浏览器 CORS 的端点可经本地网关 <code>/v1</code> 接入（Anthropic 透传 + OpenAI 转译）。</p>" +
      "<p>技能库：" + skills.length + " 个已内置" +
      (skills.length ? "（" + skills.map(function (s) { return s.name; }).slice(0, 6).join("、") + (skills.length > 6 ? "…" : "") + "）" : "") + "</p>" +
      "<p>QCU 执行桥：POST /qcu/exec（qcu CLI 已在 PATH 中检测：" + (process.platform === "win32" ? "请自行确认" : "是") + "）</p>" +
      "<p>虚拟计算机 LumenBox：POST /vm/exec（browser/files/shell）· GET /vm/state · 工作区 <code>vm-home/</code>（终端" + (VM_SHELL_SERVER_ON ? "总闸开，仍需应用内开启" : "已被服务端禁用") + "）</p>" +
      "<p>本地网关接入（可选）：设置 → 模型接入 → 本地网关，接口地址 <code>http://127.0.0.1:" + PORT + "/v1</code>。</p>" +
      "<hr><p style='color:#888;font-size:13px'>仅监听 127.0.0.1 · 密钥来自 LUMEN_MODEL_API_KEY 环境变量，Lumen 不读取任何第三方工具的本地配置</p></body>"
    );
  }

  // —— 技能服务 ——
  if (req.method === "GET" && p === "/skills") {
    return json(res, 200, { skills: listSkills(), qcu: { bin: QCU_BIN, timeoutMs: QCU_TIMEOUT_MS } });
  }
  const skillMatch = p.match(/^\/skills\/([a-z0-9-]+)\/?$/i);
  if (req.method === "GET" && skillMatch) {
    const content = skillContent(skillMatch[1]);
    if (content === null) return json(res, 404, { error: "技能不存在：" + skillMatch[1] });
    return json(res, 200, { id: skillMatch[1], content: content });
  }

  // —— QCU 执行桥 ——
  if (req.method === "POST" && (p === "/qcu/exec" || p === "/skill/qcu/exec")) {
    return handleQcuExec(req, res);
  }

  // —— 本地模型列表（如实上报：没配环境变量就返回空，前端据此显示「未配置」） ——
  if (req.method === "GET" && (p === "/v1/models" || p === "/models")) {
    if (!serverModelReady()) {
      return json(res, 200, {
        object: "list", data: [], configured: false,
        hint: "服务端模型未配置：启动服务桥时设置环境变量 LUMEN_MODEL_API_KEY 与 LUMEN_MODEL_BASE（自带 Key，任意 Anthropic 兼容端点）",
      });
    }
    return json(res, 200, {
      object: "list", configured: true,
      data: [
        { id: MODEL_NAME, object: "model", owned_by: "lumen-local-gateway" },
      ],
    });
  }

  // —— 后台监控任务 CRUD ——
  if (req.method === "GET" && p === "/tasks") {
    return json(res, 200, { tasks: bgTasks.map(taskPublic) });
  }
  if (req.method === "POST" && p === "/tasks") {
    try {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const query = String(body.query || "").trim().slice(0, 120);
      if (!query) return json(res, 400, { error: "query 必填" });
      const t = {
        id: "mon-" + Date.now().toString(36),
        query: query,
        condition: String(body.condition || "出现相关新变化").slice(0, 200),
        intervalMin: Math.max(10, Math.min(1440, parseInt(body.intervalMin, 10) || 30)),
        enabled: true,
        created: Date.now(),
        nextRun: Date.now() + 5000, // 创建后 5 秒首跑
        runCount: 0,
        hits: [],
        log: [],
      };
      bgTasks.push(t);
      saveTasks();
      console.log("📌 创建监控任务：" + t.query + "（每 " + t.intervalMin + " 分钟）");
      return json(res, 200, taskPublic(t));
    } catch (e) { return json(res, 400, { error: "请求体非法：" + e.message }); }
  }
  const taskMatch = p.match(/^\/tasks\/([a-z0-9-]+)(\/toggle)?$/);
  if (taskMatch) {
    const t = bgTasks.find(function (x) { return x.id === taskMatch[1]; });
    if (!t) return json(res, 404, { error: "任务不存在" });
    if (req.method === "POST" && taskMatch[2] === "/toggle") {
      t.enabled = !t.enabled;
      t.nextRun = t.enabled ? Date.now() + 5000 : null;
      saveTasks();
      return json(res, 200, taskPublic(t));
    }
    if (req.method === "DELETE") {
      bgTasks = bgTasks.filter(function (x) { return x.id !== t.id; });
      saveTasks();
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET") return json(res, 200, taskPublic(t));
  }

  // —— 真实网络层 ——
  if (req.method === "POST" && p === "/web/search") {
    try {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      if (!body.query || String(body.query).length > 200) return json(res, 400, { ok: false, error: "query 必填且 ≤200 字" });
      return json(res, 200, await webSearch(String(body.query), parseInt(body.count, 10) || 6));
    } catch (e) { return json(res, 400, { ok: false, error: "请求体非法：" + e.message }); }
  }
  if (req.method === "POST" && p === "/web/fetch") {
    try {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      if (!body.url) return json(res, 400, { ok: false, error: "url 必填" });
      return json(res, 200, await webFetch(String(body.url)));
    } catch (e) { return json(res, 502, { ok: false, error: "抓取失败：" + e.message }); }
  }

  // —— 虚拟计算机 LumenBox ——
  if (req.method === "POST" && (p === "/vm/exec" || p === "/vm")) {
    return handleVmExec(req, res);
  }
  if (req.method === "GET" && (p === "/vm/state" || p === "/vm")) {
    return json(res, 200, vmPublicState());
  }

  // —— LumenBox Desktop（容器化桌面虚拟机 + Sentinel + 安全区） ——
  // 高能力端点：只接受同源页面（或无 Origin 的本机 curl）。
  // 读操作放宽到 Origin:null（file:// 演示页）；变更类操作严格同源，
  // 防止任意网页（含沙箱 iframe 的伪造 null Origin）触达 127.0.0.1 操控虚拟机。
  const MUTATING_BOX_ROUTES = new Set([
    "/vm/desktop/start", "/vm/desktop/stop", "/vm/desktop/build", "/vm/desktop/act",
    "/sentinel/decide", "/vm/vault/set", "/vm/vault/del", "/update/apply", "/vm/file/upload",
    "/rules", "/notify", "/notify/config",
  ]);
  if (p.indexOf("/vm/desktop/") === 0 || p.indexOf("/vm/vault") === 0 || p.indexOf("/sentinel/") === 0 || p === "/vm/file/upload" || p.indexOf("/rules") === 0 || p.indexOf("/notify") === 0) {
    const origin = req.headers["origin"];
    let sameOrigin = !origin;
    if (origin) {
      try { sameOrigin = new URL(origin).host === req.headers.host; } catch (e) { sameOrigin = false; }
    }
    if (!sameOrigin && !(origin === "null" && req.method === "GET" && !MUTATING_BOX_ROUTES.has(p))) {
      return json(res, 403, { ok: false, error: "端点仅限同源调用（请从应用所在网址打开 Lumen）" });
    }
  }

  if (req.method === "GET" && p === "/vm/desktop/status") {
    const daemon = await dockerAvailable();
    if (daemon) await boxSyncState();
    else box.state = "nodocker";
    const imageReady = daemon ? await boxImageExists() : false;
    return json(res, 200, Object.assign(desktopStatus(), { daemon: daemon, imageReady: imageReady }));
  }
  if (req.method === "POST" && p === "/vm/desktop/start") {
    const r = await boxStart();
    return json(res, r.ok ? 200 : 502, r.ok ? desktopStatus() : r);
  }
  if (req.method === "POST" && p === "/vm/desktop/stop") {
    return json(res, 200, await boxStop());
  }
  if (req.method === "POST" && p === "/vm/desktop/build") {
    const r = await boxBuild();
    return json(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { ok: false, error: r.err });
  }
  if (req.method === "GET" && p === "/vm/desktop/screen.png") {
    if (box.state !== "running") await boxSyncState();
    if (box.state !== "running") return json(res, 503, { ok: false, error: "桌面虚拟机未运行" });
    try {
      const r = await boxFetch("/screen.png");
      res.writeHead(200, Object.assign({
        "Content-Type": "image/png", "Content-Length": r.body.length, "Cache-Control": "no-store",
      }, CORS));
      return res.end(r.body);
    } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  if (req.method === "GET" && p === "/vm/desktop/observe") {
    if (box.state !== "running") await boxSyncState();
    if (box.state !== "running") return json(res, 503, { ok: false, error: "桌面虚拟机未运行" });
    try {
      const r = await boxJson("/observe?max=40");
      return json(res, 200, r);
    } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  if (req.method === "POST" && p === "/vm/desktop/act") {
    // 手动操控（用户在计算机页陪它逛）：同样过 Sentinel —— 审批权威不豁免任何人
    if (box.state !== "running") await boxSyncState();
    if (box.state !== "running") return json(res, 503, { ok: false, error: "桌面虚拟机未运行" });
    let body;
    try { body = JSON.parse((await readBody(req, 512 * 1024)).toString("utf8")); }
    catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
    let obs = lastObserveCtx;
    if (body.op === "click" || body.op === "fill") {
      try { obs = await boxJson("/observe?max=40"); lastObserveCtx = obs; } catch (e) {}
    }
    const review = sentinelReview(body, obs);
    if (review.verdict === "block") return json(res, 403, { ok: false, error: "Sentinel 阻止：" + review.reason });
    if (review.verdict === "ask") {
      return json(res, 200, { ok: false, needApproval: true, approval: review.approval, reason: review.reason });
    }
    try {
      const r = await boxJson("/act", { op: body.op, args: body.args });
      return json(res, 200, r);
    } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  // 手动动作的审批（与任务审批共用 Sentinel 凭证池）
  if (req.method === "POST" && p === "/sentinel/decide") {
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")); }
    catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
    if (body.decision === "allow" && body.digest) grantToken(body.digest, "manual");
    return json(res, 200, { ok: true, granted: body.decision === "allow" });
  }

  // —— 桌面任务（宿主侧运行，浏览器只是遥控器） ——
  if (req.method === "GET" && p === "/vm/desktop/tasks") {
    return json(res, 200, { tasks: dtasks.map(dtaskPublic) });
  }
  if (req.method === "POST" && p === "/vm/desktop/tasks") {
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")); }
    catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
    const goal = String(body.goal || "").trim().slice(0, 300);
    if (!goal) return json(res, 400, { ok: false, error: "goal 必填" });
    const t = {
      id: "dt-" + Date.now().toString(36),
      goal: goal,
      status: "queued",
      steps: [], evidence: [], summary: "",
      createdAt: Date.now(), updatedAt: Date.now(),
      modelCalls: 0, shot: null, pendingApproval: null,
    };
    dtasks.unshift(t);
    dtasksSave();
    console.log("🖥 新桌面任务：" + goal.slice(0, 60));
    runDesktopTask(t); // async 触发即走：浏览器关了它也继续跑
    return json(res, 200, dtaskPublic(t));
  }
  const dtaskMatch = p.match(/^\/vm\/desktop\/tasks\/([a-z0-9-]+)(\/stop|\/approve)?$/);
  if (dtaskMatch) {
    const t = dtasks.find(x => x.id === dtaskMatch[1]);
    if (!t) return json(res, 404, { ok: false, error: "任务不存在" });
    if (req.method === "POST" && dtaskMatch[2] === "/stop") {
      t.status = "stopped";
      t.pendingApproval = null;
      t._lastDecision = "stopped";
      dstep(t, "info", "用户停止了任务");
      dtasksSave();
      return json(res, 200, dtaskPublic(t));
    }
    if (req.method === "POST" && dtaskMatch[2] === "/approve") {
      let body;
      try { body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")); }
      catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
      if (!t.pendingApproval) return json(res, 400, { ok: false, error: "没有待审批动作" });
      const dec = body.decision === "allow" ? "allow" : "deny";
      t.pendingApproval = null; // 两种决定都要清：任务循环靠它感知决议（waitApproval 轮询）
      t._lastDecision = dec;
      dstep(t, "sentinel", dec === "allow" ? "✅ 你批准了（浏览器端）" : "🚫 你拒绝了（浏览器端）");
      dtasksSave();
      return json(res, 200, dtaskPublic(t));
    }
    if (req.method === "GET") return json(res, 200, dtaskPublic(t));
  }
  if (req.method === "GET" && p === "/vm/desktop/shot" && u.searchParams.get("f")) {
    const f = path.basename(u.searchParams.get("f"));
    if (!/^[\w.-]+\.png$/.test(f)) return json(res, 400, { error: "文件名非法" });
    const file = path.join(SHOT_DIR, f);
    let st;
    try { st = fs.statSync(file); } catch (e) { return json(res, 404, { error: "截图不存在" }); }
    res.writeHead(200, Object.assign({ "Content-Type": "image/png", "Content-Length": st.size, "Cache-Control": "no-store" }, CORS));
    return fs.createReadStream(file).pipe(res);
  }

  // —— 凭证安全区（值只进不出：API 永不回传明文） ——
  if (req.method === "GET" && p === "/vm/vault") {
    return json(res, 200, { ok: true, vault: vaultPublic() });
  }
  if (req.method === "POST" && p === "/vm/vault/set") {
    let body;
    try { body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8")); }
    catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
    const name = String(body.name || "").trim().slice(0, 40);
    const value = String(body.value || "");
    if (!name || !value) return json(res, 400, { ok: false, error: "name 与 value 必填" });
    const v = vaultLoad();
    v[name] = { kind: String(body.kind || "文本").slice(0, 20), value: value, t: Date.now() };
    vaultSave(v);
    console.log("🔐 安全区写入凭证：" + name + "（值不显示）");
    return json(res, 200, { ok: true, vault: vaultPublic() });
  }
  // —— 动作规则（浏览器设置页维护，实时同步） ——
  if (req.method === "GET" && p === "/rules") {
    return json(res, 200, { ok: true, rules: customRules });
  }
  if (req.method === "POST" && p === "/rules") {
    let body;
    try { body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8")); }
    catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
    const list = Array.isArray(body.rules) ? body.rules.slice(0, 50).map(function (r) {
      return {
        id: String(r.id || ("rule-" + Date.now().toString(36))).slice(0, 24),
        keywords: String(r.keywords || "").slice(0, 80),
        mode: ["auto", "ask", "handoff"].indexOf(r.mode) > -1 ? r.mode : "ask",
        note: String(r.note || "").slice(0, 80),
      };
    }).filter(function (r) { return r.keywords; }) : [];
    customRules = list;
    rulesSave();
    console.log("📐 规则已更新：" + list.length + " 条");
    return json(res, 200, { ok: true, rules: customRules });
  }

  // —— 桌面任务暂停/继续 ——
  const dtaskPause = p.match(/^\/vm\/desktop\/tasks\/([a-z0-9-]+)\/(pause|resume)$/);
  if (req.method === "POST" && dtaskPause) {
    const t = dtasks.find(x => x.id === dtaskPause[1]);
    if (!t) return json(res, 404, { ok: false, error: "任务不存在" });
    if (dtaskPause[2] === "pause") {
      if (["running", "queued", "waiting_approval"].indexOf(t.status) === -1) return json(res, 400, { ok: false, error: "任务当前状态不可暂停：" + t.status });
      t.status = "paused";
      dstep(t, "info", "⏸ 已暂停（已完成的动作保留；继续点 Resume）");
    } else {
      if (t.status !== "paused") return json(res, 400, { ok: false, error: "任务未在暂停中" });
      t.status = "running";
      t._resumeAt = Date.now();
      dstep(t, "info", "▶ 已继续");
    }
    dtasksSave();
    return json(res, 200, dtaskPublic(t));
  }

  // —— 通知（Webhook）配置与触发 ——
  if (req.method === "GET" && p === "/notify/config") {
    return json(res, 200, { ok: true, webhook: notifyCfg.webhook });
  }
  if (req.method === "POST" && p === "/notify/config") {
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")); }
    catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
    notifyCfg.webhook = /^https?:\/\//.test(String(body.webhook || "")) ? String(body.webhook).slice(0, 300) : "";
    try { fs.writeFileSync(NOTIFY_FILE, JSON.stringify(notifyCfg, null, 2)); } catch (e) {}
    return json(res, 200, { ok: true, webhook: notifyCfg.webhook });
  }
  if (req.method === "POST" && p === "/notify") {
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")); }
    catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
    const r = await fireWebhook(String(body.title || "Lumen").slice(0, 80), String(body.text || "").slice(0, 300));
    return json(res, r.sent ? 200 : 202, r);
  }

  // —— 手机/局域网访问信息 ——
  if (req.method === "GET" && p === "/lan-ips") {
    const ips = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const it of ifaces[name] || []) {
        if (it.family === "IPv4" && !it.internal) ips.push(it.address);
      }
    }
    // mDNS 主机名（Mac 局域网默认可用；iOS 原生支持 .local 解析，无需记 IP）
    let mdns = "";
    try {
      const h = os.hostname().toLowerCase().replace(/\.local$/, "");
      if (h && /^[a-z0-9][a-z0-9-]*$/.test(h)) mdns = "http://" + h + ".local:" + PORT;
    } catch (e) {}
    const urls = ips.map(ip => "http://" + ip + ":" + PORT);
    if (mdns) urls.unshift(mdns);
    return json(res, 200, { ok: true, host: HOST, open: HOST === "0.0.0.0", urls, mdns });
  }

  // —— 版本与更新 ——
  if (req.method === "GET" && p === "/update/check") {
    const u = await updateCheck();
    lastUpdateInfo = u;
    return json(res, 200, Object.assign({ ok: true }, u));
  }
  if (req.method === "POST" && p === "/update/apply") {
    const r = await updateApply();
    console.log(r.ok ? "⬆ 一键更新完成" : "⬆ 一键更新被拒：" + String(r.error || "").slice(0, 80));
    return json(res, r.ok ? 200 : 409, r);
  }
  if (req.method === "POST" && p === "/vm/vault/del") {
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")); }
    catch (e) { return json(res, 400, { ok: false, error: "请求体非法" }); }
    const v = vaultLoad();
    delete v[String(body.name || "")];
    vaultSave(v);
    return json(res, 200, { ok: true, vault: vaultPublic() });
  }

  const vmUpload = p === "/vm/file/upload";
  if (req.method === "POST" && vmUpload) {
    // 上传文件进虚拟工作区：?name= 文件名（raw body 为文件内容，≤20MB）
    let name;
    try { name = decodeURIComponent(u.searchParams.get("name") || ""); } catch (e) { name = ""; }
    name = path.basename(String(name || "").trim()); // 只取文件名，禁止路径
    if (!name || name.startsWith(".")) return json(res, 400, { ok: false, error: "name 必填（纯文件名）" });
    try {
      const body = await readBody(req, 20 * 1024 * 1024);
      if (!body.length) return json(res, 400, { ok: false, error: "文件内容为空" });
      const full = vmSafeName(name);
      if (!full) return json(res, 400, { ok: false, error: "文件名非法" });
      fs.writeFileSync(full, body);
      console.log("📥 上传进虚拟工作区：" + name + "（" + body.length + " B）");
      return json(res, 200, { ok: true, name: name, bytes: body.length, files: vmFilesExec("ls").files });
    } catch (e) {
      return json(res, e.message === "body 超限" ? 413 : 500, { ok: false, error: "上传失败：" + e.message });
    }
  }
  const vmFileMatch = p.match(/^\/vm\/file\/(.+)$/);
  if (req.method === "GET" && vmFileMatch) {
    // 工作区文件下载（严格囚于 vm-home；名字 encodeURIComponent 编码，兼容 %2F 与多段两种形式）
    let name;
    try { name = decodeURIComponent(vmFileMatch[1]); } catch (e) { name = ""; }
    const full = vmSafeName(name);
    if (!full) return json(res, 400, { error: "文件名非法" });
    let st;
    try { st = fs.statSync(full); } catch (e) { return json(res, 404, { error: "文件不存在" }); }
    if (!st.isFile()) return json(res, 400, { error: "不是文件" });
    res.writeHead(200, Object.assign({
      "Content-Type": "application/octet-stream",
      "Content-Length": st.size,
      // RFC 6266：ASCII 回退名 + UTF-8 扩展名，两者都给（部分 Chromium 只认组合）
      "Content-Disposition": "attachment; filename=\"lumen-file\"; filename*=UTF-8''" + encodeURIComponent(path.basename(full)),
    }, CORS));
    return fs.createReadStream(full).pipe(res);
  }

  // —— OpenAI 兼容主通道：/chat/completions（含 /v1 前缀）——
  if (req.method === "POST" && (p === "/chat/completions" || p === "/v1/chat/completions")) {
    readBody(req, MAX_BODY)
      .then(function (b) { handleChatCompletions(req, res, b); })
      .catch(function () { json(res, 413, { error: { message: "请求体过大" } }); });
    return;
  }

  // —— Anthropic 主通道：/v1/** 透传；裸 /messages、/complete 也接受（历史配置兼容） ——
  let upstreamPath = null;
  if (p.indexOf("/v1/") === 0 || p === "/v1") upstreamPath = p;
  else if (p === "/messages" || p === "/complete") upstreamPath = "/v1" + p;
  if (upstreamPath !== null) {
    if (!serverModelReady()) {
      return json(res, 502, {
        type: "error",
        error: { type: "proxy_error", message: "服务端模型未配置：请用环境变量 LUMEN_MODEL_API_KEY 与 LUMEN_MODEL_BASE 提供你自己的密钥与端点（自带 Key），然后重启服务桥。" },
      });
    }
    readBody(req, MAX_BODY).then(function (body) {
      const upUrl = new URL(MODEL_BASE + upstreamPath + u.search);
      const upReq = https.request({
        hostname: upUrl.hostname,
        port: upUrl.port || 443,
        path: upUrl.pathname + upUrl.search,
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          "x-api-key": MODEL_KEY, // 密钥来自环境变量（用户自带）
          "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
        },
        timeout: 300000,
      }, function (upRes) {
        const headers = { "Content-Type": upRes.headers["content-type"] || "application/json" };
        Object.assign(headers, CORS);
        res.writeHead(upRes.statusCode, headers);
        upRes.pipe(res); // SSE 流原样直通
      });
      upReq.on("timeout", function () { upReq.destroy(new Error("上游超时")); });
      upReq.on("error", function (err) {
        if (res.headersSent) return res.end();
        json(res, 502, { type: "error", error: { type: "proxy_error", message: "上游请求失败：" + err.message } });
      });
      upReq.end(body);
    }).catch(function () {
      json(res, 413, { type: "error", error: { type: "proxy_error", message: "请求体过大" } });
    });
    return;
  }

  // —— 静态资源：Lumen 本地网址本体（index.html / css / js / assets）——
  if (req.method === "GET" && serveStatic(req, res, p)) return;

  json(res, 404, { error: { message: "Not Found（本服务桥提供网站、/v1/**、/skills、/qcu/exec、/vm/**）" } });
});

// 启动 4 秒后静默检查更新（只提示，绝不自动更新）
setTimeout(async function () {
  try {
    const u = await updateCheck();
    lastUpdateInfo = u;
    if (u.updateAvailable) {
      console.log("   ✨ 有新版本：落后 " + (u.behind || u.commits.length) + " 个提交（设置 → 更新 可查看并一键更新）");
    }
  } catch (e) {}
}, 4000);

server.listen(PORT, HOST, function () {
  const url = "http://" + (HOST === "0.0.0.0" ? "127.0.0.1" : HOST) + ":" + PORT + "/";
  console.log("🌊 Lumen · 本地服务桥 v3 已启动");
  console.log("   应用网址 " + url + "（浏览器打开即用）");
  console.log("   服务端模型 " + serverModelHint());
  if (serverModelReady()) {
    console.log("   本地网关 http://" + HOST + ":" + PORT + "/v1 → " + MODEL_BASE + "（Anthropic 透传 + OpenAI 转译）");
  }
  console.log("   技能库   " + listSkills().length + " 个内置（" + SKILLS_DIR + "）");
  console.log("   QCU 桥   POST /qcu/exec → " + QCU_BIN + "（超时 " + QCU_TIMEOUT_MS + "ms）");
  console.log("   虚拟计算机 LumenBox · /vm/exec /vm/state · 工作区 vm-home/（浏览优先在这里，不碰你的电脑）");
  console.log("   诊断页   http://" + HOST + ":" + PORT + "/healthz");
  console.log("   停止     Ctrl+C");
  // 自动弹出浏览器（不想弹：LUMEN_NO_OPEN=1 node server.js）
  if (!process.env.LUMEN_NO_OPEN) {
    try {
      if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore" });
      else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" });
      else spawn("xdg-open", [url], { stdio: "ignore" });
    } catch (e) { /* 打不开就算了，URL 已打印 */ }
  }
});
