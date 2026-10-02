"use strict";
const fs = require("node:fs");
const path = require("node:path");

// 后台模型配置与普通状态分开；接口只回模型名称，绝不回密钥。
function createModel(dir) {
  const file = path.join(dir, "lumen-agent-model.json");
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
  function current() {
    if (config.apiKey && config.baseUrl && config.model) return config;
    if (process.env.LUMEN_MODEL_API_KEY && process.env.LUMEN_MODEL_BASE) return {
      type: process.env.LUMEN_MODEL_TYPE || "anthropic", apiKey: process.env.LUMEN_MODEL_API_KEY,
        baseUrl: process.env.LUMEN_MODEL_BASE, model: process.env.LUMEN_MODEL_NAME || "glm-5.3", imageModel: process.env.LUMEN_IMAGE_MODEL,
    };
    return null;
  }
  return {
    status() { const c = current(); return { ready: !!c, model: c ? c.model : "", type: c ? c.type : "", imageModel: c?.imageModel || "gpt-image-2.5-sunburst" }; },
    configure(c) {
      if (c.clear) { config = {}; fs.rmSync(file, { force: true }); return; }
      if (!["anthropic", "openai", "gemini"].includes(c.type)) throw new Error("模型协议不支持");
      const u = new URL(c.baseUrl);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error("模型地址非法");
      if (!c.apiKey || !c.model) throw new Error("密钥与模型名称必填");
      config = { type: c.type, baseUrl: u.href.replace(/\/+$/, ""), apiKey: String(c.apiKey), model: String(c.model), imageModel: String(c.imageModel || "gpt-image-2.5-sunburst") };
      fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); fs.chmodSync(file, 0o600);
    },
    async image(prompt, signal) {
      const c = current(); if (!c || c.type !== "openai") throw new Error("真实生图需要支持Images API的OpenAI兼容后台端点");
      const ctrl = new AbortController(), abort = () => ctrl.abort();
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 180000);
      try {
      const r = await fetch(c.baseUrl.replace(/\/+$/, "") + "/images/generations", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + c.apiKey },
        body: JSON.stringify({ model: c.imageModel || "gpt-image-2.5-sunburst", prompt, size: "1024x1024", n: 1 }),
        signal: ctrl.signal });
      const d = await r.json(); if (!r.ok) throw new Error("生图请求失败（HTTP " + r.status + "）");
      const b64 = d.data?.[0]?.b64_json;
      if (typeof b64 !== "string" || b64.length > 32 * 1024 * 1024) throw new Error("生图端点未返回有效base64图像");
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length < 45 || bytes.subarray(0,8).toString("hex") !== "89504e470d0a1a0a" || bytes.subarray(12,16).toString() !== "IHDR" ||
          bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 8192 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 8192 ||
          bytes.subarray(-8).toString("hex") !== "49454e44ae426082") throw new Error("生图端点未返回完整PNG");
      return bytes;
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    },
    async call(system, messages, signal) {
      const c = current(); if (!c) throw new Error("后台模型未配置：持续工作页 → 启用当前模型");
      let url, body, headers = { "Content-Type": "application/json" };
      const base = c.baseUrl.replace(/\/+$/, "");
      if (c.type === "anthropic") {
        url = base + (base.endsWith("/v1") ? "" : "/v1") + "/messages";
        headers["x-api-key"] = c.apiKey; headers["anthropic-version"] = "2023-06-01";
        body = { model: c.model, system, messages, max_tokens: 4096 };
      } else if (c.type === "gemini") {
        url = base + "/models/" + encodeURIComponent(c.model) + ":generateContent";
        headers["x-goog-api-key"] = c.apiKey;
        body = { systemInstruction: { parts: [{ text: system }] }, contents: messages.map(m => ({
          role: m.role === "assistant" ? "model" : "user", parts: Array.isArray(m.content) ? m.content.map(p => p.type === "image" ? { inlineData: { mimeType: p.source.media_type, data: p.source.data } } : { text: p.text }) : [{ text: m.content }],
        })), generationConfig: { maxOutputTokens: 4096 } };
      } else {
        url = base + "/chat/completions"; headers.Authorization = "Bearer " + c.apiKey;
        body = { model: c.model, messages: [{ role: "system", content: system }, ...messages.map(m => ({ ...m,
          content: Array.isArray(m.content) ? m.content.map(p => p.type === "image" ? { type: "image_url", image_url: { url: "data:" + p.source.media_type + ";base64," + p.source.data } } : p) : m.content,
        }))] };
        body[/^(gpt-[5-9]|o[1-9])/.test(c.model) ? "max_completion_tokens" : "max_tokens"] = 4096;
      }
      const ctrl = new AbortController();
      const abort = () => ctrl.abort();
      if (signal && signal.aborted) abort(); else if (signal) signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 120000);
      try {
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error("模型调用失败（HTTP " + r.status + "）");
        const text = c.type === "anthropic" ? (d.content || []).filter(b => b.type === "text").map(b => b.text).join("")
          : c.type === "gemini" ? ((d.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("")
          : d.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim()) throw new Error("模型返回空内容");
        return text;
      } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", abort); }
    },
  };
}
module.exports = { createModel };
