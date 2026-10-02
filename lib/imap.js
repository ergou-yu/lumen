"use strict";
const tls = require("node:tls");
const hosts = { "smtp.qq.com": "imap.qq.com", "smtp.163.com": "imap.163.com", "smtp.126.com": "imap.126.com", "smtp.gmail.com": "imap.gmail.com", "smtp.office365.com": "outlook.office365.com" };
function decodeMimeWord(s) {
  return String(s || "").replace(/\?=\s+(?==\?)/g, "?=").replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, value) => {
    const b = enc.toUpperCase() === "B" ? Buffer.from(value, "base64") : Buffer.from(value.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h,16))), "latin1");
    try { return new TextDecoder(cs).decode(b); } catch (_) { return b.toString("utf8"); }
  });
}
// IMAP literal按字节解析；正文里的换行不具有协议分隔意义。
function sexpr(src) {
  let p = 0;
  function one() {
    while (/\s/.test(src[p] || "") && p < src.length) p++;
    if (src[p] === "(") { p++; const a = []; while (p < src.length && src[p] !== ")") a.push(one()); p++; return a; }
    if (src[p] === '"') { p++; let s = ""; while (p < src.length && src[p] !== '"') { if (src[p] === "\\") p++; s += src[p++]; } p++; return s; }
    if (src[p] === "{") { const m = /^\{(\d+)\}\r\n/.exec(src.slice(p)); if (!m) throw new Error("非法literal"); p += m[0].length; const s = src.slice(p, p + Number(m[1])); p += Number(m[1]); return Buffer.from(s,"latin1").toString("utf8"); }
    const m = /^[^\s()]+/.exec(src.slice(p)); if (!m) throw new Error("非法IMAP表达式"); p += m[0].length; return m[0] === "NIL" ? null : m[0];
  }
  return one();
}
function imapList(cfg, args = {}, connect = tls.connect) {
  const host = cfg.imapHost || hosts[cfg.host] || String(cfg.host).replace(/^smtp\./, "imap.");
  const quote = s => { if (/[\r\n\0]/.test(s)) throw new Error("IMAP凭证含非法字符"); return '"' + String(s).replace(/[\\"]/g, "\\$&") + '"'; };
  const user = quote(cfg.user), pass = quote(cfg.pass);
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port: 993, servername: host });
    let buffer = Buffer.alloc(0), line = "", literal = 0, count = 0, sequence = 0, pending = null, done = false;
    const timer = setTimeout(() => finish(new Error("IMAP超时")), 20000);
    function finish(e, value) { if (done) return; done = true; clearTimeout(timer); sock.destroy(); e ? reject(e) : resolve(value); }
    function command(c) {
      return new Promise((resolve, reject) => { const tag = "a" + (++sequence); pending = { tag, lines: [], resolve, reject }; sock.write(tag + " " + c + "\r\n"); });
    }
    async function work() {
      try {
        await command("LOGIN " + user + " " + pass);
        const selected = await command("SELECT INBOX");
        for (const l of selected) { const m = /^\* (\d+) EXISTS/.exec(l); if (m) count = Number(m[1]); }
        let ids = [];
        const limit = Math.max(1, Math.min(Number(args.limit) || 8, 20));
        if (args.unreadOnly && count) {
          const searched = await command("SEARCH UNSEEN");
          const found = searched.find(l => /^\* SEARCH/.test(l)) || "";
          ids = found.replace(/^\* SEARCH\s*/, "").split(/\s+/).filter(x => /^\d+$/.test(x)).slice(-limit);
        } else if (count) ids = [Math.max(1, count - limit + 1) + ":" + count];
        const list = [];
        if (ids.length) for (const l of await command("FETCH " + ids.join(",") + " (UID ENVELOPE FLAGS)")) {
          if (!/^\* \d+ FETCH/.test(l)) continue;
          const a = sexpr(l.slice(l.indexOf("("))); const fields = {};
          for (let i = 0; i < a.length - 1; i += 2) fields[a[i]] = a[i+1];
          const e = fields.ENVELOPE; if (!e) continue;
          const from = e[2]?.[0];
          list.unshift({ id: fields.UID, from: from ? decodeMimeWord(from[0] || "") + " <" + from[2] + "@" + from[3] + ">" : "?", subject: decodeMimeWord(e[1] || "(无主题)"), date: e[0] || "", seen: (fields.FLAGS || []).includes("\\Seen") });
        }
        sock.write("a" + (++sequence) + " LOGOUT\r\n");
        finish(null, { via: "imap:" + host, total: count, list });
      } catch (e) { finish(e); }
    }
    function handle(l) {
      if (!sequence) { if (!/^\* OK/.test(l)) return finish(new Error("IMAP问候失败")); void work(); return; }
      if (!pending) return;
      if (l.startsWith(pending.tag + " ")) {
        const p = pending; pending = null;
        if (l.startsWith(p.tag + " OK")) p.resolve(p.lines); else p.reject(new Error("IMAP命令失败（请检查授权码和IMAP服务）"));
      } else pending.lines.push(l);
    }
    sock.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (buffer.length && !done) {
          if (literal) { const n = Math.min(literal, buffer.length); line += buffer.subarray(0,n).toString("latin1"); buffer = buffer.subarray(n); literal -= n; if (literal) break; }
          const n = buffer.indexOf("\r\n"); if (n < 0) break;
          line += buffer.subarray(0,n).toString("latin1"); buffer = buffer.subarray(n+2);
          const m = /\{(\d+)\}$/.exec(line);
          if (m) { literal = Number(m[1]); if (literal > 256000) throw new Error("IMAP响应过大"); line += "\r\n"; }
          else { const l = line; line = ""; handle(l); }
        }
        if (buffer.length + line.length > 512000) throw new Error("IMAP响应过大");
      } catch (e) { finish(e); }
    });
    sock.on("error", () => finish(new Error("IMAP连接失败")));
    sock.on("close", () => { if (!done) finish(new Error("IMAP连接提前关闭")); });
  });
}
module.exports = { imapList, sexpr, decodeMimeWord };
