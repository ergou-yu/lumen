"use strict";
const dns = require("node:dns").promises;
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
function privateIP(value) {
  let ip = String(value).toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(ip) === 6) {
    // 仅允许全球单播 IPv6；也拦截 IPv4-mapped 和转换前缀。
    return !/^[23][0-9a-f]{0,3}:/.test(ip) || /^2001:(?:0:|db8:)/.test(ip) || /^2002:/.test(ip);
  }
  if (net.isIP(ip) !== 4) return true;
  const [a,b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0);
}
async function resolvePublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error("仅支持无凭证的http(s)网址");
  if (u.port && !["80", "443"].includes(u.port)) throw new Error("公共浏览仅允许80/443端口");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const records = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!records.length || records.some(r => privateIP(r.address))) throw new Error("SSRF拦截：解析结果含私网或保留地址");
  return { u, address: records[0].address, family: records[0].family };
}
async function safeGet(url, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024, redirects = 0) {
  if (redirects > 5) throw new Error("重定向过多");
  const { u, address, family } = await resolvePublic(url);
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    // DNS结果固定到本次连接，避免检查后再次解析造成重绑定；TLS仍校验原主机。
    const req = mod.get(u, { timeout: timeoutMs, lookup: (_, opts, cb) => {
      if (opts.all) cb(null, [{ address, family }]); else cb(null, address, family);
    }, headers: { "User-Agent": "Mozilla/5.0 Lumen/1.5", Accept: "text/html,text/plain,*/*" } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume(); safeGet(new URL(res.headers.location, u).href, timeoutMs, maxBytes, redirects + 1).then(resolve, reject); return;
      }
      let size = 0; const chunks = [];
      res.on("data", c => { size += c.length; if (size > maxBytes) req.destroy(new Error("网页超出读取上限")); else chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), finalUrl: u.href }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("抓取超时"))); req.on("error", reject);
  });
}
module.exports = { safeGet, resolvePublic, privateIP };
