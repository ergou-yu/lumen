/* 持续工作：浏览器负责呈现，执行、检查点和共享记忆由服务桥保存。 */
(function () {
  "use strict";
  var store = window.LumenStore, latest = null, attached = {}, online = false, pollBusy = false, needsRender = false;
  var states = { queued: "排队中", running: "执行中", executing: "执行已批准动作", done: "完成", failed: "失败", paused: "已暂停", stopped: "已停止", sleeping: "等待跟进", waiting_children: "等待子任务", waiting_desktop: "等待计算机执行结果", waiting_user: "等待本人操作", waiting_approval: "等待批准", uncertain: "需要核实外部结果" };
  var root = document.createElement("section"); root.id = "panel-activity"; root.className = "panel"; root.hidden = true;
  root.innerHTML = '<header class="page-head"><h1>持续工作</h1><p class="page-sub">把责任交给 Lumi。任务与记忆保存在服务桥，关闭页面后继续。</p></header><div id="continuity-status" role="status"></div><div class="continuity-grid"><div id="continuity-main"></div><aside id="continuity-side"></aside></div>';
  document.querySelector("main").appendChild(root);
  function nav(cls) { var b = document.createElement("button"); b.type = "button"; b.className = cls; b.dataset.tab = "activity"; b.innerHTML = '<svg viewBox="0 0 24 24" class="ico"><path d="M5 6h14M5 12h9M5 18h6"/><circle cx="18" cy="17" r="4"/></svg><span>活动</span>'; return b; }
  document.querySelector("#side-nav").appendChild(nav("nav-btn"));
  document.querySelector(".bottom-nav, #bottom-nav, .tabbar")?.appendChild(nav("tab-btn"));
  // 移动导航没有固定id，复用已存在的tab按钮的父容器。
  if (!document.querySelector('.tab-btn[data-tab="activity"]')) document.querySelector(".tab-btn")?.parentNode.appendChild(nav("tab-btn"));
  function node(tag, cls, value) { var e = document.createElement(tag); if (cls) e.className = cls; if (value != null) e.textContent = value; return e; }
  function base() { return window.LumenBridgeBase == null ? location.protocol === "file:" ? "http://127.0.0.1:8787" : "" : window.LumenBridgeBase; }
  async function api(p, method, b) {
    var r = await fetch(base() + p, { method: method || "GET", headers: b ? { "Content-Type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
    var d = await r.json(); if (!r.ok || d.ok === false) throw new Error(d.error || "服务桥请求失败"); return d;
  }
  function message(s) { var e = document.querySelector("#continuity-status"); e.textContent = s; }
  function button(parent, label, action, cls) {
    var b = node("button", "chip " + (cls || ""), label); b.type = "button";
    b.onclick = async function () { b.disabled = true; try { await action(); await poll(true); } catch (e) { message(e.message); } finally { b.disabled = false; } }; parent.appendChild(b); return b;
  }
  function field(form, label, tag, value, type) {
    var l = node("label", "continuity-label", label), e = node(tag || "input");
    if (tag !== "textarea") e.type = type || "text"; e.value = value || ""; l.appendChild(e); form.appendChild(l); return e;
  }
  function select(form, label, choices, value) {
    var l = node("label", "continuity-label", label), e = node("select");
    choices.forEach(function (c) { var o = node("option", "", c[1]); o.value = c[0]; e.appendChild(o); }); e.value = value; l.appendChild(e); form.appendChild(l); return e;
  }
  function card(parent, title) { var c = node("section", "continuity-card"); if (title) c.appendChild(node("h2", "", title)); parent.appendChild(c); return c; }
  function formHandler(f, fn) { f.onsubmit = async function (e) { e.preventDefault(); var b = f.querySelector('[type="submit"]'); b.disabled = true; try { await fn(); await poll(true); } catch (err) { message(err.message); } finally { b.disabled = false; } }; }
  function submit(f, label) { var b = node("button", "chip solid", label); b.type = "submit"; f.appendChild(b); }
  function time(t) { return t ? new Date(t).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—"; }
  async function command(j, op, extra) { return api("/agent/jobs/" + j.id, "POST", Object.assign({ op: op }, extra || {})); }
  async function migrate() {
    var id = localStorage.getItem("lumen-import-id"); if (!id) { id = store.uid(); localStorage.setItem("lumen-import-id", id); }
    return api("/agent/import", "POST", { id: id, memories: store.state.memories, goals: store.state.goals });
  }
  function render() {
    if (!latest) return;
    var main = root.querySelector("#continuity-main"), side = root.querySelector("#continuity-side"); main.replaceChildren(); side.replaceChildren();
    var setup = card(main, "常驻执行");
    setup.appendChild(node("p", "", latest.model.ready ? "已连接 " + latest.model.model + " · 同时执行最多 2 项任务" : "先配置后台模型，才能在页面关闭后继续工作。"));
    setup.appendChild(node("p", "continuity-muted", "服务桥必须保持运行。本机休眠或关机后会暂停；部署到常在线主机后可继续。"));
    var imageModel = field(setup, "生图模型（Images API端点需要支持此模型）", "input", latest.model.imageModel);
    button(setup, "启用当前模型", async function () {
      var c = window.LumenAI.current(); if (!c) throw new Error("请先到设置 → 模型接入，配置你的模型");
      if (c.id !== "localgw") await api("/agent/model", "POST", Object.assign({},c,{ imageModel: imageModel.value }));
      else if (!latest.model.ready) throw new Error("本地网关需配置 LUMEN_MODEL_API_KEY 与 LUMEN_MODEL_BASE");
      await migrate(); store.state.settings.serverTasks = true; store.save();
      message("后台执行已启用。模型密钥另存服务桥私有文件（0600），接口不会回传。");
    }, "solid");
    button(setup, store.state.settings.serverTasks === false ? "将新聊天放到后台" : "新聊天改为页面执行", async function () { store.state.settings.serverTasks = store.state.settings.serverTasks === false; store.save(); });
    button(setup, "导出活动与共享记忆", function () {
      var url = URL.createObjectURL(new Blob([JSON.stringify(latest, null, 2)], { type: "application/json" }));
      var a = node("a"); a.href = url; a.download = "lumi-activity.json"; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
    var task = card(main, "交给 Lumi"); var f = node("form");
    var prompt = field(f, "责任或任务", "textarea", ""); prompt.required = true; prompt.placeholder = "例如：核对工作区里的计划，找出本周待决定的事项。";
    submit(f, "开始后台任务"); formHandler(f, async function () { await api("/agent/jobs", "POST", { prompt: prompt.value }); message("任务已保存"); }); task.appendChild(f);
    var jobs = card(main, "活动记录");
    if (!latest.jobs.length) jobs.appendChild(node("p", "continuity-muted", "还没有后台任务。任务可独立暂停、继续和补充指令。"));
    latest.jobs.forEach(function (j) {
      var c = node("article", "continuity-job"); jobs.appendChild(c);
      c.appendChild(node("h3", "", j.title)); c.appendChild(node("p", "continuity-state", (states[j.status] || j.status) + " · " + time(j.updatedAt) + (j.parentId ? " · 子任务" : "") + " · " + j.channel));
      var description = node("details"); description.appendChild(node("summary", "", "任务与执行记录")); description.appendChild(node("pre", "", j.prompt));
      (j.events || []).slice(-12).forEach(function (e) { description.appendChild(node("p", "continuity-muted", time(e.time) + " · " + e.detail)); }); c.appendChild(description);
      if (j.wakeAt) c.appendChild(node("p", "", "下一次跟进：" + time(j.wakeAt)));
      if (j.result) { var result = node("div", "continuity-result"); result.innerHTML = window.LumenUI.markdown(j.result); c.appendChild(result); }
      if (j.error) c.appendChild(node("p", "continuity-error", j.error));
      (j.artifacts || []).forEach(function (name) { var a = node("a", "chip", "下载 " + name); a.href = base() + "/vm/file/" + name.split("/").map(encodeURIComponent).join("/"); a.download = name.split("/").pop(); c.appendChild(a); if (/\.png$/i.test(name)) { var img = node("img", "continuity-image"); img.src = a.href; img.alt = "Lumi生成的图像"; img.loading = "lazy"; c.appendChild(img); } });
      if (j.pending && j.status === "waiting_approval") {
        var approval = node("div", "continuity-approval"); approval.appendChild(node("h4", "", "等待你的批准"));
        approval.appendChild(node("pre", "", JSON.stringify(j.pending.action, null, 2)));
        button(approval, "批准这一次", function () { return command(j, "approve", { approvalId: j.pending.id, allow: true }); }, "solid");
        button(approval, "拒绝并停止", function () { return command(j, "approve", { approvalId: j.pending.id, allow: false }); }); c.appendChild(approval);
      }
      var controls = node("div", "continuity-actions");
      if (["running", "queued", "sleeping", "waiting_children", "waiting_desktop", "waiting_approval"].includes(j.status)) button(controls, "暂停", function () { return command(j, "pause"); });
      if (["paused", "failed", "sleeping", "waiting_user"].includes(j.status)) button(controls, "继续", function () { return command(j, "resume"); });
      if (!["done", "stopped", "executing"].includes(j.status)) button(controls, "停止", function () { return command(j, "stop"); });
      if (["done", "stopped", "failed", "uncertain"].includes(j.status)) button(controls, "删除记录", function () { return api("/agent/jobs/" + j.id, "DELETE", {}); }); c.appendChild(controls);
      if (!["executing", "uncertain", "stopped"].includes(j.status)) {
        var steer = node("form", "continuity-inline"); var input = field(steer, "补充或调整指令", "input", ""); input.required = true;
        submit(steer, "补充"); formHandler(steer, function () { return command(j, "steer", { text: input.value }); }); c.appendChild(steer);
      }
    });
    var schedules = card(side, "计划任务");
    latest.schedules.forEach(function (s) {
      var c = node("article", "continuity-job"); c.appendChild(node("h3", "", s.title));
      c.appendChild(node("p", "", (s.enabled ? "已启用" : "已暂停") + " · " + s.timing.timezone + " · 下次 " + time(s.nextRun)));
      c.appendChild(node("p", "continuity-muted", s.prompt));
      button(c, s.enabled ? "暂停计划" : "启用计划", function () { return api("/agent/schedules/" + s.id, "POST", { op: "toggle" }); });
      button(c, "删除计划", function () { return api("/agent/schedules/" + s.id, "POST", { op: "delete" }); }); schedules.appendChild(c);
      var edit = node("details"); edit.appendChild(node("summary", "", "编辑责任、时间与通知"));
      var ef = node("form"), ep = field(ef,"责任内容","textarea",s.prompt);
      var ek = select(ef,"运行方式",[["daily","每天"],["weekdays","工作日"],["interval","固定间隔"],["once","一次性"]],s.timing.kind);
      var ez = field(ef,"时区","input",s.timing.timezone), et = field(ef,"每天时间","input",s.timing.time,"time"), ei = field(ef,"间隔（分钟）","input",s.timing.intervalMin || 30,"number"), ea = field(ef,"一次性时间（含时区）","input",s.timing.at || ""), ee = field(ef,"结束时间（可选）","input",s.timing.endAt || "");
      var en = select(ef,"通知",[["changes","来源内容变化时"],["all","每次完成时"]],s.notify), er = select(ef,"任务权限",[["readonly","只读研究与建议"],["work","执行工作（外部写入仍审批）"]],s.readOnly ? "readonly":"work");
      function visibility() { et.parentNode.hidden = !["daily","weekdays"].includes(ek.value); ei.parentNode.hidden = ek.value !== "interval"; ea.parentNode.hidden = ek.value !== "once"; } ek.onchange = visibility; visibility();
      submit(ef,"更新计划"); formHandler(ef,function(){return api("/agent/schedules/"+s.id,"POST",{op:"update",prompt:ep.value,notify:en.value,readOnly:er.value === "readonly",timing:{kind:ek.value,timezone:ez.value,time:et.value,intervalMin:Number(ei.value),at:ea.value,endAt:ee.value}});}); edit.appendChild(ef); c.appendChild(edit);
    });
    var sf = node("form"); var sp = field(sf, "重复做什么", "textarea", ""); sp.required = true;
    var kind = select(sf, "运行方式", [["daily", "每天"], ["weekdays", "工作日"], ["interval", "固定间隔"], ["once", "一次性"]], "daily");
    var zone = field(sf, "时区", "input", "Asia/Shanghai"); var tm = field(sf, "每天时间", "input", "09:00", "time");
    var interval = field(sf, "间隔（分钟，至少10）", "input", "30", "number");
    var at = field(sf, "一次性时间（含时区ISO）", "input", ""); at.placeholder = "2026-10-03T09:00:00+08:00";
    var end = field(sf, "结束时间（可选，含时区ISO）", "input", "");
    var policy = select(sf, "通知", [["changes", "来源内容变化时"], ["all", "每次完成时"]], "changes");
    var mode = select(sf, "任务权限", [["readonly", "只读研究与建议"], ["work", "执行工作（外部写入仍审批）"]], "readonly");
    function scheduleFields() { tm.parentNode.hidden = !["daily", "weekdays"].includes(kind.value); interval.parentNode.hidden = kind.value !== "interval"; at.parentNode.hidden = kind.value !== "once"; } kind.onchange = scheduleFields; scheduleFields();
    submit(sf, "保存计划"); formHandler(sf, function () { return api("/agent/schedules", "POST", { prompt: sp.value, readOnly: mode.value === "readonly", notify: policy.value,
      timing: { kind: kind.value, timezone: zone.value, time: tm.value, intervalMin: Number(interval.value), at: at.value, endAt: end.value } }); }); schedules.appendChild(sf);
    schedules.appendChild(node("p", "continuity-muted", "暂停一个任务不取消计划；取消计划不停止已经开始的任务。"));
    var notes = card(side, "共享记忆");
    button(notes, "迁移此浏览器的记忆与目标", migrate);
    latest.memories.forEach(function (m) { var f = node("form", "continuity-job"); var t = field(f, m.kind || "事实", "textarea", m.text); submit(f, "保存修改"); formHandler(f, function () { return api("/agent/memories", "POST", { id: m.id, text: t.value, kind: m.kind }); }); button(f, "遗忘", function () { return api("/agent/memories/" + m.id, "DELETE", {}); }); notes.appendChild(f); });
    var nf = node("form"); var nt = field(nf, "让 Lumi 记住", "textarea", ""); nt.required = true; submit(nf, "保存记忆"); formHandler(nf, function () { return api("/agent/memories", "POST", { text: nt.value }); }); notes.appendChild(nf);
    var goals = card(side, "共享目标");
    latest.goals.forEach(function (g) { goals.appendChild(node("h3", "", g.title)); (g.steps || []).forEach(function (s, i) { var l = node("label", "continuity-check"); var ch = node("input"); ch.type = "checkbox"; ch.checked = s.done; ch.onchange = async function () { try { await api("/agent/goals", "POST", { id: g.id, stepIndex: i, done: ch.checked }); await poll(true); } catch (e) { message(e.message); } }; l.append(ch, document.createTextNode(s.text)); goals.appendChild(l); }); });
    latest.goals.forEach(function(g){ button(goals,"删除目标："+g.title,function(){ return api("/agent/goals/"+g.id,"DELETE",{}); }); });
    var gf = node("form"), gt = field(gf,"新目标","input",""), gs = field(gf,"步骤（每行一个）","textarea",""); gt.required = true;
    submit(gf,"建立共享目标"); formHandler(gf,function(){ return api("/agent/goals","POST",{title:gt.value,steps:gs.value.split("\n").filter(function(s){return s.trim();})}); }); goals.appendChild(gf);
    var profile = card(side, "你的 Lumi"); var pf = node("form"); var pn = field(pf, "名字", "input", latest.profile.name);
    var shape = select(pf, "形状", [["orb", "圆点"], ["leaf", "叶子"], ["spark", "星光"]], latest.profile.shape);
    var color = field(pf, "颜色", "input", latest.profile.color, "color"); var eyes = select(pf, "眼睛", [["calm", "平静"], ["happy", "开心"], ["curious", "好奇"]], latest.profile.eyes);
    var glasses = select(pf, "眼镜", [["no", "无"], ["yes", "有"]], latest.profile.glasses ? "yes" : "no");
    var accessory = select(pf,"配饰",[["none","无"],["flower","花朵"],["star","星星"],["bow","蝴蝶结"]],latest.profile.accessory || "none");
    var preview = node("div", "lumi-dot " + latest.profile.shape + " " + latest.profile.eyes, latest.profile.glasses ? "⊙ ⊙" : latest.profile.eyes === "happy" ? "⌒ ⌒" : "• •"); preview.style.backgroundColor = latest.profile.color; profile.appendChild(preview);
    if (latest.profile.accessory && latest.profile.accessory !== "none") preview.appendChild(node("span","lumi-accessory",{flower:"✿",star:"★",bow:"🎀"}[latest.profile.accessory]));
    submit(pf, "保存外观"); formHandler(pf, async function () { await api("/agent/profile", "POST", { name: pn.value, shape: shape.value, color: color.value, eyes: eyes.value, glasses: glasses.value === "yes", accessory:accessory.value }); store.state.settings.agentName = pn.value; store.save(); window.LumenUI.refreshIdentity(); }); profile.appendChild(pf);
    var channels = card(side, "消息渠道");
    var appPermissions = card(main,"应用权限");
    appPermissions.appendChild(node("p","continuity-muted","在设置中接入账号，再在这里明确授权。默认禁用；读取与写入独立。禁用后后台不能继续访问，写入还需批准每个具体动作。"));
    Object.keys(latest.connectors || {}).forEach(function(id){
      var cfg=latest.connectors[id], perm=cfg.permissions || {}, f=node("form","continuity-job");
      f.appendChild(node("h3","",{lark:"飞书",google:"Google",mail:"SMTP / 邮件统一入口",microsoft:"Microsoft Graph"}[id]));
      f.appendChild(node("p","continuity-muted",cfg.configured ? (cfg.authorized === false ? "已配置，尚未授权账号":"已配置账号；连通性需实际验证") : "尚未配置账号"));
      var on=select(f,"启用",[["no","禁用"],["yes","启用"]],perm.on ? "yes":"no"), read=select(f,"读取",[["no","禁止"],["yes","允许"]],perm.read ? "yes":"no"), write=select(f,"写入",[["no","禁止"],["yes","允许（仍需具体审批）"]],perm.write ? "yes":"no");
      submit(f,"保存权限"); formHandler(f,function(){return api("/connectors/permissions","POST",{id,on:on.value === "yes",read:read.value === "yes",write:write.value === "yes"});}); appPermissions.appendChild(f);
    });
    channels.appendChild(node("p", "continuity-muted", "接入后只响应绑定本人的私聊。需要你自己的平台应用与公开HTTPS回调；接口与签名已实现，尚未用真实账号验收。"));
    var definitions = {
      slack: [["owner", "本人Slack用户ID"], ["token", "Bot Token"], ["signingSecret", "Signing Secret"]],
      whatsapp: [["owner", "本人号码（国家码+号码）"], ["phoneId", "Phone Number ID"], ["token", "Access Token"], ["appSecret", "App Secret"], ["verifyToken", "Webhook Verify Token"], ["version", "Graph API版本（可选）"]],
      teams: [["owner", "本人Entra Object ID"], ["appId", "Bot App ID"], ["appSecret", "Bot App Secret"], ["tenantId", "Tenant ID"]],
    };
    Object.keys(definitions).forEach(function (id) {
      var detail = node("details"); detail.appendChild(node("summary", "", id === "slack" ? "Slack" : id === "teams" ? "Microsoft Teams" : "WhatsApp"));
      var st = latest.channels && latest.channels[id]; detail.appendChild(node("p", "continuity-muted", st && st.enabled && st.configured ? "已配置（平台连通性待实际验证）" : "未启用"));
      detail.appendChild(node("pre", "", "/channels/" + id + "/events"));
      var cf = node("form"), inputs = {};
      definitions[id].forEach(function (pair) { inputs[pair[0]] = field(cf, pair[1], "input", "", /secret|token/i.test(pair[0]) ? "password" : "text"); inputs[pair[0]].autocomplete = "off"; });
      submit(cf, "保存并启用本人私聊"); formHandler(cf, function () { var b = { id: id, enabled: true }; Object.keys(inputs).forEach(function (k) { if (inputs[k].value) b[k] = inputs[k].value; }); return api("/channels/config", "POST", b); });
      button(cf, "禁用此渠道", function () { return api("/channels/config", "POST", { id: id, enabled: false }); }); detail.appendChild(cf); channels.appendChild(detail);
    });
    var notifications = card(side, "通知"); button(notifications, "全部标为已读", function () { return api("/agent/notifications/read", "POST", {}); });
    latest.notifications.slice(0, 10).forEach(function (n) { notifications.appendChild(node("p", n.read ? "continuity-muted" : "", n.title + " · " + n.detail)); });
    renderIdeas();
  }
  function renderIdeas() {
    var c = document.querySelector("#personal-ideas");
    if (!c) { c = node("section","continuity-card"); c.id="personal-ideas"; document.querySelector("#ideas-grid").before(c); }
    c.replaceChildren(); c.appendChild(node("h2","","根据你的目标提出建议"));
    c.appendChild(node("p","continuity-muted","建议使用服务桥中的记忆与目标。生成建议只做研究，点击委托后才执行。"));
    button(c,"生成个性化建议",function(){ return api("/agent/jobs","POST",{title:"为我提出建议",readOnly:true,prompt:"根据共享目标和用户已表达的偏好，提出最多3个具体有价值的建议，用idea保存标题、委托内容与依据。目标和偏好不足时明确说明缺少什么，不要虚构。不执行建议中的工作。"}); },"solid");
    (latest.ideas || []).forEach(function(i){ var a=node("article","continuity-job"); a.appendChild(node("h3","",i.title)); a.appendChild(node("p","",i.reason)); a.appendChild(node("p","continuity-muted",i.prompt)); button(a,"交给Lumi",function(){return api("/agent/jobs","POST",{title:i.title,prompt:i.prompt});}); button(a,"移除建议",function(){return api("/agent/ideas/"+i.id,"DELETE",{});}); c.appendChild(a); });
  }
  function syncJobs() {
    latest.jobs.forEach(function (j) {
      var a = attached[j.id];
      if (!a && j.conversationId) {
        var conv = store.state.conversations.find(function (c) { return c.id === j.conversationId; });
        var msg = conv && conv.messages.find(function (m) { return m.serverJobId === j.id && m.role === "activity"; });
        if (msg) a = attached[j.id] = { convId: conv.id, actId: msg.id, status: "", hooks: window.LumenUI.taskHooks };
      }
      if (!a || a.status === j.status + j.updatedAt) return; a.status = j.status + j.updatedAt;
      var end = ["done", "failed", "stopped", "waiting_user"].includes(j.status);
      store.updateMessageIn(a.convId, a.actId, { state: j.status === "waiting_user" ? "waiting" : j.status === "failed" ? "failed" : j.status === "done" ? "done" : end ? "aborted" : "running", steps: [{ label: (states[j.status] || j.status) + " · " + (j.events.slice(-1)[0]?.detail || ""), status: j.status === "done" ? "done" : end ? "pending" : "active" }] });
      a.hooks.patchActivity(a.actId, {});
      if (end) {
        var conv = store.state.conversations.find(function (c) { return c.id === a.convId; });
        if (conv) {
          var reply = conv.messages.find(function (m) { return m.serverJobId === j.id && m.role === "agent"; });
          if (reply && reply.serverUpdatedAt === j.updatedAt) return;
          if (reply) store.updateMessageIn(a.convId, reply.id, { serverUpdatedAt: j.updatedAt, text: j.result || j.error || "任务已停止" });
          else reply = store.addMessageTo(a.convId, { role: "agent", serverJobId: j.id, serverUpdatedAt: j.updatedAt, text: j.result || j.error || "任务已停止" });
          if (store.state.activeConvId === a.convId) a.hooks.upsertReply(reply);
          if (voice.on && j.status === "done") voice.speak(j.result);
        }
      }
    });
  }
  async function poll(force) {
    if (pollBusy) return; pollBusy = true;
    try {
      var values = await Promise.all([api("/agent/state"), api("/channels"), api("/connectors/permissions")]); var d = values[0]; d.channels = values[1].channels; d.connectors = values[2].connectors; online = true;
      var changed = !latest || JSON.stringify(d) !== JSON.stringify(latest); latest = d;
      if (window.LumenWorkspace) window.LumenWorkspace.onState(d);
      if (document.querySelector("#continuity-status").textContent.startsWith("服务桥未连接：")) message("");
      if (changed || force || needsRender) {
        syncJobs();
        window.LumenUI.taskHooks.onRunningChange(window.LumenAgent.running);
        // 不在轮询中重建正在输入的表单，避免草稿和焦点丢失。
        if (force || !root.contains(document.activeElement) || !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { render(); needsRender = false; }
        else needsRender = true;
      }
    } catch (e) { online = false; if (!latest) message("服务桥未连接：" + e.message); }
    finally { pollBusy = false; }
  }
  async function runTask(text, hooks) {
    var conv = store.activeConversation(), act = store.addMessageTo(conv.id, { role: "activity", state: "running", intent: "background", steps: [{ label: "保存到服务桥", status: "active" }] }); hooks.activity(act);
    try {
      var d = await api("/agent/jobs", "POST", { prompt: text, conversationId: conv.id });
      store.updateMessageIn(conv.id, act.id, { serverJobId: d.job.id }); attached[d.job.id] = { convId: conv.id, actId: act.id, hooks: hooks, status: "" }; await poll(true);
    } catch (e) {
      store.updateMessageIn(conv.id, act.id, { state: "aborted" }); hooks.patchActivity(act.id, {});
      var m = store.addMessageTo(conv.id, { role: "agent", text: "后台任务未提交：" + e.message }); hooks.streamStart(m); hooks.streamEnd(m.id);
    }
  }
  var voice = { on: false, rec: null, speaking: false,
    listen: function () {
      if (!this.on || this.speaking) return;
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      var rec = this.rec = new SR(); rec.lang = "zh-CN"; rec.continuous = false; rec.interimResults = false;
      rec.onresult = function (e) { var text = Array.from(e.results).filter(function (r) { return r.isFinal; }).map(function (r) { return r[0].transcript; }).join(""); if (text) window.LumenUI.send(text); };
      rec.onend = function () { if (voice.on && !voice.speaking) setTimeout(function () { voice.listen(); }, 300); };
      rec.onerror = function (e) { if (["not-allowed", "service-not-allowed", "audio-capture"].includes(e.error)) { voice.end(); message("语音不可用：" + e.error); } };
      try { rec.start(); } catch (_) { voice.end(); }
    },
    speak: function (text) {
      if (!this.on || !window.speechSynthesis) return;
      this.speaking = true; if (this.rec) this.rec.stop(); speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text.replace(/[#*`]/g, "").slice(0, 1200)); u.lang = "zh-CN";
      u.onend = u.onerror = function () { voice.speaking = false; voice.listen(); }; speechSynthesis.speak(u);
    },
    end: function () { this.on = false; this.speaking = false; if (this.rec) this.rec.abort(); if (window.speechSynthesis) speechSynthesis.cancel(); var b = document.querySelector("#btn-call-lumi"); if (b) b.textContent = "语音对话"; },
  };
  function init() {
    var call = node("button", "chip", "语音对话"); call.id = "btn-call-lumi"; call.type = "button";
    call.onclick = function () { if (voice.on) { voice.end(); return; } if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) { message("此浏览器不支持语音识别，可使用文字聊天"); return; } voice.on = true; call.textContent = "结束语音"; voice.listen(); };
    document.querySelector(".composer-wrap").appendChild(call);
    call.title = "浏览器语音识别与朗读；结束语音不会停止后台任务";
    document.querySelector("#input").addEventListener("input", function () { if (voice.speaking) { speechSynthesis.cancel(); voice.speaking = false; } });
    poll(); setInterval(poll, 2000); window.addEventListener("focus", function () { poll(true); });
  }
  window.LumenContinuity = { init: init, runTask: runTask, poll: poll,
    selectModel: async function (model) {
      var d = await api("/agent/model/select", "POST", { model: model });
      if (latest) latest.model = d;
      store.state.settings.serverTasks = true; store.save();
      await poll(true); return d;
    },
    configureModel: async function (config) {
      var d = await api("/agent/model", "POST", config);
      if (latest) latest.model = d;
      store.state.settings.serverTasks = true; store.save();
      await poll(true); return d;
    },
    get model() { return online && latest ? latest.model : null; },
    get ready() { return online && latest && latest.model.ready; },
    get running() { return latest ? latest.jobs.filter(function (j) { return ["queued", "running", "executing", "waiting_desktop", "waiting_approval"].includes(j.status); }).length : 0; },
    stop: function () { if (latest) return Promise.all(latest.jobs.filter(function (j) { return !["done", "failed", "stopped", "executing"].includes(j.status); }).map(function (j) { return command(j, "stop"); })); },
  };
})();
