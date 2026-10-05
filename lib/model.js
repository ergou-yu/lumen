"use strict";
const fs = require("node:fs");
const path = require("node:path");

function glm53Variant(name) { return /^glm[-_.]5[.-]3(?:[-_.](flash|flashx))?$/i.exec(name || ""); }
function visionModel(name) { const glm = glm53Variant(name); return !glm || !!glm[1]; }
function modelChoices(c) {
  if (!c) return [];
  const names = [c.model];
  if (glm53Variant(c.model)) {
    // 保留现有网关的大小写别名；智谱官方端点使用小写模型名称。
    const upper = c.model.startsWith("GLM");
    for (const name of upper ? ["GLM-5.3", "GLM-5.3-Flash"] : ["glm-5.3", "glm-5.3-flash"]) {
      if (!names.some(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  }
  return names.map(model => ({ model, vision: visionModel(model) }));
}
function desktopModel(c) { return c && !visionModel(c.model) ? modelChoices(c).find(m => m.vision)?.model || c.model : c?.model || ""; }

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
    status() { const c = current(), desktop = desktopModel(c); return { ready: !!c, model: c ? c.model : "", type: c ? c.type : "", vision: c ? visionModel(c.model) : false, desktopModel: desktop, desktopVision: !!c && visionModel(desktop), models: modelChoices(c), imageModel: c?.imageModel || "gpt-image-2.5-sunburst" }; },
    select(name) {
      const c = current(); if (!c) throw new Error("后台模型未配置");
      const choice = modelChoices(c).find(m => m.model === name);
      if (!choice) throw new Error("该模型不在当前后台连接的选项中");
      this.configure({ ...c, model: choice.model });
      return this.status();
    },
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
    async call(system, messages, signal, onRetry, callOptions = {}) {
      let c = current(); if (!c) throw new Error("后台模型未配置：持续工作页 → 启用当前模型");
      if (callOptions.model && callOptions.model !== c.model) {
        if (!modelChoices(c).some(m => m.model === callOptions.model)) throw new Error("该模型不在当前后台连接的选项中");
        c = { ...c, model: callOptions.model };
      }
      const glm53 = glm53Variant(c.model);
      if (!visionModel(c.model) && messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image"))) throw new Error("GLM-5.3 只支持文字，无法读取截图；请使用 GLM-5.3-Flash 等支持视觉的模型");
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
      const tokenKey = c.type === "gemini" ? "maxOutputTokens" : /^(gpt-[5-9]|o[1-9])/.test(c.model) && c.type === "openai" ? "max_completion_tokens" : "max_tokens";
      if (glm53 && ["low", "high", "max"].includes(callOptions.reasoningEffort)) body.reasoning_effort = callOptions.reasoningEffort;
      const limits = c.type === "gemini" ? body.generationConfig : body;
      // 仅重试模型生成；不重新执行检索或已获批的外部动作，也不把推理内容当作正文。
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const abort = () => ctrl.abort();
        if (signal && signal.aborted) abort(); else if (signal) signal.addEventListener("abort", abort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abort(); }, 120000);
        try {
          const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
          const d = await r.json();
          if (!r.ok || d.error) throw new Error("模型调用失败（HTTP " + r.status + "）");
          const text = c.type === "anthropic" ? (d.content || []).filter(b => b.type === "text").map(b => b.text).join("")
            : c.type === "gemini" ? ((d.candidates || [])[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("")
            : d.choices?.[0]?.message?.content;
          const reason = c.type === "anthropic" ? d.stop_reason : c.type === "gemini" ? d.candidates?.[0]?.finishReason : d.choices?.[0]?.finish_reason;
          const truncated = ["max_tokens", "length", "MAX_TOKENS"].includes(reason);
          const empty = typeof text !== "string" || !text.trim();
          const blocked = ["refusal", "content_filter", "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT"].includes(reason) || d.promptFeedback?.blockReason;
          if (blocked) throw new Error("模型拒绝生成正文（安全或内容限制），请调整请求后再试");
          if (empty || truncated) {
            if (attempt === 0 && !signal?.aborted) {
              if (truncated) limits[tokenKey] *= 2;
              if (onRetry) await onRetry({ reason: truncated ? "length" : "empty", maxTokens: limits[tokenKey] });
              continue;
            }
            const tokens = c.type === "gemini" ? d.usageMetadata?.totalTokenCount : d.usage?.output_tokens ?? d.usage?.completion_tokens;
            const detail = [reason && "停止原因：" + String(reason).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40), Number.isFinite(tokens) && "已用 token：" + tokens].filter(Boolean).join("；");
            throw new Error((truncated ? "模型输出额度不足，重试后仍未完整生成正文" : "模型连续两次未返回正文") + (detail ? "（" + detail + "）" : "") + "。已保留任务进度，可在活动页继续");
          }
          return text;
        } catch (e) {
          if (signal?.aborted) throw e;
          const transient = timedOut || (e instanceof TypeError && /fetch failed/i.test(e.message));
          if (transient && attempt === 0) {
            if (onRetry) await onRetry({ reason: "network", maxTokens: limits[tokenKey] });
            continue;
          }
          if (transient) throw new Error(timedOut ? "模型服务响应超时，重试后仍未恢复；已保留执行进度" : "模型服务连接中断，重试后仍未恢复；已保留执行进度");
          throw e;
        } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", abort); }
      }
    },
  };
}
module.exports = { createModel };
