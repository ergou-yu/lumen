"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");

// 显式指定已启动的测试桌面控制地址才运行；默认测试不会操作用户桌面。
test("真实 Chromium：菜单优先、可信点击输入、切换标签后观察与读取保持一致", { skip: !process.env.LUMEN_TEST_BOX_URL }, async t => {
  const base = process.env.LUMEN_TEST_BOX_URL;
  const act = async (op, args = {}) => {
    const r = await fetch(base + "/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(20000) });
    const d = await r.json(); assert.equal(d.ok, true, d.error); return d;
  };
  const observe = async () => { const d = await fetch(base + "/observe?max=40").then(r => r.json()); assert.equal(d.ok, true, d.error); return d; };
  const html = '<!doctype html><meta charset="utf-8"><title>Lumi Browser Regression A</title><style>button{height:24px;width:110px}nav{display:flex;flex-wrap:wrap}main{padding:12px}[role=menuitem]{padding:15px;background:#def;width:220px}</style>' +
    '<nav>' + Array.from({ length: 50 }, (_, i) => `<button>导航 ${i}</button>`).join('') + '</nav><main><button onclick="document.getElementById(\'menu\').hidden=false">打开菜单</button>' +
    '<div id="menu" role="menu" hidden><div role="menuitem" tabindex="0" onclick="document.getElementById(\'result\').textContent=\'MENU_SELECTED\'">读取菜单结果</div></div>' +
    '<input aria-label="测试输入" oninput="document.getElementById(\'result\').textContent=this.value"><p id="result">尚未操作</p></main>';
  const script = `const http=require('http');const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url==='/b'?'<title>Lumi Browser Regression B</title><p>SECOND_TAB</p>':${JSON.stringify(html)});});server.listen(0,'127.0.0.1',()=>console.log(server.address().port));process.stdin.on('data',()=>process.exit(0));setTimeout(()=>process.exit(0),120000);`;
  const child = spawn("docker", ["exec", "-i", "lumen-box", "node", "-e", script]);
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("测试页面服务未启动")), 10000); let output = "";
    child.stdout.on("data", b => { output += b; if (output.includes("\n")) { clearTimeout(timer); resolve(Number(output.trim())); } });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("exit", code => { clearTimeout(timer); if (!output) reject(new Error("测试服务退出 " + code)); });
  });
  const page = "http://127.0.0.1:" + port;
  t.after(async () => {
    try {
      for (let n = 0; n < 2; n++) {
        const tabs = (await act("tablist")).tabs, own = tabs.find(x => x.url.startsWith(page));
        if (!own) break; await act("tabswitch", { n: own.n }); await act("tabclose");
      }
    } finally { child.stdin.end("stop\n"); }
  });
  await act("tabnew"); await act("navigate", { url: page + "/a" });
  await act("tabnew"); await act("navigate", { url: page + "/b" });
  const tabs = (await act("tablist")).tabs;
  await act("tabswitch", { n: tabs.find(x => x.url === page + "/a").n });
  let obs = await observe(); assert.match(obs.title, /Regression A/); assert.equal((await act("read")).title, obs.title);
  const open = obs.elements.find(e => e.text === "打开菜单"); assert.ok(open, "导航栏不能挤掉主操作");
  await act("click", { n: open.n }); obs = await observe();
  const item = obs.elements.find(e => e.role === "menuitem"); assert.ok(item); assert.equal(item.n, 1);
  await act("click", { n: item.n }); assert.match((await act("read")).text, /MENU_SELECTED/);
  obs = await observe(); const input = obs.elements.find(e => e.tag === "input");
  await act("fill", { n: input.n, text: "INPUT_OK" }); assert.match((await act("read")).text, /INPUT_OK/);
});
