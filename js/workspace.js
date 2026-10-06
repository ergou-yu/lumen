/* 聊天与电脑共用一个工作区；页面轮询只更新状态，不重建 VNC 连接。 */
(function () {
  "use strict";
  var store = window.LumenStore, root, latest, status, tasks = [], opened = false, tab = "chat", busy = false, hiddenTask = "", approvalKey = "";
  var labels = { queued:"排队中", running:"正在执行", waiting_approval:"需要批准", waiting_user:"等你操作", paused:"已暂停", done:"已完成", failed:"需要处理", stopped:"已停止" };
  function $(id) { return document.getElementById(id); }
  function node(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }
  async function api(path, body) {
    var base = window.LumenBridgeBase == null ? "http://127.0.0.1:8787" : window.LumenBridgeBase;
    var r = await fetch(base + path, { method:body ? "POST" : "GET", headers:body ? {"Content-Type":"application/json"} : undefined, body:body ? JSON.stringify(body) : undefined });
    var d = await r.json(); if (!r.ok || d.ok === false) throw Error(d.error || "连接未恢复"); return d;
  }
  function current() {
    var conv = store.state.activeConvId;
    var jobs = latest ? latest.jobs.filter(function(j){return j.conversationId === conv && j.desktopTaskIds && j.desktopTaskIds.length;}) : [];
    var job = jobs[0], task = job && tasks.find(function(t){return job.desktopTaskIds.includes(t.id);});
    return { job:job, task:task };
  }
  function visibility() {
    var visible = opened && tab === "chat"; root.hidden = !visible;
    document.body.classList.toggle("workspace-open", visible);
    $("btn-open-computer").setAttribute("aria-expanded", String(visible));
  }
  function open() { opened = true; visibility(); refresh(); }
  function button(parent, label, fn, solid) {
    var b = node("button", "chip" + (solid ? " solid" : ""), label); b.type = "button";
    b.addEventListener("click", async function(){b.disabled = true; try{await fn(); await refresh(); if(window.LumenContinuity) await window.LumenContinuity.poll(true);}catch(e){$("workspace-hint").textContent=e.message;}finally{b.disabled=false;}}); parent.appendChild(b); return b;
  }
  async function giveBack() {
    await api("/vm/desktop/control", {takeover:false});
    var c = current();
    if (c.job && ["waiting_user","failed","paused"].includes(c.job.status)) await api("/agent/jobs/" + c.job.id, {op:"resume"});
    else if (c.task && ["waiting_user","failed","paused"].includes(c.task.status)) await api("/vm/desktop/tasks/" + c.task.id + "/resume", {});
  }
  function render() {
    if (!root || !status) return;
    var c = current(), t = c.task;
    $("workspace-state").textContent = status.takeover ? "你在控制" : t ? labels[t.status] || t.status : status.live ? "电脑已就绪" : "电脑待连接";
    var hint = status.takeover ? "完成当前步骤后，交还给 Lumi 继续。" : t && ["waiting_user","failed"].includes(t.status) ? t.summary : status.error || "可观看实时执行，遇到需要本人处理的步骤随时接管。";
    $("workspace-hint").textContent = hint;
    var view = $("workspace-screen"), frame = view.querySelector("iframe");
    view.classList.toggle("watch", !status.takeover);
    $("workspace-empty").hidden = !!status.novncUrl;
    if (status.novncUrl) {
      if (!frame) { frame = document.createElement("iframe"); frame.title = "Lumi 虚拟机实时画面"; frame.setAttribute("allow","clipboard-read; clipboard-write"); view.appendChild(frame); }
      if (frame.getAttribute("src") !== status.novncUrl) frame.src = status.novncUrl;
      frame.hidden = false;
    } else if (frame) frame.hidden = true;
    var bar = $("workspace-controls"); bar.replaceChildren();
    if (status.live) {
      if (status.takeover) button(bar,"交还 Lumi 并继续",giveBack,true);
      else { button(bar,"我来接管",function(){return api("/vm/desktop/control",{takeover:true});},true); if(t && ["waiting_user","failed","paused"].includes(t.status)) button(bar,"继续原任务",giveBack); }
      button(bar,"重连画面",function(){if(frame) frame.src=status.novncUrl;});
    } else button(bar,"连接电脑",function(){return api("/vm/desktop/start",{});},true);
    var progress = $("workspace-progress"); progress.replaceChildren();
    if (t) {
      progress.appendChild(node("div","workspace-goal",t.goal));
      var steps = t.steps.filter(function(s){return ["act","evidence","handoff","done","error"].includes(s.kind);}).slice(-3);
      steps.forEach(function(s){progress.appendChild(node("div","workspace-step",s.label));});
    } else progress.appendChild(node("p","workspace-step","把任务写在左侧聊天里，Lumi 的执行进度会出现在这里。"));
    var ap = t && t.pendingApproval, key = ap ? t.id + ap.id : "";
    if (approvalKey !== key) {
      approvalKey = key; var box = $("workspace-approval"); box.replaceChildren(); box.hidden = !ap;
      if (ap) {
        box.appendChild(node("strong","",ap.title)); box.appendChild(node("p","",ap.detail));
        button(box,"批准此动作",function(){return api("/vm/desktop/tasks/"+t.id+"/approve",{decision:"allow",approvalId:ap.id});},true);
        button(box,"拒绝",function(){return api("/vm/desktop/tasks/"+t.id+"/approve",{decision:"deny",approvalId:ap.id});});
      }
    }
  }
  async function refresh() {
    if (!root || busy || !opened || tab !== "chat") return; busy = true;
    try { var d=await Promise.all([api("/vm/desktop/status"),api("/vm/desktop/tasks")]); status=d[0]; tasks=d[1].tasks || []; window.LumenDesktop.available=!!status.live; render(); }
    catch(e){$("workspace-hint").textContent=e.message;} finally{busy=false;}
  }
  window.LumenWorkspace = {
    init:function(){
      root=$("computer-workspace");
      $("btn-open-computer").addEventListener("click",function(){if(opened){opened=false;var c=current();hiddenTask=c.job?c.job.id:"";visibility();}else open();});
      $("workspace-close").addEventListener("click",function(){opened=false;var c=current();hiddenTask=c.job?c.job.id:"";visibility();});
      setInterval(refresh,2000);
    },
    open:open,
    onTab:function(value){tab=value;if(root)visibility();},
    onState:function(value){
      latest=value; if(!root)return;
      var c=current();
      if(c.job && ["queued","running","waiting_desktop","waiting_user","paused"].includes(c.job.status) && hiddenTask !== c.job.id){opened=true;visibility();}
      refresh();
    }
  };
})();
