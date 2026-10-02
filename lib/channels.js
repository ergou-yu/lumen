"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const equal = (a,b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && crypto.timingSafeEqual(x,y); };
function slackValid(secret, raw, headers, now = Date.now()) {
  const ts = headers["x-slack-request-timestamp"];
  if (!secret || !/^\d+$/.test(ts || "") || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const signature = "v0=" + crypto.createHmac("sha256", secret).update("v0:" + ts + ":").update(raw).digest("hex");
  return equal(signature, headers["x-slack-signature"]);
}
function whatsappValid(secret, raw, headers) {
  return !!secret && equal("sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex"), headers["x-hub-signature-256"]);
}
async function teamsValid(config, token, activity, fetcher = fetch) {
  if (!token || token.length > 12000) return false;
  try {
    const parts = token.split("."); if (parts.length !== 3) return false;
    const header = JSON.parse(Buffer.from(parts[0], "base64url")), claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    const now = Date.now() / 1000;
    if (header.alg !== "RS256" || claims.iss !== "https://api.botframework.com" || claims.aud !== config.appId ||
        !Number.isFinite(claims.exp) || !Number.isFinite(claims.nbf) || claims.exp < now - 300 || claims.nbf > now + 300 || claims.serviceurl !== activity.serviceUrl) return false;
    const u = new URL(activity.serviceUrl); if (u.protocol !== "https:" || u.username || u.password || u.port ||
      !(["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"].includes(u.hostname))) return false;
    const r = await fetcher("https://login.botframework.com/v1/.well-known/keys", { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return false;
    const keys = await r.json(); const key = (keys.keys || []).find(k => k.kid === header.kid && (k.endorsements || []).includes(activity.channelId));
    if (!key) return false;
    return crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  } catch (_) { return false; }
}
function createChannels(options) {
  const file = path.join(options.dir, "lumen-channels.json");
  let config = { slack: {}, whatsapp: {}, teams: {} }, seen = [];
  try { const d = JSON.parse(fs.readFileSync(file, "utf8")); config = Object.assign(config, d.config); seen = d.seen || []; } catch (_) {}
  function save() { fs.writeFileSync(file, JSON.stringify({ config, seen }), { mode: 0o600 }); fs.chmodSync(file, 0o600); }
  function receive(id, eventId, prompt, target) {
    if (typeof eventId !== "string" || !eventId || eventId.length > 300) return;
    const key = id + ":" + eventId;
    if (seen.includes(key)) return;
    if (!prompt || String(prompt).length > 12000) return;
    // 回调不镜像其他渠道消息；仅接受绑定本人发给机器人的私聊。
    const job = options.receive({ prompt, channel: id, channelTarget: JSON.stringify({ ...target, owner: config[id].owner }), conversationId: id + ":owner" });
    seen.push(key); seen = seen.slice(-2000); save(); return job;
  }
  return {
    status() {
      return Object.fromEntries(Object.entries(config).map(([id,c]) => [id, { enabled: !!c.enabled, owner: c.owner || "", configured: id === "slack" ? !!(c.token && c.signingSecret && c.owner) : id === "whatsapp" ? !!(c.token && c.appSecret && c.phoneId && c.owner && c.verifyToken) : !!(c.appId && c.appSecret && c.tenantId && c.owner) }]));
    },
    configure(b) {
      const allowed = { slack: ["token", "signingSecret", "owner"], whatsapp: ["token", "appSecret", "phoneId", "owner", "verifyToken", "version"], teams: ["appId", "appSecret", "tenantId", "owner"] };
      if (!allowed[b.id]) throw new Error("未知消息渠道");
      const c = config[b.id]; if (b.clear) { config[b.id] = {}; save(); return; }
      for (const k of allowed[b.id]) if (b[k]) c[k] = String(b[k]).trim().slice(0, 2000);
      if (typeof b.enabled === "boolean") c.enabled = b.enabled;
      save();
    },
    async incoming(id, req, res, url, raw) {
      const c = config[id]; if (!c) { res.writeHead(404); res.end(); return; }
      if (id === "whatsapp" && req.method === "GET") {
        const ok = c.verifyToken && equal(c.verifyToken, url.searchParams.get("hub.verify_token")) && url.searchParams.get("hub.mode") === "subscribe";
        res.writeHead(ok ? 200 : 403, { "Content-Type": "text/plain" }); res.end(ok ? url.searchParams.get("hub.challenge") : "Forbidden"); return;
      }
      if (req.method !== "POST" || !c.enabled) { res.writeHead(403); res.end(); return; }
      let b;
      try { b = JSON.parse(raw); } catch (_) { res.writeHead(400); res.end(); return; }
      let valid = false;
      if (id === "slack") valid = slackValid(c.signingSecret, raw, req.headers);
      if (id === "whatsapp") valid = whatsappValid(c.appSecret, raw, req.headers);
      if (id === "teams") valid = await teamsValid(c, String(req.headers.authorization || "").replace(/^Bearer /, ""), b);
      if (!valid) { res.writeHead(403); res.end(); return; }
      if (id === "slack" && b.type === "url_verification") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ challenge: b.challenge })); return; }
      // 验证完成后快速ACK；模型任务绝不阻塞消息平台的回调。
      res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
      if (id === "slack") {
        const e = b.event || {};
        if (e.type === "message" && e.channel_type === "im" && e.user === c.owner && !e.bot_id && !e.subtype) receive(id, b.event_id, e.text, { channel: e.channel });
      } else if (id === "whatsapp") {
        for (const entry of b.entry || []) for (const change of entry.changes || []) {
          if (String(change.value?.metadata?.phone_number_id) !== c.phoneId) continue;
          for (const m of change.value.messages || []) if (m.type === "text" && m.from === c.owner && Math.abs(Date.now()/1000 - Number(m.timestamp)) < 300) receive(id, m.id, m.text?.body, { to: m.from });
        }
      } else if (b.type === "message" && b.channelId === "msteams" && b.from?.aadObjectId === c.owner && b.conversation?.conversationType === "personal" && b.channelData?.tenant?.id === c.tenantId) {
        receive(id, b.id, b.text, { serviceUrl: b.serviceUrl, conversation: b.conversation.id, replyToId: b.id });
      }
    },
    async reply(n, j) {
      if (!j.channelTarget || !["done", "failed", "approval"].includes(n.kind)) return;
      const c = config[j.channel]; if (!c?.enabled) return;
      const target = JSON.parse(j.channelTarget);
      if (target.owner !== c.owner) throw new Error("渠道绑定本人已改变，禁止回传旧目标");
      const result = n.kind === "approval" ? "Lumi正在等待你的批准，请打开持续工作页审阅具体动作。" : j.result || j.error || n.detail;
      const text = String(result).slice(0, 3500);
      let url, body, headers = { "Content-Type": "application/json" };
      if (j.channel === "slack") {
        url = "https://slack.com/api/chat.postMessage"; headers.Authorization = "Bearer " + c.token;
        body = { channel: target.channel, text, unfurl_links: false, unfurl_media: false };
      } else if (j.channel === "whatsapp") {
        if (target.to !== c.owner) throw new Error("收件人不是绑定本人");
        url = "https://graph.facebook.com/" + (c.version || "v23.0") + "/" + encodeURIComponent(c.phoneId) + "/messages"; headers.Authorization = "Bearer " + c.token;
        body = { messaging_product: "whatsapp", to: target.to, type: "text", text: { body: text, preview_url: false } };
      } else if (j.channel === "teams") {
        const tk = await fetch("https://login.microsoftonline.com/" + encodeURIComponent(c.tenantId) + "/oauth2/v2.0/token", { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.appId, client_secret: c.appSecret, scope: "https://api.botframework.com/.default" }), signal: AbortSignal.timeout(10000) });
        const token = await tk.json(); if (!tk.ok || !token.access_token) throw new Error("Teams令牌获取失败");
        const service = new URL(target.serviceUrl); if (service.protocol !== "https:" || !["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"].includes(service.hostname)) throw new Error("Teams服务地址非法");
        url = service.href.replace(/\/$/, "") + "/v3/conversations/" + encodeURIComponent(target.conversation) + "/activities";
        headers.Authorization = "Bearer " + token.access_token;
        body = { type: "message", text, replyToId: target.replyToId };
      } else return;
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false || d.error) throw new Error("消息回传失败（" + r.status + "）");
    },
  };
}
module.exports = { createChannels, slackValid, whatsappValid, teamsValid };
