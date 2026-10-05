/* ============================================================
   ui.js —— 界面渲染与交互
   五个 Tab：聊天 / 动态 / 灵感 / 目标 / 文件 ＋ 设置
   动效职责：tab 切换 route-enter、欢迎语 per-char-reveal、
   卡片 ken-burns（CSS 类）、noise-grain 覆盖层注入。
   ============================================================ */
(function () {
  "use strict";

  var store = window.LumenStore;
  // 本地服务桥基址：从服务桥网址打开（http://127.0.0.1:8787）时同源直连（无 CORS），
  // file:// 或其他静态服务器打开时回退到 8787 绝对地址
  var BRIDGE_CANDIDATES = (location.protocol === "http:" || location.protocol === "https:")
    ? ["", "http://127.0.0.1:8787"]
    : ["http://127.0.0.1:8787"];
  window.LumenBridgeBase = BRIDGE_CANDIDATES[0];
  var $ = function (sel) { return document.querySelector(sel); };
  var el = function (tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };
  var esc = function (s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };

  // ———————————————————————————— 轻量 Markdown ————————————————————————————

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, function (m, c) { return "<code>" + c + "</code>"; })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function md(src) {
    if (!src) return "";
    var lines = String(src).replace(/\r/g, "").split("\n");
    var out = [];
    var i = 0;
    var codeBuf = null;
    var listType = null; // "ul" | "ol" | null

    function closeList() {
      if (listType) { out.push("</" + listType + ">"); listType = null; }
    }

    while (i < lines.length) {
      var line = lines[i];
      // 代码块
      if (/^```/.test(line.trim())) {
        closeList();
        if (codeBuf === null) { codeBuf = []; }
        else {
          out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
          codeBuf = null;
        }
        i++; continue;
      }
      if (codeBuf !== null) { codeBuf.push(line); i++; continue; }
      // 表格：连续 | 开头行
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        closeList();
        var head = line.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); });
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }));
          i++;
        }
        var t = "<table style=\"width:100%;border-collapse:collapse;margin:8px 0;font-size:13.5px\">";
        t += "<tr>" + head.map(function (c) { return "<th style=\"text-align:left;padding:6px 10px;border-bottom:2px solid var(--line)\">" + inline(esc(c)) + "</th>"; }).join("") + "</tr>";
        t += rows.map(function (r) {
          return "<tr>" + r.map(function (c) { return "<td style=\"padding:6px 10px;border-bottom:1px solid var(--line-soft)\">" + inline(esc(c)) + "</td>"; }).join("") + "</tr>";
        }).join("");
        t += "</table>";
        out.push(t);
        continue;
      }
      var trimmed = line.trim();
      if (!trimmed) { closeList(); i++; continue; }
      var h = trimmed.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeList(); out.push("<h" + h[1].length + ">" + inline(esc(h[2])) + "</h" + h[1].length + ">"); i++; continue; }
      if (/^>\s?/.test(trimmed)) { closeList(); out.push("<p style=\"border-left:3px solid var(--line);padding-left:12px;color:var(--ink-soft)\">" + inline(esc(trimmed.replace(/^>\s?/, ""))) + "</p>"); i++; continue; }
      var ul = trimmed.match(/^[-*]\s+(.*)$/);
      if (ul) {
        if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
        var ulInner = ul[1].replace(/^\[( |x)\]\s*/i, function (m, mark) {
          return mark.toLowerCase() === "x" ? "☑ " : "☐ ";
        });
        out.push("<li>" + inline(esc(ulInner)) + "</li>");
        i++; continue;
      }
      var ol = trimmed.match(/^\d+[.、]\s+(.*)$/);
      if (ol) {
        if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
        out.push("<li>" + inline(esc(ol[1])) + "</li>");
        i++; continue;
      }
      closeList();
      out.push("<p>" + inline(esc(trimmed)) + "</p>");
      i++;
    }
    closeList();
    if (codeBuf !== null) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
    return out.join("");
  }

  // ———————————————————————————— 基础 UI ————————————————————————————

  function toast(text) {
    var box = $("#toasts");
    var t = el("div", "toast", esc(text));
    box.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity 0.5s";
      t.style.opacity = "0";
      setTimeout(function () { t.remove(); }, 500);
    }, 2600);
  }

  function injectGrain() {
    // noise-grain 片段：feTurbulence 原生噪声 + steps() 抖动，绝不挡点击
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "grain-layer");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML =
      '<defs><filter id="lumen-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/></filter></defs>' +
      '<rect width="100%" height="100%" filter="url(#lumen-grain)"/>';
    document.body.appendChild(svg);
  }

  var currentTab = "chat";

  // 沿用默认头像 ID，让已有用户刷新后也能看到 Lumi 的新形象。
  var AVATARS = { "avatar-1": "assets/lumi-avatar.jpg", "avatar-2": "assets/avatar-2.jpg", "avatar-3": "assets/avatar-3.jpg" };
  function applyAvatar() {
    var s = store.state.settings;
    var src = AVATARS[s.avatarId] || AVATARS["avatar-1"];
    document.querySelectorAll("[data-agent-avatar]").forEach(function (avatar) {
      avatar.innerHTML = '<img src="' + src + '" alt="">';
    });
  }

  function switchTab(tab) {
    currentTab = tab;
    var panels = document.querySelectorAll(".panel");
    for (var i = 0; i < panels.length; i++) panels[i].hidden = true;
    var panel = $("#panel-" + tab);
    panel.hidden = false;
    // fade-slide-route：重挂动画类实现转场
    panel.classList.remove("route-enter");
    void panel.offsetWidth; // 强制回流，确保动画重新触发
    panel.classList.add("route-enter");
    var navs = document.querySelectorAll(".nav-btn, .tab-btn");
    for (var j = 0; j < navs.length; j++) {
      navs[j].classList.toggle("active", navs[j].getAttribute("data-tab") === tab);
    }
    $("#btn-settings").classList.toggle("active", false);
    // 每次切页刷新对应内容（后台任务可能已更新数据）
    if (tab === "feed") renderFeed();
    if (tab === "ideas") renderIdeas();
    if (tab === "goals") renderGoals();
    if (tab === "files") renderFiles();
    if (tab === "skills") renderSkills();
    if (tab === "memory") renderMemories();
    if (tab === "computer") {
      renderVm();
      // 计算机页驻留期间轮询桌面虚拟机（离开即停，不空耗）
      if (vmDeskTimer) clearInterval(vmDeskTimer);
      vmDeskTimer = setInterval(function () {
        if (currentTab === "computer") refreshVmDesktop();
        else { clearInterval(vmDeskTimer); vmDeskTimer = null; }
      }, 2500);
    } else if (vmDeskTimer) {
      clearInterval(vmDeskTimer);
      vmDeskTimer = null;
    }
  }

  function updateIdentity() {
    var name = store.state.settings.agentName || "Lumi";
    $("#agent-name").textContent = name;
    $("#input").placeholder = "交给 " + name + " 去做 —— 比如「帮我查一下周五去京都的航班」";
    applyAvatar();
  }

  function updateModelChip() {
    var cur = window.LumenAI.current();
    var backend = window.LumenContinuity && window.LumenContinuity.model;
    $("#model-chip").textContent = backend && backend.ready && store.state.settings.serverTasks !== false ? (backend.model + " · 后台 ▾") : cur ? (cur.model + " · " + cur.name.split(" ")[0] + " ▾") : "演示模式 ▾";
  }

  function updateStatus() {
    var n = window.LumenAgent.running + (window.LumenContinuity ? window.LumenContinuity.running : 0);
    var statusEl = $("#agent-status");
    var wrap = statusEl.closest(".agent-status");
    if (n > 0) {
      statusEl.textContent = "正在处理 " + n + " 个任务";
      wrap.classList.add("working");
      $("#agent-avatar").classList.add("working");
      $("#btn-stop").hidden = false;
    } else {
      statusEl.textContent = "随时待命";
      wrap.classList.remove("working");
      $("#agent-avatar").classList.remove("working");
      $("#btn-stop").hidden = true;
    }
    var badgeChat = $("#badge-chat");
    if (n > 0) { badgeChat.hidden = false; badgeChat.textContent = n; } else { badgeChat.hidden = true; }
    updateModelChip();
  }

  function updateBadges() {
    var bg = $("#badge-goals"), bf = $("#badge-files"), bm = $("#badge-memory");
    if (store.state.goals.length) { bg.hidden = false; bg.textContent = store.state.goals.length; } else { bg.hidden = true; }
    if (store.state.files.length) { bf.hidden = false; bf.textContent = store.state.files.length; } else { bf.hidden = true; }
    if (store.state.memories.length) { bm.hidden = false; bm.textContent = store.state.memories.length; } else { bm.hidden = true; }
  }

  // ———————————————————————————— 聊天渲染 ————————————————————————————

  var msgDom = {}; // id -> 元素

  function nearBottom() {
    var sc = $("#chat-scroll");
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
  }
  function scrollBottom(force) {
    var sc = $("#chat-scroll");
    if (force || nearBottom()) sc.scrollTop = sc.scrollHeight;
  }

  function welcomeNode() {
    var name = store.state.settings.agentName || "Lumi";
    var wrap = el("div", "welcome");
    var art = el("div", "welcome-art");
    // 欢迎画：莫奈真迹 + ken-burns 呼吸缓放（reduced-motion 下定格）
    var img = el("img");
    img.src = "assets/monet-welcome.jpg";
    img.alt = "莫奈《睡莲》";
    art.appendChild(img);
    wrap.appendChild(art);
    var h1 = el("h1");
    var title = "让光为你做事";
    // per-char-reveal：CSS 变量 --i 驱动逐字 stagger，掉帧也不「卡字」
    for (var i = 0; i < title.length; i++) {
      var s = el("span", "pr-char", esc(title[i]));
      s.style.setProperty("--i", i);
      h1.appendChild(s);
    }
    wrap.appendChild(h1);
    wrap.appendChild(el("p", "welcome-sub",
      esc(name) + " 是你的私人 AI 代理 —— 它不只回答问题，还替你把事情办成。"));
    var chips = el("div", "welcome-chips");
    [["✈️ 帮我查周五去京都的航班", "帮我查一下周五去京都的航班，选性价比最高的"],
     ["🎨 给我画一幅睡莲", "给我画一幅莫奈风格的睡莲"],
     ["📮 帮我起草一封婉拒邮件", "帮我起草一封礼貌婉拒合作的邮件"]].forEach(function (pair) {
      var b = el("button", "chip", esc(pair[0]));
      b.type = "button";
      b.addEventListener("click", function () { send(pair[1]); });
      chips.appendChild(b);
    });
    wrap.appendChild(chips);
    // 先绘制初始态（模糊不可见），下一帧再触发入场过渡
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var chars = wrap.querySelectorAll(".pr-char");
        for (var k = 0; k < chars.length; k++) chars[k].classList.add("in");
      });
    });
    return wrap;
  }

  function stepIcon() { return el("i", "s-ico"); }

  function activityNode(m) {
    var box = el("div", "activity" + (m.state === "done" ? " done" : ""));
    var head = el("div", "activity-head");
    if (m.state === "running") {
      head.appendChild(el("i", "spin"));
      head.appendChild(el("span", "", esc(store.state.settings.agentName || "Lumi") + " 正在它的虚拟计算机上工作…"));
    } else if (m.state === "denied") {
      head.innerHTML = '<span class="stop-ico">⏹</span><span>任务已按你的指示停止</span>';
    } else if (m.state === "aborted") {
      head.innerHTML = '<span class="stop-ico">⏹</span><span>任务已中断</span>';
    } else if (m.state === "failed") {
      head.innerHTML = '<span class="stop-ico">!</span><span>任务失败 · 进度已保留，可在活动页继续</span>';
    } else if (m.state === "waiting") {
      head.innerHTML = '<span class="stop-ico">⏸</span><span>等待本人操作 · 可在计算机页查看</span>';
    } else {
      head.innerHTML = '<span class="ok-ico">✓</span><span>完成 · 全程已记录在审计日志</span>';
    }
    box.appendChild(head);

    // 正在浏览：显示虚拟浏览器小剧场
    var activeStep = null;
    for (var i = 0; i < (m.steps || []).length; i++) {
      if (m.steps[i].status === "active") { activeStep = m.steps[i]; break; }
    }
    if (activeStep && activeStep.type === "browse") {
      var vb = el("div", "vbrowser");
      vb.innerHTML =
        '<div class="vb-bar"><span class="vb-dots"><i></i><i></i><i></i></span>' +
        '<span class="vb-url">' + esc(activeStep.url || "lumen.browser") + "</span></div>" +
        (activeStep.vbTitle ? '<div class="vb-title">' + esc(activeStep.vbTitle) + "</div>" : "") +
        '<div class="vb-canvas"></div>';
      box.appendChild(vb);
    }

    var steps = el("div", "steps");
    (m.steps || []).forEach(function (s) {
      var row = el("div", "step " + (s.status || "pending"));
      row.appendChild(stepIcon());
      row.appendChild(el("span", "", esc(s.label)));
      steps.appendChild(row);
    });
    box.appendChild(steps);

    if (m.autoNote) {
      box.appendChild(el("div", "ap-result", "⚡ " + esc(m.autoNote)));
    }
    return box;
  }

  function approvalNode(m, decide) {
    var riskName = { purchase: "支付", book: "预订", send: "对外发送", action: "代理执行" }[m.risk] || "操作";
    var box = el("div", "approval" + (m.resolved ? " resolved" : ""));
    box.appendChild(el("div", "ap-risk", "⚠ 关键动作 · " + esc(riskName)));
    box.appendChild(el("div", "ap-title", esc(m.title)));
    box.appendChild(el("div", "ap-detail", esc(m.detail)));
    if (!m.resolved) {
      var actions = el("div", "ap-actions");
      var once = el("button", "chip allow", "允许一次");
      var always = el("button", "chip allow", "总是允许");
      var deny = el("button", "chip deny", "拒绝");
      once.type = always.type = deny.type = "button";
      once.addEventListener("click", function () { decide("once"); });
      always.addEventListener("click", function () { decide("always"); });
      deny.addEventListener("click", function () { decide("deny"); });
      actions.appendChild(once); actions.appendChild(always); actions.appendChild(deny);
      box.appendChild(actions);
    } else {
      var label = m.resolved === "deny" ? "🚫 你拒绝了此操作"
        : m.resolved === "always" ? "✅ 已批准 · 此类操作今后自动放行"
        : "✅ 已批准（仅此一次）";
      box.appendChild(el("div", "ap-result", esc(label)));
    }
    return box;
  }

  function messageNode(m) {
    var wrap = el("div", "msg " + (m.role === "user" ? "user" : "agent"));
    if (m.role === "user") {
      wrap.appendChild(el("div", "bubble", md(m.text)));
      return wrap;
    }
    if (m.role === "agent") {
      var avatar = el("div", "avatar small", $("#agent-avatar").innerHTML);
      var bubble = el("div", "bubble", md(m.text) || '<span style="opacity:.45">' + "…</span>");
      bubble.setAttribute("data-mid", m.id);
      wrap.appendChild(avatar);
      wrap.appendChild(bubble);
      return wrap;
    }
    // activity / approval：占位容器由外层填充
    var holder = el("div", "msg agent");
    holder.setAttribute("data-holder", m.id);
    return holder;
  }

  function renderHolderContent(m) {
    var holder = msgDom[m.id];
    if (!holder) return;
    holder.innerHTML = "";
    if (m.role === "activity") holder.appendChild(activityNode(m));
    else if (m.role === "approval") {
      // 审批决策通过闭包回传给 agent 的 Promise
      holder.appendChild(approvalNode(m, function (decision) {
        if (m.resolved) return;
        m.resolved = decision;
        store.save();
        renderHolderContent(m);
        resolveApproval(m.id, decision);
      }));
    }
  }

  // 审批决议回调登记表
  var approvalResolvers = {};
  function resolveApproval(id, decision) {
    var fn = approvalResolvers[id];
    if (fn) { delete approvalResolvers[id]; fn(decision); }
  }

  // 中断时把所有挂起中的审批卡自动拒绝（保持 UI 与引擎状态一致）
  function denyAllApprovals() {
    Object.keys(approvalResolvers).forEach(function (id) {
      var m = store.getMessage(id);
      if (m && !m.resolved) {
        m.resolved = "deny";
        store.save();
        if (msgDom[id]) renderHolderContent(m);
      }
      resolveApproval(id, "deny");
    });
  }

  function renderChat() {
    var list = $("#chat-list");
    list.innerHTML = "";
    msgDom = {};
    var conv = store.activeConversation();
    if (!conv.messages.length) {
      list.appendChild(welcomeNode());
      return;
    }
    conv.messages.forEach(function (m) {
      var node = messageNode(m);
      msgDom[m.id] = node;
      list.appendChild(node);
      if (m.role === "activity" || m.role === "approval") renderHolderContent(m);
    });
    scrollBottom(true);
  }

  // 流式渲染：rAF 节流，避免每个 delta 都重建 markdown
  var streamDirty = {};
  function streamRender(id) {
    if (streamDirty[id]) return;
    streamDirty[id] = true;
    requestAnimationFrame(function () {
      delete streamDirty[id];
      var m = liveMsg(id);
      var node = msgDom[id];
      if (!m || !node) return;
      var bubble = node.querySelector(".bubble");
      if (bubble) bubble.innerHTML = md(m.text) || '<span style="opacity:.45">…</span>';
      scrollBottom(false);
    });
  }

  // ———————————————————————————— 发送与 Agent 挂钩 ————————————————————————————

  function send(text) {
    text = (text || "").trim();
    var files = pendingFiles.splice(0, pendingFiles.length);
    renderAttachBar();
    if (!text && !files.length) return;

    var display = text + (files.length ? "\n\n" + files.map(function (f) { return "📎 " + f.name; }).join("  ") : "");
    var list = $("#chat-list");
    var w = list.querySelector(".welcome");
    if (w) w.remove();
    var m = store.addMessage({ role: "user", text: display });
    var node = messageNode(m);
    msgDom[m.id] = node;
    list.appendChild(node);
    scrollBottom(true);
    $("#input").value = "";
    try { localStorage.removeItem("lumen-draft"); } catch (e) {}
    autosize();

    var baseText = text || "（请查看我发来的附件）";
    function dispatch(modelText) {
      window.LumenAgent.runTask(modelText, hooks);
      if (currentTab !== "chat") switchTab("chat"); // 已在聊天页时不重放转场动画
    }

    if (!files.length) { dispatch(baseText); return; }

    // 附件：① 副本上传进虚拟工作区（代理与虚拟机都能用）
    //       ② 文本类（≤200KB）读出内容直接拼进模型可见文本——等读完再分发，绝不丢内容
    Promise.all(files.map(function (f) {
      var up = uploadFile(f).then(function (r) {
        if (r && r.ok) store.audit("聊天附件入工作区", f.name + " · " + fmtSize(f.size), "done");
        else toast("附件《" + f.name + "》上传失败：" + (r && r.error || ""));
      }).catch(function () { toast("附件《" + f.name + "》上传失败（服务桥离线？）"); });
      var ext = (f.name.split(".").pop() || "");
      var inline = (TEXT_EXT.test(ext) && f.size <= 200 * 1024)
        ? f.text().then(function (c) { return "【附件：" + f.name + "】\n" + String(c).slice(0, 6000); })
            .catch(function () { return "【附件：" + f.name + "（内容读取失败，已存入虚拟工作区）】"; })
        : Promise.resolve("【附件：" + f.name + "（" + fmtSize(f.size) + "，非文本或较大，已存入虚拟工作区——可让 Lumi 用虚拟计算机读取）】");
      return Promise.all([up, inline]).then(function (r) { return r[1]; });
    })).then(function (parts) {
      // 附件正文存到消息的独立字段：气泡保持干净，模型历史里能看到全文（agent.js 组装上下文时拼接）
      store.updateMessage(m.id, { attachText: parts.join("\n\n") });
      dispatch(baseText);
    });
  }

  // 活动中的消息对象登记表：任务运行期间用户切了新会话时，
  // store.getMessage（只查活跃会话）会失联，这里保住对象引用
  var liveMsgs = {};
  function liveMsg(id, fallbackObj) {
    if (fallbackObj) liveMsgs[id] = fallbackObj;
    return liveMsgs[id] || store.getMessage(id);
  }

  var hooks = {
    activity: function (actMsg) {
      liveMsgs[actMsg.id] = actMsg;
      var node = messageNode(actMsg);
      msgDom[actMsg.id] = node;
      $("#chat-list").appendChild(node);
      renderHolderContent(actMsg);
      scrollBottom(true);
    },
    patchActivity: function (id, patch) {
      var m = liveMsg(id);
      if (!m) return;
      Object.assign(m, patch);
      store.save();
      renderHolderContent(m);
      scrollBottom(false);
    },
    requestApproval: function (payload) {
      return new Promise(function (resolve) {
        var m = store.addMessage({
          role: "approval",
          title: payload.title,
          detail: payload.detail,
          risk: payload.risk,
          resolved: "",
        });
        approvalResolvers[m.id] = resolve;
        var node = messageNode(m);
        msgDom[m.id] = node;
        $("#chat-list").appendChild(node);
        renderHolderContent(m);
        scrollBottom(true);
      });
    },
    // streamStart 可传消息对象（跨会话安全）或裸 id
    streamStart: function (objOrId) {
      var m = objOrId && typeof objOrId === "object" ? objOrId : store.getMessage(objOrId);
      if (!m) return;
      liveMsgs[m.id] = m;
      var node = messageNode(m);
      msgDom[m.id] = node;
      $("#chat-list").appendChild(node);
      scrollBottom(true);
    },
    upsertReply: function (m) {
      liveMsgs[m.id] = m;
      if (!msgDom[m.id]) hooks.streamStart(m);
      hooks.streamEnd(m.id);
    },
    streamDelta: function (id, chunk) {
      var m = liveMsg(id);
      if (m) { m.text = (m.text || "") + chunk; }
      streamRender(id);
    },
    streamEnd: function (id) {
      var m = liveMsg(id);
      var node = msgDom[id];
      if (m && node) {
        var bubble = node.querySelector(".bubble");
        if (bubble) bubble.innerHTML = md(m.text);
        // 语音模式输出侧：朗读回复（可在设置开关）
        if (store.state.settings.speakReplies && m.role === "agent" && m.text && window.speechSynthesis) {
          try {
            speechSynthesis.cancel();
            var utter = new SpeechSynthesisUtterance(
              String(m.text).replace(/[#*`>|\[\]()]/g, "").replace(/\s+/g, " ").slice(0, 400));
            utter.lang = "zh-CN";
            utter.rate = store.state.settings.tone === "pro" ? 1.1 : 0.95;
            speechSynthesis.speak(utter);
          } catch (e) { /* 不可用则静默 */ }
        }
      }
      scrollBottom(false);
    },
    onRunningChange: function () { updateStatus(); },
    refresh: function (tabs) {
      updateBadges();
      if (tabs && tabs.indexOf && tabs.indexOf("feed") !== -1 && currentTab === "feed") renderFeed();
      if (tabs && tabs.indexOf && tabs.indexOf("goals") !== -1 && currentTab === "goals") renderGoals();
      if (tabs && tabs.indexOf && tabs.indexOf("files") !== -1 && currentTab === "files") renderFiles();
      if (tabs && tabs.indexOf && tabs.indexOf("memory") !== -1 && currentTab === "memory") renderMemories();
    },
    toast: toast,
  };

  // ———————————————————————————— 输入框 ————————————————————————————

  function autosize() {
    var ta = $("#input");
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 132) + "px";
  }

  // —— 聊天附件：文件随消息进虚拟工作区；文本类同时把内容喂给模型 ——
  var pendingFiles = [];
  var TEXT_EXT = /^(txt|md|markdown|json|csv|tsv|log|xml|yml|yaml|html?|js|mjs|css|py|sh|java|c|h|cpp|go|rs|ts|tsx|jsx|sql|ini|conf|env|toml)$/i;
  var attachInput = null;

  function renderAttachBar() {
    var bar = $("#attach-bar");
    if (!pendingFiles.length) { bar.hidden = true; bar.innerHTML = ""; return; }
    bar.hidden = false;
    bar.innerHTML = "";
    pendingFiles.forEach(function (f, i) {
      var chip = el("span", "attach-chip");
      chip.innerHTML = "📎 " + esc(f.name) + ' <i style="opacity:.6;font-style:normal">' + fmtSize(f.size) + "</i>";
      var x = el("b", "", "×");
      x.style.cssText = "cursor:pointer;margin-left:6px;font-weight:700";
      x.addEventListener("click", function () { pendingFiles.splice(i, 1); renderAttachBar(); });
      chip.appendChild(x);
      bar.appendChild(chip);
    });
  }

  function addFiles(files) {
    var list = [].slice.call(files || []);
    if (!list.length) return;
    list = list.slice(0, 3 - pendingFiles.length);
    list.forEach(function (f) {
      if (f.size > 20 * 1024 * 1024) { toast("《" + f.name + "》超过 20MB，跳过"); return; }
      pendingFiles.push(f);
    });
    renderAttachBar();
    toast(pendingFiles.length + " 个附件就绪（发送时自动存入虚拟工作区）");
  }

  function uploadFile(file) {
    return file.arrayBuffer().then(function (buf) {
      return fetch(bridgeBase() + "/vm/file/upload?name=" + encodeURIComponent(file.name), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      }).then(function (r) { return r.json(); });
    });
  }

  function bindComposer() {
    var ta = $("#input");
    // 附件按钮（📎）+ 隐藏文件选择框 + 附件展示条
    var composer = document.querySelector(".composer");
    attachInput = document.createElement("input");
    attachInput.type = "file";
    attachInput.multiple = true;
    attachInput.hidden = true;
    attachInput.addEventListener("change", function () {
      addFiles(attachInput.files);
      attachInput.value = "";
    });
    var attachBtn = document.createElement("button");
    attachBtn.type = "button";
    attachBtn.className = "icon-btn";
    attachBtn.title = "附加文件（也可直接拖进聊天区）";
    attachBtn.innerHTML = '<svg viewBox="0 0 24 24" class="ico"><path d="M21 12.5l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8L13 4.9a3.7 3.7 0 0 1 5.2 5.2l-8.3 8.3a1.8 1.8 0 0 1-2.6-2.6l7.6-7.6"/></svg>';
    attachBtn.addEventListener("click", function () { attachInput.click(); });
    composer.insertBefore(attachBtn, ta.nextSibling); // 在输入框后、麦克风前
    composer.appendChild(attachInput);
    var bar = document.createElement("div");
    bar.id = "attach-bar";
    bar.hidden = true;
    document.querySelector(".composer-wrap").insertBefore(bar, composer);
    // 拖拽上传：整个聊天区都接
    var dropZone = document.querySelector("#panel-chat");
    dropZone.addEventListener("dragover", function (e) { e.preventDefault(); });
    dropZone.addEventListener("drop", function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    // 草稿持久化：页面重载（如后台更新）不再吞掉正在输入的内容
    try { ta.value = localStorage.getItem("lumen-draft") || ""; if (ta.value) autosize(); } catch (e) {}
    ta.addEventListener("input", function () {
      autosize();
      try { localStorage.setItem("lumen-draft", ta.value); } catch (e) {}
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(ta.value);
      }
    });
    $("#btn-send").addEventListener("click", function () { send(ta.value); });
    // 语音输入（Web Speech API；浏览器不支持则按钮保持隐藏）
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      var micBtn = $("#btn-mic");
      micBtn.hidden = false;
      var recognizing = false;
      micBtn.addEventListener("click", function () {
        if (recognizing) return;
        var rec = new SR();
        rec.lang = "zh-CN";
        rec.interimResults = true;
        rec.continuous = false;
        recognizing = true;
        micBtn.style.color = "var(--danger)";
        micBtn.title = "正在听…再点一次结束";
        rec.onresult = function (e) {
          var txt = "";
          for (var i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
          ta.value = txt;
          autosize();
        };
        var stop = function () { recognizing = false; micBtn.style.color = ""; micBtn.title = "语音输入"; ta.focus(); };
        rec.onend = stop;
        rec.onerror = stop;
        rec.start();
      });
    }
    $("#btn-stop").addEventListener("click", function () {
      // 先把挂起中的审批卡自动置为「拒绝」，否则任务会永远等在闸门处
      denyAllApprovals();
      window.LumenAgent.interruptAll();
      if (window.LumenContinuity) window.LumenContinuity.stop().catch(function (e) { toast(e.message); });
      toast("已中断当前任务 ⏹");
    });
    $("#btn-new-chat").addEventListener("click", function () {
      store.newConversation("新对话");
      renderChat();
      toast("开始了新对话");
    });
  }

  // ———————————————————————————— 模型气泡 ————————————————————————————

  function closePopover() { $("#model-popover").hidden = true; }

  function renderModelPopover() {
    var pop = $("#model-popover");
    pop.innerHTML = "";
    var cur = window.LumenAI.current();
    var backend = window.LumenContinuity && window.LumenContinuity.model;
    var backendActive = backend && backend.ready && store.state.settings.serverTasks !== false;
    var readyCount = 0;
    if (backend && backend.ready) {
      readyCount++;
      pop.appendChild(el("div", "pop-group", "后台聊天与计算机任务"));
      (backend.models || [{ model: backend.model, vision: backend.vision }]).forEach(function (choice) {
        var sel = backendActive && backend.model === choice.model;
        var item = el("button", "pop-item" + (sel ? " sel" : "")); item.type = "button";
        item.innerHTML = esc(choice.model) + '<span class="m-prov">' + (sel ? "● " : "") + (choice.vision ? "支持图片" : "文字") + "</span>";
        item.addEventListener("click", async function () {
          item.disabled = true;
          try { await window.LumenContinuity.selectModel(choice.model); updateModelChip(); closePopover(); toast("后台模型已切换到 " + choice.model); }
          catch (e) { toast("模型切换失败：" + e.message); }
          finally { item.disabled = false; }
        });
        pop.appendChild(item);
      });
    }

    var demo = el("button", "pop-item" + (cur || backendActive ? "" : " sel"));
    demo.type = "button";
    demo.innerHTML = "🪄 演示模式<span class=\"m-prov\">本地引擎</span>";
    demo.addEventListener("click", function () {
      store.state.settings.activeProvider = "";
      store.state.settings.activeModel = "";
      store.state.settings.serverTasks = false;
      store.save();
      updateModelChip();
      closePopover();
      toast("已切换到演示模式");
    });
    pop.appendChild(demo);

    Object.keys(window.LumenAI.PRESETS).forEach(function (pid) {
      if (!window.LumenAI.isReady(pid)) return;
      readyCount++;
      var cfg = window.LumenAI.providerConfig(pid);
      pop.appendChild(el("div", "pop-group", esc(cfg.name)));
      var models = cfg.models.slice();
      if (cfg.model && models.indexOf(cfg.model) === -1) models.unshift(cfg.model);
      models.forEach(function (mo) {
        var sel = !backendActive && cur && store.state.settings.activeProvider === pid && cur.model === mo;
        var item = el("button", "pop-item" + (sel ? " sel" : ""));
        item.type = "button";
        item.innerHTML = esc(mo) + "<span class=\"m-prov\">" + (sel ? "● 使用中" : /^glm[-_.]5[.-]3[-_.]flash$/i.test(mo) ? "支持图片" : "") + "</span>";
        item.addEventListener("click", async function () {
          item.disabled = true;
          try {
            if (backendActive) {
              if (pid === "localgw") await window.LumenContinuity.selectModel(mo);
              else await window.LumenContinuity.configureModel(Object.assign({}, cfg, { model: mo, imageModel: backend.imageModel }));
            }
            store.state.settings.activeProvider = pid;
            store.state.settings.activeModel = mo;
            store.save();
            updateModelChip();
            closePopover();
            toast("已切换到 " + mo);
          } catch (e) { toast("模型切换失败：" + e.message); }
          finally { item.disabled = false; }
        });
        pop.appendChild(item);
      });
    });

    if (!readyCount) {
      var empty = el("div", "pop-empty",
        "还没有已就绪的模型。<br>到「设置 → 模型接入」填入任意一家的 API Key 即可点亮真实模型（OpenAI / Claude / Gemini / GLM / DeepSeek / Kimi / 通义…）。");
      pop.appendChild(empty);
    }

    var gear = el("button", "pop-item");
    gear.type = "button";
    gear.innerHTML = "⚙ 模型设置…";
    gear.addEventListener("click", function () {
      closePopover();
      openSettings("providers");
    });
    pop.appendChild(gear);

    // 定位到 chip 下方
    var chip = $("#model-chip");
    var r = chip.getBoundingClientRect();
    pop.hidden = false;
    var pw = pop.offsetWidth;
    pop.style.left = Math.max(12, Math.min(window.innerWidth - pw - 12, r.left + r.width / 2 - pw / 2)) + "px";
    pop.style.top = (r.bottom + 10) + "px";
  }

  // 历史会话气泡：对话历史入口
  function renderHistoryPopover() {
    var pop = $("#model-popover");
    pop.innerHTML = "";
    pop.appendChild(el("div", "pop-group", "历史对话"));
    var convs = store.state.conversations;
    if (!convs.length) {
      pop.appendChild(el("div", "pop-empty", "还没有对话记录。"));
    }
    convs.slice(0, 12).forEach(function (c) {
      var active = c.id === store.state.activeConvId;
      var item = el("button", "pop-item" + (active ? " sel" : ""));
      item.type = "button";
      var when = new Date(c.createdAt);
      var timeStr = (when.getMonth() + 1) + "月" + when.getDate() + "日 " +
        String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0");
      item.innerHTML = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.title) + '</span><span class="m-prov">' + timeStr + "</span>";
      item.addEventListener("click", function () {
        store.state.activeConvId = c.id;
        store.save();
        closePopover();
        renderChat();
      });
      pop.appendChild(item);
    });
    var newBtn = el("button", "pop-item", "＋ 新对话");
    newBtn.type = "button";
    newBtn.addEventListener("click", function () {
      closePopover();
      store.newConversation("新对话");
      renderChat();
    });
    pop.appendChild(newBtn);

    var anchor = $("#btn-history");
    var r = anchor.getBoundingClientRect();
    pop.hidden = false;
    var pw = pop.offsetWidth;
    pop.style.left = Math.max(12, Math.min(window.innerWidth - pw - 12, r.left + r.width / 2 - pw / 2)) + "px";
    pop.style.top = (r.bottom + 10) + "px";
  }

  // ———————————————————————————— 技能库（本地服务桥提供）————————————————————————————

  // 服务桥基址：空串表示同源（合法，须原样保留；仅未探测过才回退 8787）
  function bridgeBase() {
    var b = window.LumenBridgeBase;
    return (b === undefined || b === null) ? "http://127.0.0.1:8787" : b;
  }

  // —— 桌面虚拟机（LumenBox Desktop）：agent.js 选路依据 + 计算机页数据源 ——
  window.LumenDesktop = { available: false };

  function desktopApi(path, method, body) {
    return fetch(bridgeBase() + path, {
      method: method || "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  // —— 版本与更新（有新版本只提示；一键更新必须用户点击，绝不静默执行） ——
  var updateState = { inflight: null, data: null };

  function renderSideVersion() {
    var btn = document.querySelector("#side-ver");
    if (!btn) return;
    var d = updateState.data;
    if (!d || !d.local) {
      btn.textContent = "v…";
      btn.className = "side-ver";
      btn.title = "检查版本中…";
      return;
    }
    var v = d.local.version || "?";
    if (d.restartRequired) {
      btn.textContent = "v" + v + " · 待重启";
      btn.className = "side-ver up";
      btn.title = "代码已更新，但服务仍在运行 v" + (d.runtime && d.runtime.version || "?") + "；点击查看重启说明";
    } else if (d.updateAvailable) {
      var n = d.behind || (d.commits || []).length;
      btn.textContent = "✨ v" + v + " · 有新版（+" + n + "）";
      btn.className = "side-ver up";
      btn.title = "落后 " + n + " 个提交，点击查看并一键更新";
    } else {
      btn.textContent = "v" + v + (d.local.sha ? " · " + d.local.sha.slice(0, 7) : "");
      btn.className = "side-ver";
      btn.title = d.checked === false ? "更新检查未完成（点击查看详情）" : "已是最新版本（点击查看更新详情）";
    }
  }

  function checkForUpdates(silent) {
    if (updateState.inflight) return updateState.inflight; // 并发调用共享同一次检查
    var p = (function waitForBridge() { // 页面刚加载时桥可能还没探测完（基址还是回退值），先等它
      if (window.LumenBridgeBase === "") return Promise.resolve();
      return new Promise(function (resolve) {
        var n = 0;
        var timer = setInterval(function () {
          if (window.LumenBridgeBase === "" || ++n > 20) { clearInterval(timer); resolve(); }
        }, 500);
      });
    })().then(function () { return fetch(bridgeBase() + "/update/check", { cache: "no-store" }); })
      .then(function (r) { if (!r.ok) throw new Error("服务桥未返回更新信息"); return r.json(); })
      .then(function (d) {
        if (!d || d.ok === false) throw new Error("更新检查未完成");
        updateState.data = d;
        renderSideVersion();
        if (!silent && d && d.ok !== false) {
          if (d.restartRequired) {
            toast("代码已是 v" + d.local.version + "，请重启服务桥加载新版");
          } else if (d.checked === false) {
            toast("更新检查未完成，暂时无法确认远端版本");
          } else if (d.updateAvailable) {
            var n = d.behind || (d.commits || []).length;
            toast("✨ 有新版本（落后 " + n + " 个提交）：设置 → 更新 可一键更新");
          } else toast("已是最新版本 ✓");
        }
        return d;
      })
      .catch(function () {
        updateState.data = Object.assign({}, updateState.data || {}, { checked: false, updateAvailable: null, note: "无法取得更新信息，请检查服务桥连接。" });
        renderSideVersion();
        if (!silent) toast("检查更新失败（服务桥离线？）");
        return updateState.data;
      });
    updateState.inflight = p.then(function (d) { updateState.inflight = null; return d; }, function (e) { updateState.inflight = null; throw e; });
    return updateState.inflight;
  }

  function applyUpdate() {
    var d = updateState.data || {};
    var summary = (d.commits || []).slice(0, 8).map(function (c, i) { return (i + 1) + ". " + c; }).join("\n");
    if (!window.confirm("立即更新？将执行 git pull --ff-only 获取最新版本，更新完成后需要重启服务桥。\n\n本次更新内容：\n" + (summary || "（无详细列表）"))) return;
    toast("正在拉取最新版本…");
    fetch(bridgeBase() + "/update/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) {
          store.audit("一键更新", "已更新到 " + res.nowAt, "done");
          openDoc("更新完成 🎉", res.note);
          toast(res.restartRequired === false ? "代码和当前服务均已是这一版本" : "代码已更新，请重启服务桥后刷新页面");
        } else {
          store.audit("一键更新被拒", String(res && res.error || "").slice(0, 80), "info");
          openDoc("更新未执行", (res && res.error || "未知原因") +
            ((res && res.dirty) ? "\n\n本地改动文件（示例）：\n" + res.dirty.join("\n") : "") +
            "\n\n可手动执行：git stash && git pull --ff-only origin main");
        }
        checkForUpdates(true);
      })
      .catch(function () { toast("更新请求失败（服务桥离线？）"); });
  }

  function syncRulesToBridge() {
    desktopApi("/rules", "POST", { rules: store.state.settings.rules || [] }).catch(function () {});
  }

  function probeDesktop() {
    desktopApi("/vm/desktop/status").then(function (st) {
      if (st && st.ok !== false) {
        window.LumenDesktop.available = !!st.daemon;
        window.LumenDesktop.imageReady = !!st.imageReady;
      }
    }).catch(function () {});
  }

  var skillsData = { online: false, list: [], contents: {} };
  window.LumenSkills = skillsData; // agent.js 的系统提示词从这里读

  function skillEnabled(id) {
    return store.state.settings.skills[id] !== false; // 缺省启用
  }

  function fetchSkillContent(id) {
    if (skillsData.contents[id]) return Promise.resolve(skillsData.contents[id]);
    var base = bridgeBase();
    return fetch(base + "/skills/" + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        skillsData.contents[id] = d.content || "";
        return d.content || "";
      });
  }

  function loadSkills() {
    var i = 0;
    function attempt() {
      if (i >= BRIDGE_CANDIDATES.length) {
        skillsData.online = false;
        return Promise.resolve();
      }
      var base = BRIDGE_CANDIDATES[i++];
      return fetch(base + "/skills")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          skillsData.online = true;
          skillsData.list = d.skills || [];
          window.LumenBridgeBase = base; // 探测成功，QCU 等后续调用走同一基址
          probeDesktop(); // 顺带探测桌面虚拟机（Docker）可用性，供 agent.js 选路
          checkForUpdates(true).then(function () { // 静默检查更新；有新版本才提醒，绝不自动更新
            renderSideVersion();
            var d = updateState.data;
            if (d && d.restartRequired) {
              toast("代码已更新到 v" + d.local.version + "，服务桥需要重启");
            } else if (d && d.updateAvailable) {
              toast("✨ 有新版本（落后 " + (d.behind || (d.commits || []).length) + " 个提交）：设置 → 更新 可一键更新");
            }
          });
          skillsData.list.forEach(function (s) {
            if (skillEnabled(s.id)) fetchSkillContent(s.id).catch(function () {});
          });
        })
        .catch(attempt); // 该基址不通就试下一个
    }
    return attempt();
  }

  var SKILL_ICONS = {
    "电脑操作": "🖥", "前端艺术": "🎨", "学习研究": "📐",
    "审计": "🔍", "交付评审": "⚖", "通用": "✨",
  };

  function renderSkills() {
    var box = $("#skills-list");
    box.innerHTML = "";
    if (!skillsData.online) {
      box.innerHTML =
        '<div class="skills-offline">⚠ 尚未连接本地服务桥——技能库、电脑操作（QCU）与本地模型网关都由它提供。<br>' +
        "启动方法：在终端运行 <code>cd Lumen && node server.js</code>，它会自动打开 <code>http://127.0.0.1:8787</code>（或手动访问该网址）；也可以从本页刷新重试。<br>" +
        "未启动服务桥时，Lumi 仍可使用演示模式与其他直连模型。</div>";
      return;
    }
    var groups = {};
    var order = [];
    skillsData.list.forEach(function (s) {
      if (!groups[s.category]) { groups[s.category] = []; order.push(s.category); }
      groups[s.category].push(s);
    });
    order.forEach(function (cat) {
      box.appendChild(el("div", "skill-group-title", esc(cat) + " · " + groups[cat].length));
      groups[cat].forEach(function (s) {
        var on = skillEnabled(s.id);
        var card = el("div", "skill-card" + (on ? "" : " off"));
        var icon = el("div", "sk-icon", SKILL_ICONS[cat] || "✨");
        var body = el("div", "sk-body");
        body.appendChild(el("div", "sk-name", esc(s.name)));
        var tags = el("div", "sk-tags");
        tags.appendChild(el("span", "sk-tag", s.exec ? "可执行" : "知识型"));
        if (s.exec) tags.appendChild(el("span", "sk-tag exec", "经 QCU 桥"));
        body.appendChild(tags);
        body.appendChild(el("div", "sk-desc", esc(s.desc || "")));
        var actions = el("div", "sk-actions");
        var toggle = el("button", "chip" + (on ? " on" : ""), on ? "已启用" : "已停用");
        toggle.type = "button";
        toggle.addEventListener("click", function () {
          store.state.settings.skills[s.id] = !on;
          store.save();
          renderSkills();
          if (!on) fetchSkillContent(s.id).catch(function () {});
          toast(on ? "已停用「" + s.name + "」" : "已启用「" + s.name + "」，Lumi 将在相关任务中运用它");
        });
        var view = el("button", "chip", "查看说明");
        view.type = "button";
        view.addEventListener("click", function () {
          fetchSkillContent(s.id).then(function (content) {
            openDoc("技能 · " + s.name, content || "（无说明文档）");
          }).catch(function () {
            toast("读取技能说明失败");
          });
        });
        actions.appendChild(toggle);
        actions.appendChild(view);
        card.appendChild(icon);
        card.appendChild(body);
        card.appendChild(actions);
        box.appendChild(card);
      });
    });
    if (!skillsData.list.length) {
      box.innerHTML = '<div class="skills-offline">服务桥在线，但 skills/ 目录里还没有技能。</div>';
    }
  }

  // ———————————————————————————— 虚拟计算机（LumenBox）面板 ————————————————————————————

  function vmApi(tool, op, args, shellEnabled) {
    var base = bridgeBase();
    return fetch(base + "/vm/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: tool, op: op, args: args || {}, shellEnabled: !!shellEnabled }),
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  function vmState() {
    var base = bridgeBase();
    return fetch(base + "/vm/state").then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  function fmtSize(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }

  // —— 桌面虚拟机卡片：状态 + Live 画面 + 任务（轮询刷新，iframe 只建一次） ——
  var vmDeskTimer = null;
  var vmDeskNodes = null; // 稳定 DOM 引用：chip / statusLine / toolbar / live / tasks
  var vmDeskRefreshBusy = false;

  var DESK_STATE = {
    running: ["运行中", ""],
    starting: ["启动中…", "off"],
    building: ["构建镜像中…", "off"],
    stopped: ["已停止", "off"],
    nodocker: ["Docker 未运行", "off"],
    unavailable: ["虚拟机连接未恢复", "off"],
    unknown: ["未探测", "off"],
  };

  function renderVmDesktopCard(box) {
    var card = el("div", "vm-card vm-desk");
    var head = el("div", "vm-card-head", "🖥 桌面 · LumenBox Desktop");
    var chip = el("span", "vm-tag off", "未探测");
    head.appendChild(chip);
    card.appendChild(head);

    var statusLine = el("div", "vm-note", "正在探测 Docker 与容器状态…");
    card.appendChild(statusLine);

    var toolbar = el("div", "vm-toolbar");
    card.appendChild(toolbar);
    var appearanceBox = el("div", "vm-appearance");
    appearanceBox.hidden = true;
    card.appendChild(appearanceBox);

    var liveWrap = el("div", "vm-live");
    liveWrap.hidden = true;
    card.appendChild(liveWrap);

    var tasksBox = el("div", "vm-tasks");
    card.appendChild(tasksBox);

    card.insertAdjacentHTML("beforeend",
      '<div class="vm-note" style="margin-top:10px">在 Live 画面中接管后，可以使用底部 Dock 打开浏览器、Linux 终端、文件管理器与创作软件。Linux 的 Downloads 文件夹与下面的工作区共用文件，浏览器数据和外观保存在私有卷。接管期间 Lumi 会等待你归还控制权。</div>');

    box.appendChild(card);
    vmDeskNodes = { card: card, chip: chip, statusLine: statusLine, toolbar: toolbar, appearanceBox: appearanceBox, liveWrap: liveWrap, tasksBox: tasksBox };

    refreshVmDesktop(true);
  }

  function renderVmAppearance() {
    var box = vmDeskNodes && vmDeskNodes.appearanceBox;
    if (!box || box.dataset.loaded) return;
    box.dataset.loaded = "loading";
    desktopApi("/vm/desktop/appearance").then(function (data) {
      if (!vmDeskNodes || vmDeskNodes.appearanceBox !== box) return;
      if (!data || !data.ok) { delete box.dataset.loaded; return; }
      box.dataset.loaded = "ready";
      box.innerHTML = "";
      var details = document.createElement("details");
      function appearanceName(value) {
        var preset = (value.presets || []).find(function (p) { return p.id === value.preset; });
        return value.custom ? "自定义壁纸" : preset ? preset.name : "内置壁纸";
      }
      var summary = el("summary", "", "桌面外观 · " + appearanceName(data));
      details.appendChild(summary);
      var fields = el("div", "vm-appearance-fields");
      var preview = el("div", "vm-wallpaper-preview");
      preview.setAttribute("aria-hidden", "true");
      fields.appendChild(preview);
      var choices = el("div", "vm-appearance-choices");
      var label = el("label", "", "壁纸组合");
      var select = document.createElement("select");
      select.setAttribute("aria-label", "Linux 桌面壁纸组合");
      (data.presets || []).forEach(function (p) {
        var option = document.createElement("option");
        option.value = p.id; option.textContent = p.name; option.selected = data.preset === p.id;
        select.appendChild(option);
      });
      label.appendChild(select); choices.appendChild(label);
      var colorLabel = el("label", "", "标题栏与 Dock 强调色");
      var color = document.createElement("input");
      color.type = "color"; color.value = data.accent;
      color.setAttribute("aria-label", "标题栏与 Dock 强调色");
      colorLabel.appendChild(color); choices.appendChild(colorLabel);
      var note = el("div", "vm-note", "外观保存在 Linux 私有卷中，重启后保留。");
      var buttons = el("div", "vm-toolbar");
      function showPreview() {
        var preset = (data.presets || []).find(function (p) { return p.id === select.value; });
        if (preset) preview.style.background = "linear-gradient(140deg," + preset.colors.join(",") + ")";
        preview.style.borderColor = color.value;
      }
      select.addEventListener("change", function () {
        var preset = data.presets.find(function (p) { return p.id === select.value; });
        if (preset) color.value = preset.accent;
        showPreview();
      });
      color.addEventListener("input", showPreview);
      showPreview();
      function save(payload) {
        Array.from(choices.querySelectorAll("button,input,select")).forEach(function (n) { n.disabled = true; });
        note.textContent = "正在应用外观…";
        desktopApi("/vm/desktop/appearance", "POST", payload).then(function (r) {
          if (r && r.ok) {
            data = r; color.value = r.accent; select.value = r.preset;
            summary.textContent = "桌面外观 · " + appearanceName(r);
            note.textContent = "已保存，壁纸、标题栏和 Dock 已更新。";
            showPreview();
          } else note.textContent = "设置失败：" + String(r && r.error || "无法连接桌面");
        }).finally(function () {
          Array.from(choices.querySelectorAll("button,input,select")).forEach(function (n) { n.disabled = false; });
        });
      }
      function button(text, action) {
        var btn = el("button", "chip", text); btn.type = "button"; btn.addEventListener("click", action); buttons.appendChild(btn);
      }
      button("应用组合", function () { save({ preset: select.value, accent: color.value }); });
      button("仅改强调色", function () { save({ accent: color.value }); });
      var file = document.createElement("input");
      file.type = "file"; file.accept = "image/png,image/jpeg,image/svg+xml,.svg"; file.hidden = true;
      file.addEventListener("change", function () {
        var image = file.files && file.files[0];
        if (!image) return;
        if (image.size > 6 * 1024 * 1024) { toast("壁纸最大 6 MB"); file.value = ""; return; }
        var reader = new FileReader();
        reader.onload = function () {
          var mime = image.type || (/\.svg$/i.test(image.name) ? "image/svg+xml" : /\.png$/i.test(image.name) ? "image/png" : "image/jpeg");
          save({ accent: color.value, wallpaper: { mime: mime, data: String(reader.result).split(",")[1] } });
          file.value = "";
        };
        reader.onerror = function () { toast("无法读取壁纸文件"); file.value = ""; };
        reader.readAsDataURL(image);
      });
      choices.appendChild(file);
      button("上传壁纸", function () { file.click(); });
      button("恢复默认", function () { save({ reset: true }); });
      choices.appendChild(buttons); choices.appendChild(note);
      choices.appendChild(el("div", "vm-note", "PNG / JPEG / SVG，最大 6 MB。不同应用内部的配色由应用自己管理。"));
      fields.appendChild(choices); details.appendChild(fields); box.appendChild(details);
    });
  }

  function refreshVmDesktop(first) {
    if (!vmDeskNodes || vmDeskRefreshBusy) return;
    vmDeskRefreshBusy = true;
    desktopApi("/vm/desktop/status").then(function (st) {
      if (!vmDeskNodes) return;
      window.LumenDesktop.available = !!(st && st.daemon);
      window.LumenDesktop.imageReady = !!(st && st.imageReady);
      var state = st && st.error && !st.daemon ? "unavailable" : st && st.daemon ? (st.state || "stopped") : "nodocker";
      var pair = DESK_STATE[state] || DESK_STATE.unknown;
      vmDeskNodes.chip.textContent = pair[0];
      vmDeskNodes.chip.className = "vm-tag" + (pair[1] ? " " + pair[1] : "");

      var img = st && st.imageReady;
      vmDeskNodes.statusLine.innerHTML =
        "Docker：" + (st && st.daemon ? "✅ " + String(st.daemon).slice(0, 14) : st && st.error ? "⚠ 连接检查未通过" : "❌ 未运行（打开 Docker Desktop）") +
        " · 镜像：" + (img ? "✅ lumen-box" : "⏳ 未构建（首次启动会自动构建）") +
        (st && st.environment && st.environment.os ? " · " + esc(st.environment.os) : "") +
        (st && st.ports ? " · 端口 " + st.ports.http + "/" + st.ports.vnc : "") +
        (st && st.error ? " · " + esc(st.error.slice(0, 200)) : "");
      var themed = state === "running" && st.environment && st.environment.desktopVersion >= 2;
      vmDeskNodes.appearanceBox.hidden = !themed;
      if (themed) renderVmAppearance();
      else { vmDeskNodes.appearanceBox.innerHTML = ""; delete vmDeskNodes.appearanceBox.dataset.loaded; }

      // 工具栏（按状态重建；按钮少，整建无妨）
      var tb = vmDeskNodes.toolbar;
      tb.innerHTML = "";
      if (state === "running") {
        var stop = el("button", "chip", "停止虚拟机");
        stop.type = "button";
        stop.addEventListener("click", function () {
          toast("正在停止桌面虚拟机…");
          desktopApi("/vm/desktop/stop", "POST", {}).then(function () { refreshVmDesktop(); });
        });
        tb.appendChild(stop);
        if (st.upgradeAvailable) {
          var upgrade = el("button", "chip solid", "更新 Linux 桌面");
          upgrade.type = "button";
          upgrade.addEventListener("click", function () {
            upgrade.disabled = true;
            toast("正在更新 Linux 桌面，浏览器数据和工作区会保留…");
            desktopApi("/vm/desktop/start", "POST", {}).then(function (r) {
              toast(r && r.ok ? "Linux 桌面已更新" : "更新失败：" + String(r && r.error || ""));
              refreshVmDesktop();
            });
          });
          tb.appendChild(upgrade);
        }
      } else if (st && (st.daemon || state === "unavailable")) {
        var start = el("button", "chip solid", state === "building" || !img ? "构建并启动（首次较慢）" : "启动虚拟机");
        start.type = "button";
        start.addEventListener("click", function () {
          toast("正在启动 LumenBox Desktop…（首次构建镜像可能需要几分钟）");
          start.disabled = true;
          desktopApi("/vm/desktop/start", "POST", {}).then(function (r) {
            if (r && r.ok) toast("桌面虚拟机已启动 ✅");
            else toast("启动失败：" + String(r && r.error || "").slice(0, 80));
            refreshVmDesktop();
          });
        });
        tb.appendChild(start);
      }

      // Live 画面（iframe 只创建一次，避免 noVNC 反复重连）
      // 双模式：观看（默认，滚轮/点击穿透——页面正常滑）/ 接管（事件全部进虚拟机）
      if (st && st.state === "running" && st.novncUrl) {
        vmDeskNodes.liveWrap.hidden = false;
        if (!vmDeskNodes.liveWrap.querySelector("iframe")) {
          var bar = el("div", "vm-live-bar");
          var hint = el("span", "vm-live-hint", "");
          var modeBtn = el("button", "chip vm-live-mode", "");
          modeBtn.type = "button";
          function applyLiveMode(takeover) {
            vmDeskNodes.liveWrap.classList.toggle("watch", !takeover);
            modeBtn.textContent = takeover ? "🖱 接管中 · 点此退出" : "👀 观看模式 · 点我接管";
            modeBtn.classList.toggle("on", takeover);
            hint.textContent = takeover
              ? "鼠标键盘/滚轮已进入虚拟机（远程操作中）"
              : "观看模式：滚轮滑的是本页，点右侧按钮接管虚拟机";
            try { localStorage.setItem("lumen-live-takeover", takeover ? "1" : "0"); } catch (e) {}
          }
          modeBtn.addEventListener("click", function () {
            var takeover = vmDeskNodes.liveWrap.classList.contains("watch");
            modeBtn.disabled = true;
            desktopApi("/vm/desktop/control", "POST", { takeover: takeover }).then(function (r) {
              if (r && r.ok) applyLiveMode(r.takeover);
              else toast("接管失败：" + String(r && r.error || ""));
            }).finally(function () { modeBtn.disabled = false; });
          });
          var reBtn = el("button", "chip", "重连画面");
          reBtn.type = "button";
          reBtn.title = "画面黑屏/卡住时重连 noVNC";
          reBtn.addEventListener("click", function () {
            var f = vmDeskNodes.liveWrap.querySelector("iframe");
            if (f) f.src = f.src;
            toast("正在重连实时画面…");
          });
          bar.appendChild(hint);
          bar.appendChild(modeBtn);
          bar.appendChild(reBtn);
          vmDeskNodes.liveWrap.appendChild(bar);
          var frame = document.createElement("iframe");
          frame.src = st.novncUrl;
          frame.setAttribute("allow", "clipboard-read; clipboard-write");
          vmDeskNodes.liveWrap.appendChild(frame);
          applyLiveMode(!!st.takeover);
        } else {
          var existing = vmDeskNodes.liveWrap.querySelector("iframe");
          if (existing.src !== st.novncUrl) existing.src = st.novncUrl;
        }
      } else {
        vmDeskNodes.liveWrap.hidden = true;
      }

      // 任务列表
      return desktopApi("/vm/desktop/tasks").then(function (d) {
        if (!vmDeskNodes) return;
        var list = (d && d.tasks) || [];
        var box2 = vmDeskNodes.tasksBox;
        box2.innerHTML = "";
        if (!list.length) return;
        box2.appendChild(el("div", "vm-card-head", "📋 桌面任务 · " + list.length + "（服务端执行，关页不中断）"));
        list.slice(0, 5).forEach(function (t) {
          var row = el("div", "vm-task");
          var stChip = { running: "● 执行中", waiting_approval: "⚠ 待批准", waiting_user: "⏸ 等待本人操作", done: "✓ 完成", failed: "✗ 失败", stopped: "⏹ 已停止", queued: "…排队", paused: "⏸ 已暂停" }[t.status] || t.status;
          var head2 = el("div", "vm-task-head");
          head2.innerHTML = "<span class=\"st " + (t.status === "done" ? "ok" : t.status === "failed" ? "bad" : "") + "\">" + stChip + "</span>" +
            "<span class=\"goal\">" + esc(t.goal.slice(0, 46)) + "</span>" +
            "<span class=\"meta\">" + (t.steps || []).length + " 步 · 模型 " + (t.modelCalls || 0) + " 次</span>";
          row.appendChild(head2);
          var last = (t.steps || [])[(t.steps || []).length - 1];
          if (last) row.appendChild(el("div", "vm-task-step", esc("[" + (t.steps.length) + "] " + last.label)));
          if (t.pendingApproval) {
            var ap = el("div", "vm-approve");
            ap.innerHTML = "<b>⚠ " + esc(t.pendingApproval.title) + "</b><br>" + esc(String(t.pendingApproval.detail || "").slice(0, 220));
            var act = el("div", "vm-toolbar");
            var ok = el("button", "chip allow", "批准（发 10 分钟能力凭证）");
            ok.type = "button";
            ok.addEventListener("click", function () {
              desktopApi("/vm/desktop/tasks/" + t.id + "/approve", "POST", { decision: "allow" }).then(function () { refreshVmDesktop(); });
            });
            var no = el("button", "chip deny", "拒绝");
            no.type = "button";
            no.addEventListener("click", function () {
              desktopApi("/vm/desktop/tasks/" + t.id + "/approve", "POST", { decision: "deny" }).then(function () { refreshVmDesktop(); });
            });
            act.appendChild(ok); act.appendChild(no);
            ap.appendChild(act);
            row.appendChild(ap);
          } else if (["running", "waiting_approval", "queued", "paused", "failed", "waiting_user"].includes(t.status)) {
            var stopT = el("button", "chip", "停止任务");
            stopT.type = "button";
            stopT.style.marginTop = "6px";
            stopT.addEventListener("click", function () {
              desktopApi("/vm/desktop/tasks/" + t.id + "/stop", "POST", {}).then(function () { refreshVmDesktop(); });
            });
            row.appendChild(stopT);
            var resumable = ["paused", "failed", "waiting_user"].includes(t.status);
            var pauseT = el("button", "chip", resumable ? "▶ 继续原任务" : "⏸ 暂停");
            pauseT.type = "button";
            pauseT.style.margin = "6px 0 0 6px";
            pauseT.addEventListener("click", function () {
              var act = resumable ? "resume" : "pause";
              desktopApi("/vm/desktop/tasks/" + t.id + "/" + act, "POST", {}).then(function (r) {
                if (r && !r.error) toast(act === "pause" ? "已暂停（完成的动作保留，点继续接着跑）" : "已继续");
                else toast("操作失败：" + (r && r.error || ""));
                refreshVmDesktop();
              });
            });
            row.appendChild(pauseT);
          }
          if (t.shot) {
            var img2 = document.createElement("img");
            img2.src = bridgeBase() + "/vm/desktop/shot?f=" + encodeURIComponent(t.shot);
            img2.className = "vm-shot";
            img2.title = "最近一步的桌面截图";
            row.appendChild(img2);
          }
          var detail = el("button", "chip", "详情与审计");
          detail.type = "button";
          detail.style.marginTop = "6px";
          detail.addEventListener("click", function () {
            var lines = (t.steps || []).map(function (s, i) {
              return (i + 1) + ". [" + s.kind + "] " + s.label;
            }).join("\n");
            openDoc("桌面任务 · " + t.goal.slice(0, 24),
              "目标：" + t.goal + "\n状态：" + stChip + " · 模型 " + (t.modelCalls || 0) + " 次\n\n## 审计轨迹\n\n" + (lines || "（无）") +
              (t.summary ? "\n\n## 成果\n\n" + t.summary : "") +
              (t.noteFile ? "\n\n笔记已存入虚拟工作区：" + t.noteFile : ""));
          });
          row.appendChild(detail);
          box2.appendChild(row);
        });
      });
    }).catch(function (e) { toast("计算机状态读取失败：" + e.message); }).finally(function () { vmDeskRefreshBusy = false; });
  }

  // 工作区文件在线编辑（对齐 Muse「VM 内文件可编辑」：改完直接存回虚拟工作区）
  function editVmFile(name) {
    vmApi("files", "read", { name: name }).then(function (r) {
      if (!r || !r.ok) { toast("读取失败：" + (r && r.error || "")); return; }
      var title = document.querySelector("#viewer-title");
      var body = document.querySelector("#viewer-body");
      title.textContent = "编辑 · " + name;
      body.innerHTML = "";
      var ta = document.createElement("textarea");
      ta.value = r.content || "";
      ta.style.cssText = "width:100%;height:56vh;min-height:320px;border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.7;background:rgba(255,255,255,.9);color:var(--ink);resize:vertical";
      var bar = el("div", "vm-toolbar");
      var save = el("button", "chip allow", "保存回虚拟工作区");
      save.type = "button";
      save.addEventListener("click", function () {
        vmApi("files", "write", { name: name, content: ta.value }).then(function (w) {
          if (w && w.ok) {
            store.audit("编辑工作区文件", name, "done");
            toast("已保存 " + name);
            closeViewer();
            if (currentTab === "computer") renderVm();
          } else toast("保存失败：" + (w && w.error || ""));
        });
      });
      var cancel = el("button", "chip", "取消");
      cancel.type = "button";
      cancel.addEventListener("click", closeViewer);
      bar.appendChild(save);
      bar.appendChild(cancel);
      body.appendChild(ta);
      body.appendChild(bar);
      document.querySelector("#viewer-modal").hidden = false;
    });
  }

  function renderVm(loading) {
    var box = $("#vm-view");
    if (!box) return;
    if (loading) box.innerHTML = '<div class="vm-card"><div class="vm-empty">正在连接虚拟计算机…</div></div>';
    vmState().then(function (d) {
      box.innerHTML = "";
      renderVmDesktopCard(box); // 桌面虚拟机区（自带探测与轮询，独立于轻量虚拟浏览器）
      if (!d || !d.ok) {
        var off = el("div", "vm-card");
        off.appendChild(el("div", "vm-card-head", "🖥 虚拟计算机 · 离线"));
        off.insertAdjacentHTML("beforeend",
          '<div class="skills-offline">⚠ 尚未连接本地服务桥——虚拟计算机由它提供。<br>' +
          "启动方法：终端运行 <code>cd Lumen && node server.js</code> 后刷新本页。</div>");
        box.appendChild(off);
        return;
      }

      // —— 屏幕：当前页 ——
      var scr = el("div", "vm-card");
      var page = d.page;
      scr.appendChild(el("div", "vm-card-head", "🖥 屏幕 · 虚拟浏览器"));
      if (page) {
        var screen = el("div", "vm-screen");
        screen.innerHTML =
          '<div class="vb-bar"><span class="vb-dots"><i></i><i></i><i></i></span>' +
          '<span class="vb-url">' + esc(page.url) + "</span></div>" +
          '<div class="vm-page-body">' + esc(String(page.excerpt || "").slice(0, 1400) || "（正文为空）") + "</div>";
        if (page.links && page.links.length) {
          var links = el("div", "vm-links");
          page.links.slice(0, 10).forEach(function (l) {
            var row = el("div", "vm-link", '<span class="n">' + l.n + "</span>" + esc(l.title));
            row.title = l.url;
            row.addEventListener("click", function () {
              store.audit("虚拟计算机 · 手动浏览", l.url.slice(0, 80), "info");
              vmApi("browser", "open", { url: l.url }).then(function () { renderVm(); });
            });
            links.appendChild(row);
          });
          screen.appendChild(links);
        }
        scr.appendChild(screen);
        var tools = el("div", "vm-toolbar");
        var reopen = el("button", "chip", "重新读取");
        reopen.type = "button";
        reopen.addEventListener("click", function () {
          vmApi("browser", "read").then(function (r) {
            if (r && r.ok) openDoc("虚拟浏览器 · " + (r.page.title || ""), r.page.text || "（正文为空）");
            else toast("读取失败");
          });
        });
        var mine = el("button", "chip", "在我的浏览器打开");
        mine.type = "button";
        mine.addEventListener("click", function () {
          if (/^https?:/.test(page.url)) window.open(page.url, "_blank", "noopener");
          else toast("虚拟内页（搜索结果等）没有对应的外部网址");
        });
        tools.appendChild(reopen);
        tools.appendChild(mine);
        scr.appendChild(tools);
      } else {
        scr.appendChild(el("div", "vm-empty", "还没有打开任何页面。对 Lumi 说「上网查一下……」，它会在自己的虚拟计算机里浏览，不碰你的电脑。"));
      }
      box.appendChild(scr);

      // —— 浏览历史 ——
      if (d.history && d.history.length) {
        var hc = el("div", "vm-card");
        hc.appendChild(el("div", "vm-card-head", "🕘 浏览历史 · " + d.history.length));
        var hist = el("div", "vm-hist");
        d.history.forEach(function (h) {
          var row = el("div", "vm-hist-row");
          row.innerHTML = '<span class="t">' + new Date(h.t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + "</span>" +
            '<span class="u">' + esc(h.title || h.url) + "</span>";
          row.title = h.url;
          row.addEventListener("click", function () {
            if (!/^https?:/.test(h.url)) { toast("虚拟内页，重新检索即可"); return; }
            vmApi("browser", "open", { url: h.url }).then(function () { renderVm(); });
          });
          hist.appendChild(row);
        });
        hc.appendChild(hist);
        box.appendChild(hc);
      }

      // —— 工作区文件 ——
      var fc = el("div", "vm-card");
      fc.appendChild(el("div", "vm-card-head", "📁 工作区 · vm-home/" + (d.files.length ? " · " + d.files.length + " 个文件" : "")));
      if (d.files.length) {
        var fl = el("div", "vm-files");
        d.files.forEach(function (f) {
          var row = el("div", "vm-file-row");
          var nm = el("span", "nm", esc(f.name));
          nm.addEventListener("click", function () {
            vmApi("files", "read", { name: f.name }).then(function (r) {
              if (r && r.ok) openDoc("工作区 · " + f.name, r.content || "（空文件）");
              else toast("读取失败：" + (r && r.error || ""));
            });
          });
          row.appendChild(nm);
          row.appendChild(el("span", "meta", fmtSize(f.size)));
          var dl = el("button", "chip", "下载");
          dl.type = "button";
          dl.addEventListener("click", function () {
            var base = bridgeBase();
            window.open(base + "/vm/file/" + encodeURIComponent(f.name), "_blank");
          });
          var ed = el("button", "chip", "编辑");
          ed.type = "button";
          ed.addEventListener("click", function () { editVmFile(f.name); });
          var rm = el("button", "chip", "删除");
          rm.type = "button";
          rm.addEventListener("click", function () {
            vmApi("files", "rm", { name: f.name }).then(function () {
              store.audit("虚拟计算机 · 删除文件", f.name, "info");
              renderVm();
            });
          });
          row.appendChild(dl);
          row.appendChild(ed);
          row.appendChild(rm);
          fl.appendChild(row);
        });
        fc.appendChild(fl);
      } else {
        fc.appendChild(el("div", "vm-empty", "工作区是空的。Lumi 浏览后会把笔记存到这里（notes/）；虚拟机浏览器下载的文件也会落到这里。"));
      }
      // 上传：本地文件 → 虚拟工作区（对齐 Muse「用户可把文件放进 VM」）
      var upRow = el("div", "vm-toolbar");
      var upInput = document.createElement("input");
      upInput.type = "file";
      upInput.hidden = true;
      upInput.addEventListener("change", function () {
        var file = upInput.files && upInput.files[0];
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) { toast("文件超过 20MB"); return; }
        file.arrayBuffer().then(function (buf) {
          return fetch(bridgeBase() + "/vm/file/upload?name=" + encodeURIComponent(file.name), {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: buf,
          }).then(function (r) { return r.json(); });
        }).then(function (r) {
          if (r && r.ok) {
            store.audit("上传文件到虚拟工作区", file.name + " · " + fmtSize(file.size), "done");
            toast("已上传 " + file.name + "（代理和虚拟机都能用了）");
            renderVm();
          } else toast("上传失败：" + (r && r.error || ""));
        }).catch(function () { toast("上传失败（服务桥离线？）"); });
        upInput.value = "";
      });
      var upBtn = el("button", "chip solid", "⬆ 上传文件到虚拟机");
      upBtn.type = "button";
      upBtn.addEventListener("click", function () { upInput.click(); });
      upRow.appendChild(upBtn);
      upRow.appendChild(upInput);
      fc.appendChild(upRow);
      box.appendChild(fc);

      // —— 虚拟终端 ——
      var tc = el("div", "vm-card");
      var shellOn = !!store.state.settings.vmShell && d.shell.enabled;
      tc.appendChild(el("div", "vm-card-head", "⌨ 宿主工作区命令行（旧版）" +
        '<span class="vm-tag' + (shellOn ? "" : " off") + '">' + (shellOn ? "已开启" : (d.shell.enabled ? "未开启（设置里打开）" : "服务端已禁用")) + "</span>"));
      var term = el("div", "vm-terminal");
      if (shellOn) {
        var input = document.createElement("input");
        input.type = "text";
        input.placeholder = "在虚拟工作区执行一条命令（如 ls -la），回车运行";
        var runBtn = el("button", "chip solid", "运行");
        runBtn.type = "button";
        function runCmd() {
          var cmd = input.value.trim();
          if (!cmd) return;
          input.value = "";
          store.audit("虚拟计算机 · 终端", cmd.slice(0, 80), "info");
          vmApi("shell", "run", { cmd: cmd }, true).then(function (r) {
            renderVm();
            if (r && r.error) toast("终端执行失败：" + r.error);
          });
        }
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") runCmd(); });
        runBtn.addEventListener("click", runCmd);
        var inRow = el("div", "vm-term-input");
        inRow.appendChild(input);
        inRow.appendChild(runBtn);
        term.appendChild(inRow);
      }
      if (d.shell.log && d.shell.log.length) {
        var log = el("div", "vm-term-log");
        d.shell.log.forEach(function (l) {
          log.insertAdjacentHTML("beforeend",
            '<div class="cmd">$ ' + esc(l.cmd) + "</div>" +
            '<div class="code' + (l.code === 0 ? "0" : "X") + '">' + esc(String(l.out || "").trim().slice(0, 2000)) + " · " + l.ms + "ms</div>");
        });
        term.appendChild(log);
      } else if (!shellOn) {
        term.appendChild(el("div", "vm-empty", "此旧版命令行默认关闭，命令在服务桥主机运行。使用独立 Linux 终端时，请接管上方 Live 画面，再点击 Dock 的终端图标。"));
      }
      tc.appendChild(term);
      box.appendChild(tc);

      // —— 说明与清空 ——
      var nc = el("div", "vm-card");
      nc.appendChild(el("div", "vm-card-head", "🛡 隔离边界"));
      nc.insertAdjacentHTML("beforeend",
        '<div class="vm-note">Live 桌面、Dock 应用和 Linux 终端运行在独立容器中。容器的 <code>~/Downloads</code> 与服务桥的 <code>vm-home/</code> 共享产物文件；轻量网页阅读器在服务桥进程中运行。这里的旧版宿主命令行默认关闭。需要操作你的 Mac 应用时，请明确说「用我的电脑」。</div>');
      var clearBtn = el("button", "chip", "清空虚拟计算机（历史 + 工作区）");
      clearBtn.type = "button";
      clearBtn.style.marginTop = "10px";
      clearBtn.addEventListener("click", function () {
        if (!window.confirm("清空虚拟计算机的浏览历史与工作区全部文件？此操作不可恢复。")) return;
        vmApi("files", "clear").then(function () {
          store.audit("虚拟计算机 · 清空", "浏览历史与工作区", "info");
          toast("虚拟计算机已恢复初始状态");
          renderVm();
        });
      });
      nc.appendChild(clearBtn);
      box.appendChild(nc);
    });
  }

  // ———————————————————————————— 动态（Feed）————————————————————————————

  var INTERESTS = {
    ai:     { name: "AI 前沿", art: "art-ai" },
    travel: { name: "旅行", art: "art-travel" },
    art:    { name: "艺术", art: "art-art" },
    food:   { name: "美食", art: "art-food" },
    money:  { name: "理财", art: "art-money" },
    health: { name: "健康", art: "art-health" },
    tech:   { name: "科技", art: "art-tech" },
    life:   { name: "生活方式", art: "art-life" },
  };

  var FEED_STORIES = {
    ai: [
      { title: "本地小模型代理成为新趋势", sum: "在手机上跑通代理工作流的小模型本周再进化。要不要让 Lumi 每周一帮你汇总一期《我的 AI 周报》？", task: "每周一早上给我汇总一份上周的 AI 领域大事件简报" },
      { title: "多模型路由：省钱又聪明的做法", sum: "简单问题走小模型、难题走旗舰模型的做法正在流行。你可以在设置里接入多个模型随时切换。", task: "" },
    ],
    travel: [
      { title: "错峰机票窗口期到了", sum: "历史数据显示本月下旬出发的机票价格进入低位。把目的地告诉 Lumi，它可以持续帮你盯价格。", task: "帮我盯着去大阪的机票，降到 1500 以内提醒我" },
      { title: "免签目的地又添一个", sum: "说走就走的清单更长了一点。要不要让 Lumi 按你的假期长度排一个短途行程？", task: "" },
    ],
    art: [
      { title: "印象派特展巡展日程更新", sum: "莫奈《睡莲》系列真迹将开启新的巡展城市。喜欢的话，可以让 Lumi 帮你留意开票时间。", task: "帮我留意莫奈特展的开票时间，开票第一时间提醒我" },
      { title: "每天一幅画的练习法", sum: "15 分钟速涂比周末狂画 4 小时更容易坚持。要不要立个「每天一幅小画」的目标？", task: "帮我建立每天画 15 分钟小画的目标" },
    ],
    food: [
      { title: "本周菜市场时令榜单", sum: "当季食材新鲜又便宜。把你的冰箱存货告诉 Lumi，它能排出一周菜谱。", task: "根据我冰箱里的食材帮我排一周晚餐菜谱" },
      { title: "一锅出的懒人晚餐公式", sum: "蛋白质 + 根茎类 + 绿叶 + 一勺发酵调味，15 分钟开饭。", task: "" },
    ],
    money: [
      { title: "订阅服务年检提醒", sum: "平均每人有 3 项订阅处于「忘了在用」状态。让 Lumi 列出你的订阅并标出建议取消项。", task: "帮我梳理我的订阅服务，标出建议取消的" },
      { title: "零钱自动归集的小习惯", sum: "每天 10 元，一年是一次不错的短途旅行基金。要不要立个攒钱目标？", task: "帮我建立一个每天存 10 元的攒钱目标" },
    ],
    health: [
      { title: "久坐族的 90 分钟法则", sum: "每 90 分钟起身 3 分钟，专注度反而更高。Lumi 可以在你想工作的时段提醒你。", task: "工作日每 90 分钟提醒我起身活动一下" },
      { title: "睡前一小时的光线管理", sum: "把主灯换成暖光、屏幕调暗，入睡时间平均提前 22 分钟。", task: "" },
    ],
    tech: [
      { title: "让代理替你盯 PR 和工单", sum: "开发者们开始让个人代理汇总每日变更。接入模型后，这类例行汇总都可以交给 Lumi。", task: "每天下班前帮我汇总今天的工作要点" },
      { title: "本地优先的数据习惯", sum: "像 Lumen 一样把数据留在本机，正在成为新的默认选择。", task: "" },
    ],
    life: [
      { title: "周日晚上 20 分钟的「预演一周」", sum: "把下周三件大事过一遍，焦虑会显著下降。要不要现在试试？", task: "帮我做一次周日晚上的一周预演规划" },
      { title: "给重要的人的提醒", sum: "生日、纪念日、父母体检……让 Lumi 提前两周开始提醒你准备。", task: "帮我记住妈妈的生日，提前两周开始提醒我准备礼物" },
    ],
  };

  function briefLine() {
    var d = new Date();
    var lines = [
      "晨光是淡金色的，适合开始一件小事。",
      "水面很平，适合把杂念沉下去。",
      "今天的光线偏暖，重要的事放在上午。",
      "云走得慢，不必急，按自己的节奏来。",
      "暮色来之前，还有一整个下午可以用。",
    ];
    return lines[d.getDate() % lines.length];
  }

  function renderFeed() {
    var row = $("#feed-interests");
    row.innerHTML = "";
    Object.keys(INTERESTS).forEach(function (key) {
      var on = store.state.settings.interests.indexOf(key) !== -1;
      var b = el("button", "chip" + (on ? " on" : ""), esc(INTERESTS[key].name));
      b.type = "button";
      b.addEventListener("click", function () {
        var arr = store.state.settings.interests;
        var idx = arr.indexOf(key);
        if (idx === -1) arr.push(key); else arr.splice(idx, 1);
        store.save();
        renderFeed();
      });
      row.appendChild(b);
    });

    var list = $("#feed-list");
    list.innerHTML = "";

    // 今日简报（永远第一张）
    var d = new Date();
    var goals = store.state.goals;
    var modelOn = !!window.LumenAI.current();
    var goalLine = goals.length
      ? "你正在推进 " + goals.length + " 个目标，最近的「" + esc(goals[0].title) + "」已完成 " + store.goalProgress(goals[0]) + "%。"
      : "还没有进行中的目标 —— 和 Lumi 聊聊想坚持的事，它会帮你记下来。";
    var brief = el("div", "feed-card");
    brief.innerHTML =
      '<div class="fc-art"><div class="art-fill art-life"></div><span class="fc-tag">今日简报</span></div>' +
      '<div class="fc-body">' +
      '<div class="fc-title">' + d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月 " + d.getDate() + " 日 · " + esc(briefLine()) + "</div>" +
      '<div class="fc-sum">' + goalLine + "文件库里共有 " + store.state.files.length + " 份 Lumi 替你整理的成果。</div>" +
      '<div class="fc-actions"><button class="chip" type="button" data-task="结合今天的日期，联网检索后为我生成今日真实简报：我最该关注的三件事，每件附来源链接">联网生成真实简报</button>' +
      '<button class="chip" type="button" data-task="给我一个今天最值得做的三件事清单">本地排三件事</button></div>' +
      "</div>";
    list.appendChild(brief);

    // 兴趣卡片
    store.state.settings.interests.forEach(function (key) {
      var meta = INTERESTS[key];
      var stories = FEED_STORIES[key] || [];
      stories.forEach(function (st) {
        var card = el("div", "feed-card");
        card.innerHTML =
          '<div class="fc-art"><div class="art-fill ' + meta.art + '"></div><span class="fc-tag">' + esc(meta.name) + "</span></div>" +
          '<div class="fc-body">' +
          '<div class="fc-title">' + esc(st.title) + "</div>" +
          '<div class="fc-sum">' + esc(st.sum) + "</div>" +
          '<div class="fc-actions">' +
          (st.task ? '<button class="chip" type="button" data-task="' + esc(st.task) + '">交给 Lumi 去办</button>' : "") +
          "</div></div>";
        list.appendChild(card);
      });
    });

    // 后台监控命中卡（异步：24h 内有命中才插入）
    fetch(bridgeBase() + "/tasks")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var dayAgo = Date.now() - 24 * 3600 * 1000;
        var alerts = [];
        (d.tasks || []).forEach(function (t) {
          (t.hits || []).forEach(function (h) {
            if (h.t >= dayAgo) alerts.push({ q: t.query, s: h.summary, t: h.t, url: h.top && h.top[0] && h.top[0].url });
          });
        });
        if (!alerts.length || currentTab !== "feed") return;
        var hitCard = el("div", "feed-card");
        var a0 = alerts[0];
        hitCard.innerHTML =
          '<div class="fc-art"><div class="art-fill art-money"></div><span class="fc-tag">🔔 监控命中</span></div>' +
          '<div class="fc-body"><div class="fc-title">' + esc(a0.q) + "</div>" +
          '<div class="fc-sum">' + esc(a0.s) + "</div>" +
          '<div class="fc-actions"><button class="chip" type="button" data-goto-goals="1">查看全部监控</button></div></div>';
        hitCard.querySelector("[data-goto-goals]").addEventListener("click", function () { switchTab("goals"); });
        var first = list.querySelector(".feed-card");
        if (first) list.insertBefore(hitCard, first); else list.appendChild(hitCard);
      })
      .catch(function () { /* 服务桥离线时静默 */ });

    // 最近的成果回顾
    store.state.files.slice(0, 2).forEach(function (f) {      var card = el("div", "feed-card");
      var artHtml = f.kind === "art" && f.dataURL
        ? '<img src="' + f.dataURL + '" alt="">'
        : '<div class="art-fill art-ai"></div>';
      card.innerHTML =
        '<div class="fc-art">' + artHtml + '<span class="fc-tag">成果回顾</span></div>' +
        '<div class="fc-body"><div class="fc-title">' + esc(f.title) + "</div>" +
        '<div class="fc-sum">这是 Lumi 前几天为你生成的，点击「查看」可以在文件页打开它。</div>' +
        '<div class="fc-actions"><button class="chip" type="button" data-open-file="' + f.id + '">查看</button></div></div>';
      list.appendChild(card);
    });

    // 委托代理：事件委托统一处理（绑定一次，见 bindGlobal；重渲染不重复绑）
  }

  // ———————————————————————————— 记忆（可查看/编辑/遗忘）————————————————————————————

  var MEMORY_KIND_COLORS = { "偏好": "#7fae7a", "事实": "#3d6b8e", "关系": "#c98bb9", "习惯": "#e8b04b" };

  function renderMemories() {
    var list = $("#memory-list");
    list.innerHTML = "";
    var mems = store.state.memories;
    if (!mems.length) {
      list.innerHTML = '<div class="goal-empty">Lumi 还没记住关于你的事。<br>接入模型后正常对话，它会自动沉淀值得记住的偏好、事实、关系与习惯；<br>也可以点右上角手动记一条。</div>';
    }
    mems.forEach(function (m) {
      var card = el("div", "goal-card");
      var color = MEMORY_KIND_COLORS[m.kind] || "#3d6b8e";
      card.innerHTML =
        '<div class="goal-head"><span class="sk-tag" style="background:' + color + '22;color:' + color + '">' + esc(m.kind) + "</span>" +
        '<div class="goal-title" style="flex:1">' + esc(m.text) + "</div></div>" +
        '<div class="goal-meta"><span>' + (m.source === "manual" ? "✍️ 手动记录" : "🧠 从对话沉淀 · " + new Date(m.time).toLocaleDateString("zh-CN")) + "</span>" +
        '<span><button class="chip" type="button" data-mem-edit="' + m.id + '">编辑</button> ' +
        '<button class="chip" type="button" data-mem-del="' + m.id + '">遗忘</button></span></div>';
      list.appendChild(card);
    });
    list.addEventListener("click", function (e) {
      var ed = e.target.closest("[data-mem-edit]");
      var del = e.target.closest("[data-mem-del]");
      if (ed) {
        var mm = null;
        store.state.memories.forEach(function (x) { if (x.id === ed.getAttribute("data-mem-edit")) mm = x; });
        if (!mm) return;
        openForm("编辑记忆", [{ key: "text", label: "内容", placeholder: "" }], function (vals) {
          if (!vals.text) return "内容不能为空";
          store.updateMemory(mm.id, vals.text);
          renderMemories();
        }, { text: mm.text });
      } else if (del) {
        store.removeMemory(del.getAttribute("data-mem-del"));
        store.audit("遗忘记忆", "", "info");
        renderMemories();
        updateBadges();
      }
    }, { once: true });
    renderHsMemory();
  }

  // ———— Hindsight 深度记忆（可选）：语义检索 / 深度反思 / 记忆库管理 ————
  function renderHsMemory() {
    var box = $("#hs-memory-view");
    if (!box) return;
    box.innerHTML = "";
    desktopApi("/memory/hindsight/status").then(function (d) {
      if (!d || !d.ok) return;
      if (!d.enabled && !(d.api && d.api.reachable)) {
        box.innerHTML =
          '<div class="goal-card" style="margin-top:18px">' +
          '<div class="goal-head"><span class="sk-tag" style="background:#5b7f9d22;color:#5b7f9d">深度记忆</span>' +
          '<div class="goal-title" style="flex:1">Hindsight 长期记忆引擎（未启用）</div></div>' +
          '<div class="goal-meta"><span>给 Lumi 一个会学习的记忆库：对话自动沉淀为事实/经历/观察，回答前四路检索相关记忆（语义/关键词/图谱/时序）。开源 · 数据全在本地。</span></div>' +
          '<div class="goal-meta"><button class="chip" type="button" data-hs-goset="1">到设置开启 →</button></div></div>';
        var b2 = box.querySelector("[data-hs-goset]");
        if (b2) b2.addEventListener("click", function () { openSettings("hindsight"); });
        return;
      }
      var sec = el("div", "goal-card");
      sec.style.marginTop = "18px";
      var reach = d.api && d.api.reachable;
      sec.innerHTML =
        '<div class="goal-head"><span class="sk-tag" style="background:#5b7f9d22;color:#5b7f9d">深度记忆 · Hindsight</span>' +
        '<div class="goal-title" style="flex:1">' + (reach ? "运行中" : "已启用 · 服务未响应" + (d.busy ? "（启动中…）" : "")) +
        (d.version ? " · v" + esc(d.version) : "") + "</div></div>";
      var q = document.createElement("input");
      q.type = "text";
      q.placeholder = "从记忆里找点什么…（如：我最近让你记过什么？）";
      q.style.cssText = "flex:1;min-width:180px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13.5px;background:rgba(255,255,255,.8)";
      var btn = el("button", "chip", "语义检索");
      btn.type = "button";
      var rbtn = el("button", "chip", "深度反思");
      rbtn.type = "button";
      var row = el("div", "set-row");
      row.appendChild(q); row.appendChild(btn); row.appendChild(rbtn);
      sec.appendChild(row);
      var out = el("div");
      out.style.cssText = "margin-top:10px;font-size:13.5px;line-height:1.9";
      sec.appendChild(out);
      var total = el("div", "goal-meta", reach ? "读取中…" : "");
      sec.appendChild(total);
      var list2 = el("div", "goals-list");
      list2.style.marginTop = "8px";
      sec.appendChild(list2);
      box.appendChild(sec);

      function renderList() {
        if (!reach) { total.textContent = "服务未响应（到 设置 → 长期记忆引擎 查看原因或重启）"; return; }
        desktopApi("/memory/hindsight/memories?limit=50").then(function (m) {
          list2.innerHTML = "";
          if (!m || !m.ok) { total.textContent = "记忆列表暂不可用：" + String((m && m.error) || "").slice(0, 60); return; }
          var clearB = el("button", "chip", "清空记忆库");
          clearB.type = "button";
          clearB.style.marginLeft = "8px";
          clearB.addEventListener("click", function () {
            if (!window.confirm("清空 Hindsight 记忆库（bank " + d.bank + "）？此操作不可恢复。")) return;
            desktopApi("/memory/hindsight/reset", "POST").then(function (r2) {
              if (r2 && r2.ok) { store.audit("清空深度记忆库", "Hindsight bank " + d.bank, "info"); renderList(); }
              else toast("清空失败：" + ((r2 && r2.error) || ""));
            });
          });
          total.innerHTML = "";
          total.appendChild(document.createTextNode("记忆库共 " + m.total + " 条（Hindsight 自动从对话抽取，可在「记忆页」检索/遗忘）"));
          total.appendChild(clearB);
          (m.items || []).forEach(function (it) {
            var card = el("div", "goal-card");
            var when = it.mentionedAt ? new Date(it.mentionedAt).toLocaleDateString("zh-CN") : "";
            card.innerHTML =
              '<div class="goal-head"><span class="sk-tag" style="background:#5b7f9d22;color:#5b7f9d">' + esc(it.type || "记忆") + "</span>" +
              '<div class="goal-title" style="flex:1">' + esc(it.text) + "</div></div>" +
              '<div class="goal-meta"><span>🧠 ' + (when ? when + " · " : "") + "Hindsight</span>" +
              '<span><button class="chip" type="button" data-hs-del="' + esc(it.id) + '">遗忘</button></span></div>';
            card.querySelector("[data-hs-del]").addEventListener("click", function () {
              desktopApi("/memory/hindsight/forget", "POST", { id: it.id }).then(function (r3) {
                if (r3 && r3.ok) { store.audit("遗忘深度记忆", String(it.text).slice(0, 40), "info"); renderList(); }
                else toast("遗忘失败：" + ((r3 && r3.error) || ""));
              });
            });
            list2.appendChild(card);
          });
        });
      }
      renderList();

      function runSearch() {
        var query = q.value.trim();
        if (!query) { toast("先输入要检索的内容"); return; }
        out.textContent = "检索中…";
        desktopApi("/memory/hindsight/recall", "POST", { query: query }).then(function (r) {
          if (!r || !r.ok) { out.textContent = ""; toast("检索失败：" + ((r && r.error) || "服务未响应")); return; }
          var rs = (r.results || []).filter(function (x) { return x && x.text; });
          out.innerHTML = rs.length
            ? "召回 " + rs.length + " 条：<br>" + rs.map(function (x) { return "· [" + esc(x.type || "记忆") + "] " + esc(x.text); }).join("<br>")
            : "没有召回相关记忆（记忆库还空着？正常聊几轮就会有了）";
        });
      }
      btn.addEventListener("click", runSearch);
      q.addEventListener("keydown", function (e) { if (e.key === "Enter") runSearch(); });
      rbtn.addEventListener("click", function () {
        openForm("深度反思 · 基于记忆库回答", [
          { key: "query", label: "问题", placeholder: "比如：我这段时间都关注些什么？" },
        ], function (vals) {
          if (!vals.query) return "问题不能为空";
          out.textContent = "反思中…（Hindsight 会多步检索记忆后作答，稍等）";
          desktopApi("/memory/hindsight/reflect", "POST", { query: vals.query }).then(function (r) {
            if (!r || !r.ok) { out.textContent = ""; toast("反思失败：" + ((r && r.error) || "")); return; }
            out.innerHTML = "💡 深度反思：<br>" + md(r.text);
          });
        });
      });
    }).catch(function () { /* 服务桥离线：区块不渲染 */ });
  }

  function openAddMemory() {
    openForm("记一条", [
      { key: "text", label: "内容", placeholder: "比如：拿铁要燕麦奶、不加糖" },
      { key: "kind", label: "类型", placeholder: "偏好 / 事实 / 关系 / 习惯" },
    ], function (vals) {
      if (!vals.text) return "内容不能为空";
      var kind = ["偏好", "事实", "关系", "习惯"].indexOf(vals.kind) !== -1 ? vals.kind : "事实";
      store.addMemory(vals.text, kind, "manual");
      renderMemories();
      updateBadges();
      toast("已记住 🧠");
    });
  }

  // ———————————————————————————— 灵感 ————————————————————————————

  var IDEAS = [
    ["效率", "#3d6b8e", "把我的收件箱分成三类：要回、要看、要扔，并起草前五封回复", "整理收件箱"],
    ["效率", "#3d6b8e", "每天晚上 9 点，用三句话总结我今天做了什么、卡在哪、明天先做什么", "今日复盘"],
    ["效率", "#3d6b8e", "帮我对比三款笔记软件的导出与协作能力，给出适合我的选择", "工具选型"],
    ["生活", "#7fae7a", "根据我家现有的食材，排一份本周晚餐菜谱并列出采购清单", "一周菜谱"],
    ["生活", "#7fae7a", "帮我安排一次两天一夜的周边小旅行，预算 800 以内", "周末小旅行"],
    ["生活", "#7fae7a", "制定一个 21 天的早起计划，每天只前进 10 分钟", "早起计划"],
    ["创作", "#c98bb9", "给我画一幅晨雾中的睡莲", "即兴画作"],
    ["创作", "#c98bb9", "以「光」为主题写一首短诗，要有印象派的画面感", "写一首诗"],
    ["创作", "#c98bb9", "帮我把这段旅行经历改写成一篇小红书风格的短文", "改写文案"],
    ["学习", "#e8b04b", "帮我制定 30 天入门水彩的计划，每天不超过 20 分钟", "水彩计划"],
    ["学习", "#e8b04b", "用费曼学习法帮我理解一个我最近没搞懂的概念", "费曼讲解"],
    ["学习", "#e8b04b", "为我生成一份本周英语晨读清单，附难度标注", "晨读清单"],
    ["理财", "#6fa3c2", "梳理我的订阅服务，标出三个月没用过的", "订阅体检"],
    ["理财", "#6fa3c2", "帮我建一个「咖啡钱」攒钱目标，每天 15 元", "攒钱目标"],
    ["理财", "#6fa3c2", "对比一下我现在用的信用卡和市面上的主流卡，值不值得换", "卡片对比"],
  ];

  function renderIdeas() {
    var grid = $("#ideas-grid");
    grid.innerHTML = "";
    IDEAS.forEach(function (idea) {
      var card = el("button", "idea-card");
      card.type = "button";
      card.style.setProperty("--ic", idea[1]);
      card.innerHTML =
        '<div class="idea-cat">' + esc(idea[0]) + "</div>" +
        '<div class="idea-text">' + esc(idea[2]) + "</div>" +
        '<span class="idea-go">交给 Lumi →</span>';
      card.addEventListener("click", function () { send(idea[2]); });
      grid.appendChild(card);
    });
  }

  // ———————————————————————————— 目标 ————————————————————————————

  function renderGoals() {
    var list = $("#goals-list");
    list.innerHTML = "";
    if (!store.state.goals.length) {
      list.innerHTML = '<div class="goal-empty">还没有目标。<br>和 Lumi 说「我想坚持每天……」，它会自动帮你建立目标；<br>也可以点右上角「＋ 新目标」手动添加。</div>';
    }
    store.state.goals.forEach(function (g) {
      var pct = store.goalProgress(g);
      var card = el("div", "goal-card");
      card.innerHTML =
        '<div class="goal-head"><div class="goal-title">' + esc(g.title) + "</div>" +
        '<div class="goal-pct">' + pct + "%</div></div>" +
        '<div class="goal-bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="goal-steps"></div>' +
        '<div class="goal-meta"><span>' + (g.source === "conversation" ? "🎯 来自你们的对话" : "✍️ 手动创建") + "</span>" +
        '<button class="chip" type="button" data-del-goal="' + g.id + '">删除</button></div>';
      var stepsBox = card.querySelector(".goal-steps");
      g.steps.forEach(function (s, idx) {
        var row = el("div", "gstep" + (s.done ? " done" : ""));
        var chk = el("button", "check");
        chk.type = "button";
        chk.setAttribute("aria-label", s.text);
        chk.addEventListener("click", function () {
          store.toggleGoalStep(g.id, idx);
          store.audit(s.done ? "完成步骤" : "勾选步骤", g.title + " · " + s.text, "done");
          renderGoals();
          updateBadges();
        });
        row.appendChild(chk);
        row.appendChild(el("span", "", esc(s.text)));
        stepsBox.appendChild(row);
      });
      card.querySelector("[data-del-goal]").addEventListener("click", function () {
        store.removeGoal(g.id);
        store.audit("删除目标", g.title, "info");
        renderGoals();
        updateBadges();
      });
      list.appendChild(card);
    });

    // —— 后台监控任务区（关页面也继续跑）——
    var monHead = el("div", "skill-group-title", "后台监控 · 7×24（服务桥常驻，关闭页面不中断）");
    list.appendChild(monHead);
    var monBox = el("div");
    monBox.innerHTML = '<div class="goal-empty" style="padding:20px;color:var(--ink-faint)">读取中…</div>';
    list.appendChild(monBox);
    fetch(bridgeBase() + "/tasks")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        monBox.innerHTML = "";
        var tasks = d.tasks || [];
        if (!tasks.length) {
          monBox.innerHTML = '<div class="goal-empty" style="padding:24px">还没有监控任务。对 Lumi 说「帮我盯着……降价/开票/开放就提醒我」，它会注册一个常驻任务。</div>';
          return;
        }
        tasks.forEach(function (t) {
          var lastHit = t.hits && t.hits[0];
          var card2 = el("div", "goal-card");
          card2.innerHTML =
            '<div class="goal-head"><div class="goal-title">🔔 ' + esc(t.query) + "</div>" +
            '<div class="goal-pct" style="font-size:14px">' + (t.enabled ? "运行中" : "已暂停") + "</div></div>" +
            '<div class="goal-meta" style="margin:8px 0 0"><span>每 ' + t.intervalMin + " 分钟 · 已跑 " + t.runCount + " 次" +
            (lastHit ? " · 最近命中：" + new Date(lastHit.t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : " · 暂无命中") + "</span></div>" +
            (lastHit ? '<div class="fc-sum" style="margin-top:8px">🚨 ' + esc(lastHit.summary) +
              (lastHit.top && lastHit.top[0] ? '<br><span style="color:var(--ink-faint)">来源：' + esc(lastHit.top[0].title.slice(0, 40)) + "</span>" : "") + "</div>" : "") +
            '<div class="goal-meta"><span>条件：' + esc(t.condition) + "</span>" +
            '<span><button class="chip" type="button" data-mon-toggle="' + t.id + '">' + (t.enabled ? "暂停" : "恢复") + "</button> " +
            '<button class="chip" type="button" data-mon-del="' + t.id + '">删除</button></span></div>';
          monBox.appendChild(card2);
        });
        monBox.addEventListener("click", function (e) {
          var tg = e.target.closest("[data-mon-toggle]");
          var dl = e.target.closest("[data-mon-del]");
          var base = bridgeBase();
          if (tg) {
            fetch(base + "/tasks/" + tg.getAttribute("data-mon-toggle") + "/toggle", { method: "POST" })
              .then(function () { renderGoals(); });
          } else if (dl) {
            fetch(base + "/tasks/" + dl.getAttribute("data-mon-del"), { method: "DELETE" })
              .then(function () { store.audit("删除后台监控", "", "info"); renderGoals(); });
          }
        }, { once: true });
      })
      .catch(function () {
        monBox.innerHTML = '<div class="goal-empty" style="padding:20px">⚠ 后台监控需要本地服务桥在线（node server.js）。</div>';
      });
  }

  function openAddGoal() {
    openForm("新目标", [
      { key: "title", label: "目标名称", placeholder: "比如：每天读书 20 分钟" },
      { key: "steps", label: "小步骤（每行一个）", placeholder: "今晚读 10 页\n本周读完第一章\n本月读完第一本", multiline: true },
    ], function (vals) {
      if (!vals.title) return "请填写目标名称";
      var steps = vals.steps.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      store.addGoal({ title: vals.title, steps: steps, source: "manual" });
      store.audit("创建目标", vals.title, "done");
      renderGoals();
      updateBadges();
      toast("目标已建立 🎯 Lumi 会在动态页跟进它");
    });
  }

  // ———————————————————————————— 文件 ————————————————————————————

  function renderFiles() {
    var grid = $("#files-grid");
    grid.innerHTML = "";
    if (!store.state.files.length) {
      grid.innerHTML = '<div class="file-empty">这里还空着。<br>让 Lumi 帮你调研、写作、作画，成果都会归档到这里。<br>试试：「给我画一幅睡莲」。</div>';
      return;
    }
    store.state.files.forEach(function (f) {
      var card = el("button", "file-card");
      card.type = "button";
      var art = f.kind === "art" && f.dataURL
        ? '<div class="file-art"><img src="' + f.dataURL + '" alt=""></div>'
        : '<div class="file-doc">' + ({ doc: "📄", art: "🎨", reminder: "⏰", event: "📅", mail: "✉️" }[f.kind] || "📄") + "</div>";
      card.innerHTML = art +
        '<div class="file-body">' +
        '<div class="file-kind">' + ({ doc: "文档", art: "画作", reminder: "提醒", event: "日历事件 · 可导入", mail: "邮件草稿 · 可导入" }[f.kind] || "文档") + "</div>" +
        '<div class="file-title">' + esc(f.title) + "</div>" +
        '<div class="file-date">' + new Date(f.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) + (f.source === "model" ? " · 真实生成" : "") + "</div>" +
        "</div>";
      card.addEventListener("click", function () { openViewer(f.id); });
      grid.appendChild(card);
    });
  }

  // ———————————————————————————— 查看器 / 表单弹窗 ————————————————————————————

  function openViewer(fileId) {
    var f = null;
    store.state.files.forEach(function (x) { if (x.id === fileId) f = x; });
    if (!f) return;
    $("#viewer-title").textContent = f.title;
    var body = $("#viewer-body");
    body.innerHTML = "";
    if (f.kind === "art" && f.dataURL) {
      var img = el("img");
      img.src = f.dataURL;
      img.style.width = "100%";
      img.style.borderRadius = "14px";
      body.appendChild(img);
      body.appendChild(el("p", "doc-view", esc(f.body || "")));
    } else if (f.kind === "event" || f.kind === "mail") {
      // .ics / .eml：原文展示（可下载导入对应客户端）
      var pre = el("pre");
      pre.style.cssText = "background:rgba(36,58,77,.92);color:#e9f2f8;border-radius:12px;padding:14px;font-size:12px;line-height:1.7;overflow-x:auto;white-space:pre-wrap;";
      pre.textContent = f.body || "";
      body.appendChild(pre);
      body.appendChild(el("p", "doc-view",
        f.kind === "event"
          ? "这是标准 iCalendar 日历事件。点击下方「下载 .ics」，双击文件即可导入系统日历（macOS 日历 / Google Calendar / Outlook 均支持）。"
          : "这是标准邮件草稿（含 X-Unsent 标记）。下载 .eml 后用邮件客户端打开，可继续编辑并发送。"));
    } else {
      body.appendChild(el("div", "doc-view", md(f.body)));
    }
    var btnRow = el("div");
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:16px;flex-wrap:wrap";
    // 下载：把代理生成的真实产物落成文件
    if (f.body || f.dataURL) {
      var dl = el("button", "chip solid", "下载 " + (f.kind === "event" ? ".ics" : f.kind === "mail" ? ".eml" : f.kind === "art" ? ".jpg" : ".md"));
      dl.type = "button";
      dl.addEventListener("click", function () {
        var ext = f.kind === "event" ? "ics" : f.kind === "mail" ? "eml" : f.kind === "art" ? "jpg" : "md";
        var mime = f.kind === "event" ? "text/calendar" : f.kind === "mail" ? "message/rfc822" : f.kind === "art" ? "image/jpeg" : "text/markdown";
        var content = f.kind === "art" ? f.dataURL : f.body;
        // dataURL 直接用；文本内容转 Blob
        var href = content;
        if (content.indexOf("data:") !== 0) {
          href = URL.createObjectURL(new Blob([content], { type: mime + ";charset=utf-8" }));
        }
        var a = document.createElement("a");
        a.href = href;
        a.download = f.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) + "." + ext;
        a.click();
        if (href.indexOf("blob:") === 0) URL.revokeObjectURL(href);
        store.audit("下载文件", f.title, "info");
      });
      btnRow.appendChild(dl);
    }
    var del = el("button", "chip", "删除此文件");
    del.type = "button";
    del.addEventListener("click", function () {
      store.removeFile(f.id);
      closeViewer();
      renderFiles();
      updateBadges();
      toast("已删除");
    });
    btnRow.appendChild(del);
    body.appendChild(btnRow);
    $("#viewer-modal").hidden = false;
  }

  function closeViewer() { $("#viewer-modal").hidden = true; }

  // 通用文档查看（技能说明等纯 markdown 内容）
  function openDoc(title, markdownText) {
    $("#viewer-title").textContent = title;
    var body = $("#viewer-body");
    body.innerHTML = "";
    body.appendChild(el("div", "doc-view", md(markdownText)));
    $("#viewer-modal").hidden = false;
  }

  // 通用小表单（新目标/新记忆/编辑记忆用）；initial 可选，按 key 预填
  function openForm(title, fields, onSubmit, initial) {
    $("#viewer-title").textContent = title;
    var body = $("#viewer-body");
    body.innerHTML = "";
    var form = el("div");
    fields.forEach(function (f) {
      var row = el("div", "set-row");
      row.appendChild(el("label", "", esc(f.label)));
      var input;
      if (f.multiline) {
        input = document.createElement("textarea");
        input.rows = 3;
        input.style.cssText = "flex:1;min-width:200px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13.5px;font-family:inherit;resize:vertical;background:rgba(255,255,255,.8)";
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.style.cssText = "flex:1;min-width:200px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13.5px;background:rgba(255,255,255,.8)";
      }
      input.placeholder = f.placeholder || "";
      if (initial && initial[f.key]) input.value = initial[f.key];
      input.setAttribute("data-key", f.key);
      row.appendChild(input);
      form.appendChild(row);
    });
    var err = el("div", "", "");
    err.style.cssText = "color:var(--danger);font-size:12.5px;min-height:18px;margin:4px 0";
    var submit = el("button", "chip solid", "保存");
    submit.type = "button";
    submit.style.marginTop = "6px";
    submit.addEventListener("click", function () {
      var vals = {};
      form.querySelectorAll("[data-key]").forEach(function (input) {
        vals[input.getAttribute("data-key")] = input.value;
      });
      var problem = onSubmit(vals);
      if (problem) { err.textContent = problem; return; }
      closeViewer();
    });
    form.appendChild(err);
    form.appendChild(submit);
    body.appendChild(form);
    $("#viewer-modal").hidden = false;
  }

  // ———————————————————————————— 设置 ————————————————————————————

  var AUTONOMY = [
    ["ask", "每次都问", "任何动作执行前都请求批准"],
    ["sensitive", "仅敏感操作", "花钱、预订、对外发送前才问（推荐）"],
    ["auto", "全自动", "全部自动执行，只记录审计日志"],
  ];

  function renderSettings(focus) {
    var body = $("#settings-body");
    body.innerHTML = "";
    var s = store.state.settings;

    // —— 代理身份 ——
    // —— 版本与更新 ——
    var secUp = el("div", "set-section");
    secUp.appendChild(el("h3", "", "更新 · 版本与一键升级"));
    var upBox = el("div");
    upBox.style.cssText = "font-size:13px;color:var(--ink-soft);line-height:1.8";
    secUp.appendChild(upBox);
    var upBtns = el("div", "set-row");
    secUp.appendChild(upBtns);
    function renderUpdateSection() {
      var d = updateState.data;
      var lines = [];
      if (!d) {
        lines.push("点「检查更新」获取版本信息");
      } else {
        lines.push("本地代码 v" + esc(d.local && d.local.version || "?") +
          (d.local && d.local.sha ? "（" + esc(d.local.sha) + "）" : "") +
          (d.mode === "download" ? " · ZIP 安装" : " · git 克隆") +
          (d.dirty ? " · <b style='color:#9a6b1a'>本地有未提交改动，一键更新会被拒绝</b>" : ""));
        if (d.runtime) {
          lines.push("当前服务 v" + esc(d.runtime.version || "?") +
            (d.runtime.sha ? "（" + esc(d.runtime.sha) + "）" : ""));
        }
        if (d.restartRequired) lines.push("<b style='color:#9a6b1a'>代码已更新，服务仍在运行旧代码；请重启服务桥，然后刷新网页。</b>");
        if (d.checked === false) {
          lines.push("远端检查未完成，暂时无法确认是否有更新。");
        } else if (d.updateAvailable) {
          var n = d.behind || (d.commits || []).length;
          lines.push("<b style='color:#47724f'>✨ 有新代码" + (d.mode === "download" ? "：v" + esc(d.remoteVersion || "?") : "：落后 " + n + " 个提交") + "</b>");
          if (d.commits && d.commits.length) {
            lines.push('<div style="max-height:140px;overflow:auto;border:1px solid var(--line-soft);border-radius:8px;padding:8px 12px;margin-top:6px;font-size:12.5px">' +
              d.commits.map(function (c) { return "· " + esc(c); }).join("<br>") + "</div>");
          }
        } else if (!d.restartRequired) {
          lines.push(d.ahead ? "远端没有更新提交；本地含额外提交。" : "✓ 代码与服务均已是最新版本");
        } else lines.push("远端没有新提交可拉取。");
        if (d.note) lines.push('<span style="font-size:12px;color:var(--ink-faint)">' + esc(d.note) + "</span>");
      }
      upBox.innerHTML = lines.join("<br>");
      upBtns.innerHTML = "";
      var reCheck = el("button", "chip", "检查更新");
      reCheck.type = "button";
      reCheck.addEventListener("click", function () {
        reCheck.disabled = true;
        checkForUpdates(false).then(renderUpdateSection);
      });
      upBtns.appendChild(reCheck);
      if (d && d.updateAvailable) {
        if (d.mode === "download") {
          var dl = el("a", "chip", "前往 GitHub 下载新版");
          dl.href = "https://github.com/" + d.repo;
          dl.target = "_blank"; dl.rel = "noopener";
          upBtns.appendChild(dl);
        } else {
          var applyBtn = el("button", "chip allow", "立即更新（git pull）");
          applyBtn.type = "button";
          applyBtn.addEventListener("click", applyUpdate);
          upBtns.appendChild(applyBtn);
        }
      }
      if (d && d.restartRequired) {
        var help = el("button", "chip", "重启说明");
        help.type = "button";
        help.addEventListener("click", function () {
          openDoc("加载新版服务桥", "在原启动终端按 Ctrl+C 停止服务，再用原来的启动命令启动，保留端口和模型配置。随后刷新网页。\n\n仅刷新网页或再次 git pull 不会替换正在运行的 Node 服务。");
        });
        upBtns.appendChild(help);
      }
    }
    renderUpdateSection();
    if (!updateState.data) checkForUpdates(true).then(function () { renderUpdateSection(); renderSideVersion(); }); // 打开设置时静默补拉一次
    body.appendChild(secUp);

    var sec1 = el("div", "set-section");
    sec1.appendChild(el("h3", "", "代理身份"));
    var r1 = el("div", "set-row");
    r1.appendChild(el("label", "", "名字"));
    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = s.agentName;
    nameInput.placeholder = "Lumi";
    nameInput.addEventListener("change", function () {
      s.agentName = nameInput.value.trim() || "Lumi";
      store.save();
      updateIdentity();
      toast("它现在叫 " + s.agentName);
    });
    r1.appendChild(nameInput);
    sec1.appendChild(r1);

    // 说话方式（自定义智能体的说话风格）
    var toneRow = el("div", "radio-row");
    sec1.appendChild(el("h3", "", "说话方式"));
    var TONES_UI = [["monet", "温柔印象派"], ["pro", "简洁高效"], ["warm", "热心絮叨"]];
    TONES_UI.forEach(function (t) {
      var pill = el("button", "radio-pill" + (s.tone === t[0] ? " sel" : ""), t[1]);
      pill.type = "button";
      pill.addEventListener("click", function () {
        s.tone = t[0];
        store.save();
        renderSettings();
      });
      toneRow.appendChild(pill);
    });
    sec1.appendChild(toneRow);

    // 头像：Lumi 二次元形象与莫奈画作预置
    sec1.appendChild(el("h3", "", "形象"));
    var avRow = el("div", "radio-row");
    Object.keys(AVATARS).forEach(function (aid) {
      var img = document.createElement("img");
      img.src = AVATARS[aid];
      img.style.cssText = "width:52px;height:52px;border-radius:50%;object-fit:cover;cursor:pointer;border:3px solid " +
        (s.avatarId === aid ? "var(--water-deep)" : "transparent");
      img.title = aid === "avatar-1" ? "Lumi · 莫奈二次元" : "莫奈画作 · " + aid.slice(-1);
      img.alt = img.title;
      img.addEventListener("click", function () {
        s.avatarId = aid;
        store.save();
        applyAvatar();
        renderSettings();
      });
      avRow.appendChild(img);
    });
    sec1.appendChild(avRow);

    // 语音：朗读回复开关
    var speakRow = el("div", "set-row");
    speakRow.appendChild(el("label", "", "语音"));
    var speakBtn = el("button", "radio-pill" + (s.speakReplies ? " sel" : ""), s.speakReplies ? "● 朗读回复" : "○ 朗读回复");
    speakBtn.type = "button";
    speakBtn.addEventListener("click", function () {
      s.speakReplies = !s.speakReplies;
      store.save();
      if (!s.speakReplies && window.speechSynthesis) speechSynthesis.cancel();
      renderSettings();
    });
    speakRow.appendChild(speakBtn);
    sec1.appendChild(speakRow);

    sec1.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);line-height:1.8">给你的代理起个专属名字吧。所有数据（对话、密钥、目标、文件）只存在这台设备的浏览器里。</div>');
    body.appendChild(sec1);

    // —— 模型接入 ——
    var sec2 = el("div", "set-section");
    sec2.appendChild(el("h3", "", "模型接入 · 可同时配置多家随时切换"));
    Object.keys(window.LumenAI.PRESETS).forEach(function (pid) {
      var preset = window.LumenAI.PRESETS[pid];
      var cfg = window.LumenAI.providerConfig(pid);
      var isActive = s.activeProvider === pid && window.LumenAI.isReady(pid);
      var card = el("div", "provider-card" + (isActive ? " active-prov" : ""));
      var head = el("div", "pc-head");
      head.innerHTML =
        "<span class=\"pc-name\">" + esc(preset.name) + "</span>" +
        "<span class=\"pc-status " + (window.LumenAI.isReady(pid) ? "on" : "off") + "\">" +
        (window.LumenAI.isReady(pid) ? (isActive ? "使用中" : "已就绪") : "未配置") + "</span>";
      var toggle = el("button", "icon-btn", "▾");
      toggle.type = "button";
      toggle.style.fontSize = "12px";
      head.appendChild(toggle);
      card.appendChild(head);

      var inner = el("div", "pc-body");
      var userCfg = s.providers[pid] || (s.providers[pid] = {});

      function field(labelText, key, val, isPwd, placeholder, datalist) {
        var row = el("div", "set-row");
        row.appendChild(el("label", "", esc(labelText)));
        var inp = document.createElement("input");
        inp.type = isPwd ? "password" : "text";
        inp.value = val || "";
        inp.placeholder = placeholder || "";
        inp.setAttribute("data-cfg", key); // 「测试 / 启用」按钮靠它收集当前输入值
        if (datalist) {
          inp.setAttribute("list", dlId);
          var dl = document.createElement("datalist");
          dl.id = dlId;
          datalist.forEach(function (mo) {
            var op = document.createElement("option");
            op.value = mo;
            dl.appendChild(op);
          });
          row.appendChild(dl);
        }
        inp.addEventListener("change", function () {
          userCfg[key] = inp.value.trim();
          store.save();
          updateModelChip();
        });
        row.appendChild(inp);
        return row;
      }
      var dlId = "dl-" + pid;

      inner.appendChild(field("API Key", "apiKey", cfg.apiKey, true, pid === "gemini" ? "AIza…" : "sk-…"));
      inner.appendChild(field("接口地址", "baseUrl", userCfg.baseUrl || "", false, preset.baseUrl, null));
      inner.appendChild(field("模型", "model", userCfg.model || "", false, preset.models[0] || "模型名", preset.models));

      var btnRow = el("div", "set-row");
      var testBtn = el("button", "chip", "测试连接");
      testBtn.type = "button";
      var testOut = el("div", "pc-test", "");
      testBtn.addEventListener("click", function () {
        testOut.className = "pc-test";
        testOut.textContent = "连接中…";
        // 先把输入框里的值收进来再测
        inner.querySelectorAll("input[data-cfg]").forEach(function (i) {
          userCfg[i.getAttribute("data-cfg")] = i.value.trim();
        });
        window.LumenAI.testProvider(pid).then(function (r) {
          testOut.className = "pc-test " + (r.ok ? "ok" : "err");
          testOut.textContent = r.msg;
          // 只更新状态胶囊，不整页重渲染（避免折叠用户正打开的卡片）
          var chipEl = card.querySelector(".pc-status");
          var ready = window.LumenAI.isReady(pid);
          chipEl.className = "pc-status " + (ready ? "on" : "off");
          chipEl.textContent = ready ? (s.activeProvider === pid ? "使用中" : "已就绪") : "未配置";
          updateModelChip();
        });
      });
      btnRow.appendChild(testBtn);

      var useBtn = el("button", "chip solid", "启用此模型");
      useBtn.type = "button";
      useBtn.addEventListener("click", function () {
        inner.querySelectorAll("input[data-cfg]").forEach(function (i) {
          userCfg[i.getAttribute("data-cfg")] = i.value.trim();
        });
        if (!window.LumenAI.isReady(pid)) { toast("请先填写 API Key、接口地址与模型名"); return; }
        s.activeProvider = pid;
        s.activeModel = window.LumenAI.providerConfig(pid).model;
        store.save();
        store.audit("切换模型", preset.name + " · " + s.activeModel, "info");
        updateModelChip();
        renderSettings("providers-keep");
        toast("已启用 " + s.activeModel);
      });
      btnRow.appendChild(useBtn);
      inner.appendChild(btnRow);
      inner.appendChild(testOut);
      card.appendChild(inner);

      toggle.addEventListener("click", function () { card.classList.toggle("open"); });
      if (focus === "providers" && window.LumenAI.isReady(pid) === false && pid === "openai") card.classList.add("open");
      if (isActive) card.classList.add("open");
      sec2.appendChild(card);

      // 本地网关卡片：实时探测网关状态——配了环境变量才亮「已就绪 · 模型名」；
      // 没配就如实显示「未配置」并给出配置方法，绝不误导启用
      if (pid === "localgw") {
        fetch(bridgeBase() + "/v1/models").then(function (r) { return r.json(); }).then(function (d) {
          var models = ((d && d.data) || []).map(function (m) { return m.id; });
          var chipEl = card.querySelector(".pc-status");
          if (!models.length) {
            if (chipEl) { chipEl.textContent = "未配置"; chipEl.className = "pc-status off"; }
            var body = card.querySelector(".pc-body");
            if (body && !body.querySelector(".localgw-hint")) {
              var hint = el("div", "localgw-hint",
                '<div style="font-size:12px;color:var(--ink-faint);line-height:1.8;margin-top:8px">网关需要服务端密钥：启动服务桥时设置环境变量，例如<br>' +
                '<code>LUMEN_MODEL_API_KEY=你的Key LUMEN_MODEL_BASE=端点 node server.js</code><br>' +
                "（任意 Anthropic 兼容端点；也可以不用本卡片，直接用上面各家厂商自带 Key 直连）</div>");
              body.appendChild(hint);
            }
            return;
          }
          if (chipEl) chipEl.textContent = (isActive ? "使用中 · " : "已就绪 · ") + models[0];
          var dl = card.querySelector("datalist");
          if (dl) models.forEach(function (mo) {
            var op = document.createElement("option"); op.value = mo; dl.appendChild(op);
          });
          if (!userCfg.model) { // 用户还没填模型 → 自动带上网关模型
            userCfg.model = models[0];
            var inp = card.querySelector('input[data-cfg="model"]');
            if (inp) inp.value = models[0];
          }
          if (!userCfg.apiKey) { // 网关不需要真实密钥（服务端注入）→ 占位自动填，扫清「请先填写」门槛
            userCfg.apiKey = "local";
            var kin = card.querySelector('input[data-cfg="apiKey"]');
            if (kin) kin.value = "local";
          }
          store.save();
          updateModelChip();
        }).catch(function () {});
      }
    });
    body.appendChild(sec2);

    // —— 自主程度 ——
    var sec3 = el("div", "set-section");
    sec3.appendChild(el("h3", "", "自主程度 · 关键动作的审批策略"));
    var rr = el("div", "radio-row");
    AUTONOMY.forEach(function (a) {
      var pill = el("button", "radio-pill" + (s.autonomy === a[0] ? " sel" : ""), esc(a[1]));
      pill.type = "button";
      pill.title = a[2];
      pill.addEventListener("click", function () {
        s.autonomy = a[0];
        store.save();
        renderSettings();
      });
      rr.appendChild(pill);
    });
    sec3.appendChild(rr);
    sec3.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:8px;line-height:1.8">' +
      esc(AUTONOMY.filter(function (a) { return a[0] === s.autonomy; })[0][2]) +
      (Object.keys(store.state.alwaysAllow).length ? " · 你已对「" + Object.keys(store.state.alwaysAllow).join("、") + "」选择过「总是允许」" : "") +
      "</div>");
    body.appendChild(sec3);

    // —— 应用连接（维护者配置应用一次，使用者登录并授权） ——
    var secConn = el("div", "set-section");
    secConn.appendChild(el("h3", "", "应用连接"));
    function connChip(ok, text) {
      return '<span class="pc-status ' + (ok ? "on" : "off") + '">' + String(text).replace(/[&<>"']/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }) + "</span>";
    }
    function connField(rowLabel, inputType, inputId, placeholder) {
      var row = el("div", "set-row");
      var label = el("label", "", rowLabel);
      label.htmlFor = inputId;
      row.appendChild(label);
      var inp = document.createElement("input");
      inp.type = inputType;
      inp.id = inputId;
      inp.placeholder = placeholder;
      inp.style.flex = "1";
      row.appendChild(inp);
      return row;
    }
    function connBtn(label, onClick, solid) {
      var b = el("button", "chip" + (solid ? " solid" : ""), label);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    }
    function connLink(label, href, title) {
      var a = el("a", "chip", label);
      a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
      if (title) a.setAttribute("aria-label", title);
      return a;
    }

    var oauthUi = {};
    function connAdvanced(container, link) {
      var details = document.createElement("details");
      details.style.marginTop = "14px";
      details.appendChild(el("summary", "", "高级设置 · 应用维护者配置"));
      details.querySelector("summary").style.cursor = "pointer";
      if (link) details.appendChild(link);
      container.appendChild(details);
      return details;
    }
    function connOAuth(id, name, container, advanced) {
      var row = el("div", "set-row");
      var out = el("p", "pc-test", "正在检查应用连接…");
      out.setAttribute("role", "status");
      var connect = connBtn("连接" + (id === "lark" ? "" : " ") + name, function () {
        var baseline = oauthUi[id].resultAt, deadline = Date.now() + 600000, closedAt = 0;
        // 点击时同步打开授权页，避免异步请求后打开被浏览器拦截。
        var popup = window.open(bridgeBase() + "/connectors/" + id + "/auth", "_blank");
        if (!popup) { out.textContent = "浏览器拦截了登录窗口，请允许此站点弹出窗口后重试"; return; }
        popup.opener = null;
        connect.disabled = true;
        out.className = "pc-test";
        out.textContent = "请在官方登录页选择账户并授权，完成后这里会自动更新";
        oauthUi[id].waiting = true;
        function finish(message, ok) {
          oauthUi[id].waiting = false;
          connect.disabled = !oauthUi[id].configured;
          out.className = "pc-test " + (ok ? "ok" : "err");
          out.textContent = message;
        }
        function poll() {
          if (!document.body.contains(container)) return;
          desktopApi("/connectors").then(function (d) {
            refreshConnChips(d);
            var cfg = d && d.connectors && d.connectors[id];
            if (cfg && cfg.authResult && cfg.authResult.at !== baseline) {
              var account = cfg.accountName || cfg.email;
              finish(cfg.authResult.ok ? (name + " 已连接" + (account ? " · " + account : "")) : cfg.authResult.message, cfg.authResult.ok);
              return;
            }
            if (popup.closed && !closedAt) closedAt = Date.now();
            if (Date.now() > deadline || (closedAt && Date.now() - closedAt > 5000)) {
              finish("连接尚未完成，可再次点击连接重试", false); return;
            }
            setTimeout(poll, 1500);
          });
        }
        setTimeout(poll, 1000);
      }, true);
      connect.disabled = true;
      var disconnect = connBtn("断开连接", function () {
        desktopApi("/connectors/save", "POST", {id:id, patch:{clearAuth:true}}).then(function (d) {
          if (d && d.ok) { refreshConnChips(d); toast(name + " 已断开连接"); }
          else toast((d && d.error) || "服务桥离线");
        });
      });
      disconnect.hidden = true;
      row.appendChild(connect); row.appendChild(disconnect);
      var setup = connBtn("配置应用", function () { advanced.open = true; });
      setup.hidden = true; row.appendChild(setup);
      container.appendChild(row); container.appendChild(out);
      container.appendChild(el("p", "pc-test", "登录并同意授权即可连接。读取与写入权限在「活动 → 应用权限」中管理。"));
      oauthUi[id] = {name:name, connect:connect, disconnect:disconnect, setup:setup, out:out, resultAt:0, configured:false, managed:false, waiting:false, fieldValues:{}, advanced:advanced};
    }

    // —— 飞书 / Lark ——
    var larkCard = el("div", "provider-card open");
    var larkHead = el("div", "pc-head");
    larkHead.innerHTML = '<span class="pc-name">飞书 / Lark</span><span id="conn-lark-chip">' + connChip(false, "未配置") + "</span>";
    larkCard.appendChild(larkHead);
    var larkBody = el("div", "pc-body");
    var larkAdvanced = connAdvanced(larkBody, connLink("注册 Lumi 飞书应用 ↗", "https://open.feishu.cn/app", "打开飞书开发者后台"));
    connOAuth("lark", "飞书账户", larkBody, larkAdvanced);
    larkBody.appendChild(larkAdvanced);
    larkAdvanced.appendChild(connField("模式", "text", "lark-mode", "oauth（账户授权）/ app（应用机器人）/ webhook（群机器人）"));
    larkAdvanced.appendChild(connField("区域", "text", "lark-region", "feishu（国内）；larksuite（国际，仅机器人模式）"));
    larkAdvanced.appendChild(connField("App ID", "text", "lark-appid", "cli_xxxxxxxx（Lumi 应用标识）"));
    larkAdvanced.appendChild(connField("App Secret", "password", "lark-appsecret", "仅存服务端，不回显；留空保留原值"));
    larkAdvanced.appendChild(connField("授权范围", "text", "lark-scopes", "留空使用消息、文档、日历及离线授权"));
    var larkRedirectRow = connField("授权回调 URI", "text", "lark-redirect-uri", "正在获取服务桥回调地址…");
    var larkRedirectInput = larkRedirectRow.querySelector("input");
    larkRedirectInput.readOnly = true;
    larkRedirectRow.appendChild(connBtn("复制回调地址", function () {
      if (!larkRedirectInput.value) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(larkRedirectInput.value).then(function () { toast("回调地址已复制"); }, function () { larkRedirectInput.select(); toast("请手动复制选中的回调地址"); });
      } else { larkRedirectInput.select(); toast("请手动复制选中的回调地址"); }
    }));
    larkAdvanced.appendChild(larkRedirectRow);
    larkAdvanced.appendChild(connField("群 Webhook", "password", "lark-webhook", "https://open.feishu.cn/open-apis/bot/v2/hook/…（webhook 模式）"));
    larkAdvanced.appendChild(connField("默认接收者", "text", "lark-chatid", "群 chat_id（oc_…）、open_id 或对方邮箱"));
    var larkBtnRow = el("div", "set-row");
    var larkOut = el("div", "pc-test");
    larkBtnRow.appendChild(connBtn("保存", function () {
      var patch = { mode:document.getElementById("lark-mode").value.trim() || "oauth", defaultChatId:document.getElementById("lark-chatid").value.trim() };
      var webhook = document.getElementById("lark-webhook").value.trim();
      if (webhook) patch.webhook = webhook;
      if (!oauthUi.lark.managed) {
        patch.region = document.getElementById("lark-region").value.trim();
        patch.appId = document.getElementById("lark-appid").value.trim();
        patch.appSecret = document.getElementById("lark-appsecret").value.trim();
        patch.oauthScopes = document.getElementById("lark-scopes").value.trim();
      }
      desktopApi("/connectors/save", "POST", {id:"lark", patch:patch}).then(function (d) {
        if (d && d.ok) {
          toast("飞书配置已保存（密钥仅存服务端）");
          document.getElementById("lark-appsecret").value = "";
          document.getElementById("lark-webhook").value = "";
          refreshConnChips(d);
        } else toast("保存失败：" + ((d && d.error) || "服务桥离线"));
      });
    }, true));
    larkBtnRow.appendChild(connBtn("测试", function () {
      larkOut.textContent = "测试中…";
      desktopApi("/connectors/test", "POST", { id: "lark" }).then(function (d) {
        larkOut.className = "pc-test " + (d && d.ok ? "ok" : "err");
        larkOut.textContent = (d && d.ok && d.msg) || (d && d.error) || "服务桥离线";
      });
    }));
    larkBtnRow.appendChild(larkOut);
    larkAdvanced.appendChild(larkBtnRow);
    larkAdvanced.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:6px;line-height:1.9">' +
      '<b>账户授权（oauth）</b>：维护者在飞书开发者后台创建 Lumi 应用，将上方完整回调地址加入「安全设置 → 重定向 URL」。开通用户身份权限 offline_access、im:message、im:message.send_as_user、docx:document、calendar:calendar、calendar:calendar:read；启用刷新 user_access_token，发布并设置应用可用范围。保存 App ID / Secret 后，使用者只需点击「连接飞书账户」。<br>' +
      '自建应用仅限本企业；面向其他企业需要商店应用资质及发布。App Secret 保留在受控服务端，不随公开客户端分发。账户授权目前支持飞书国内版。<br>' +
      '<b>应用机器人（app）</b>：开启机器人能力及应用身份权限，发布并将机器人加入目标群；<b>群机器人（webhook）</b>：保存群的自定义机器人 Webhook，仅用于发群消息。<br>' +
      '<a href="https://open.feishu.cn/document/sso/web-application-end-user-consent/guide" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">飞书官方授权说明 ↗</a></div>');
    larkCard.appendChild(larkBody);
    secConn.appendChild(larkCard);

    // —— Google（Gmail 发信 / 日历日程） ——
    var gCard = el("div", "provider-card open");
    var gHead = el("div", "pc-head");
    gHead.innerHTML = '<span class="pc-name">Google · Gmail / 日历</span><span id="conn-google-chip">' + connChip(false, "未配置") + "</span>";
    gCard.appendChild(gHead);
    var gBody = el("div", "pc-body");
    var gAdvanced = connAdvanced(gBody, connLink("获取 Client ID ↗", "https://console.cloud.google.com/auth/clients", "获取 Google Client ID（打开官方控制台）"));
    connOAuth("google", "Google", gBody, gAdvanced);
    gBody.appendChild(gAdvanced);
    gAdvanced.appendChild(connField("Client ID", "text", "g-clientid", "xxxx.apps.googleusercontent.com"));
    gAdvanced.appendChild(connField("Client Secret", "password", "g-clientsecret", "GOCSPX-…（不回显）"));
    var gRedirectRow = connField("授权回调 URI", "text", "g-redirect-uri", "正在获取服务桥回调地址…");
    var gRedirectInput = gRedirectRow.querySelector("input");
    gRedirectInput.readOnly = true;
    var gCopyRedirect = connBtn("复制回调地址", function () {
      if (!gRedirectInput.value) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(gRedirectInput.value).then(function () { toast("回调地址已复制"); }, function () { gRedirectInput.select(); toast("请手动复制选中的回调地址"); });
      } else { gRedirectInput.select(); toast("请手动复制选中的回调地址"); }
    });
    gCopyRedirect.disabled = true;
    gRedirectRow.appendChild(gCopyRedirect);
    gAdvanced.appendChild(gRedirectRow);
    var gBtnRow = el("div", "set-row");
    var gOut = el("div", "pc-test");
    gBtnRow.appendChild(connBtn("保存", function () {
      desktopApi("/connectors/save", "POST", {
        id: "google",
        patch: {
          clientId: document.getElementById("g-clientid").value.trim(),
          clientSecret: document.getElementById("g-clientsecret").value.trim(),
        },
      }).then(function (d) {
        if (d && d.ok) {
          toast("Google 配置已保存");
          document.getElementById("g-clientsecret").value = "";
          refreshConnChips(d);
        } else toast("保存失败：" + ((d && d.error) || "服务桥离线"));
      });
    }, true));
    gBtnRow.appendChild(connBtn("测试", function () {
      gOut.textContent = "测试中…";
      desktopApi("/connectors/test", "POST", { id: "google" }).then(function (d) {
        gOut.className = "pc-test " + (d && d.ok ? "ok" : "err");
        gOut.textContent = (d && d.ok && d.msg) || (d && d.error) || "服务桥离线";
      });
    }));
    gBtnRow.appendChild(gOut);
    gAdvanced.appendChild(gBtnRow);
    gAdvanced.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:6px;line-height:1.9">' +
      '① 点上方「获取 Client ID」，选择或创建项目，完成 Google Auth Platform 的品牌信息与受众设置；测试模式时把自己的邮箱加入测试用户。<br>' +
      '② 在项目中启用 Gmail API 和 Google Calendar API。<br>' +
      '③ Clients → Create client，应用类型选「<b>Web application（Web 应用）</b>」，把上方地址加入「Authorized redirect URIs」。<br>' +
      '④ 创建后复制 Client ID 与 Client Secret 填入这里，保存。普通使用者只需点击「连接 Google」。Client ID 是应用标识，不是模型 API Key。<br>' +
      '完成授权后，在「活动 → 应用权限」开放需要的读取/写入。<a href="https://support.google.com/cloud/answer/15549257" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">Google 官方配置说明 ↗</a></div>');
    gCard.appendChild(gBody);
    secConn.appendChild(gCard);

    // —— 邮件（SMTP 授权码：QQ/163/126/Gmail/Outlook 通用） ——
    var smtpCard = el("div", "provider-card");
    var smtpHead = el("div", "pc-head");
    smtpHead.innerHTML = '<span class="pc-name">邮件 · SMTP 授权码（QQ / 163 / Gmail / Outlook 通用）</span><span id="conn-mail-chip">' + connChip(false, "未配置") + "</span>";
    smtpCard.appendChild(smtpHead);
    var smtpBody = el("div", "pc-body");
    var smtpPresetRow = el("div", "set-row");
    smtpPresetRow.appendChild(el("label", "", "一键填服务商"));
    var SMTP_PRESETS = [
      ["QQ 邮箱", "smtp.qq.com", "465", "ssl"],
      ["163 邮箱", "smtp.163.com", "465", "ssl"],
      ["126 邮箱", "smtp.126.com", "465", "ssl"],
      ["Gmail", "smtp.gmail.com", "465", "ssl"],
      ["Outlook", "smtp.office365.com", "587", "starttls"],
    ];
    SMTP_PRESETS.forEach(function (p) {
      smtpPresetRow.appendChild(connBtn(p[0], function () {
        document.getElementById("mail-host").value = p[1];
        document.getElementById("mail-port").value = p[2];
        document.getElementById("mail-ssl").value = p[3];
      }));
    });
    smtpBody.appendChild(smtpPresetRow);
    smtpBody.appendChild(connField("邮箱账号", "text", "mail-user", "you@qq.com（同时是 SMTP 用户名和发件人）"));
    smtpBody.appendChild(connField("授权码", "password", "mail-pass", "在邮箱设置里开启 SMTP 服务后生成的授权码（非登录密码）"));
    smtpBody.appendChild(connField("SMTP 服务器", "text", "mail-host", "smtp.qq.com"));
    smtpBody.appendChild(connField("端口", "text", "mail-port", "465（SSL）或 587（STARTTLS）"));
    smtpBody.appendChild(connField("加密方式", "text", "mail-ssl", "ssl 或 starttls（留空按端口推断）"));
    var smtpBtnRow = el("div", "set-row");
    var smtpOut = el("div", "pc-test");
    smtpBtnRow.appendChild(connBtn("保存", function () {
      desktopApi("/connectors/save", "POST", {
        id: "mail",
        patch: {
          host: document.getElementById("mail-host").value.trim(),
          port: document.getElementById("mail-port").value.trim(),
          user: document.getElementById("mail-user").value.trim(),
          pass: document.getElementById("mail-pass").value.trim(),
          sslMode: document.getElementById("mail-ssl").value.trim(),
        },
      }).then(function (d) {
        if (d && d.ok) {
          toast("邮件配置已保存（授权码只存本机）");
          document.getElementById("mail-pass").value = "";
          refreshConnChips(d);
        } else toast("保存失败：" + ((d && d.error) || "服务桥离线"));
      });
    }, true));
    smtpBtnRow.appendChild(connBtn("发测试邮件给自己", function () {
      smtpOut.textContent = "发送中…";
      desktopApi("/connectors/test", "POST", { id: "mail" }).then(function (d) {
        smtpOut.className = "pc-test " + (d && d.ok ? "ok" : "err");
        smtpOut.textContent = (d && d.ok && d.msg) || (d && d.error) || "服务桥离线";
      });
    }));
    smtpBtnRow.appendChild(connBtn("读收件箱试试", function () {
      smtpOut.textContent = "读取中…";
      desktopApi("/connectors/action", "POST", { id: "mail", action: "read", args: { limit: 3 } }).then(function (d) {
        if (d && d.ok) {
          var lst = ((d.result && d.result.list) || []);
          smtpOut.className = "pc-test ok";
          smtpOut.textContent = "✅ 读到 " + lst.length + " 封（最新：" + (lst.length ? (lst[0].subject || "").slice(0, 24) : "空箱") + "）";
        } else {
          smtpOut.className = "pc-test err";
          smtpOut.textContent = (d && d.error) || "服务桥离线";
        }
      });
    }));
    smtpBtnRow.appendChild(smtpOut);
    smtpBody.appendChild(smtpBtnRow);
    smtpBody.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:6px;line-height:1.9">' +
      "授权码怎么拿：<b>QQ 邮箱</b> 网页版设置 → 账户 → 开启 SMTP 服务 → 生成授权码；<b>163/126</b> 设置 → POP3/SMTP → 开启；<b>Gmail</b> 需先开两步验证 → 应用密码；<b>Outlook</b> 账号安全 → 应用密码。<br>" +
      "连好后说「<b>发邮件给 xx@xx.com 主题：… 内容：…</b>」就是真实发送；说「<b>看看我的未读邮件</b>」「<b>总结一下今天的邮箱</b>」就是真实读取（IMAP 服务器自动推断，也可在保存时手动指定）。</div>");
    smtpCard.appendChild(smtpBody);
    secConn.appendChild(smtpCard);

    // —— Microsoft（官方登录；设备码备用） ——
    var msCard = el("div", "provider-card open");
    var msHead = el("div", "pc-head");
    msHead.innerHTML = '<span class="pc-name">Microsoft · Outlook 邮件 / 日历</span><span id="conn-ms-chip">' + connChip(false, "未配置") + "</span>";
    msCard.appendChild(msHead);
    var msBody = el("div", "pc-body");
    var msAdvanced = connAdvanced(msBody, connLink("获取 Client ID ↗", "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", "获取 Microsoft Client ID（打开官方应用注册）"));
    connOAuth("microsoft", "Microsoft", msBody, msAdvanced);
    msBody.appendChild(msAdvanced);
    msAdvanced.appendChild(connField("Application (client) ID", "text", "ms-clientid", "00000000-0000-0000-0000-000000000000"));
    msAdvanced.appendChild(connField("Client Secret（Web 应用）", "password", "ms-clientsecret", "Web 应用需填写；本机公共客户端留空"));
    var msRedirectRow = connField("授权回调 URI", "text", "ms-redirect-uri", "正在获取回调地址…");
    msRedirectRow.querySelector("input").readOnly = true;
    msRedirectRow.appendChild(connBtn("复制回调地址", function () {
      var input = msRedirectRow.querySelector("input");
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(function () { toast("回调地址已复制"); }, function () { input.select(); toast("请手动复制"); });
      else { input.select(); toast("请手动复制"); }
    }));
    msAdvanced.appendChild(msRedirectRow);
    var msBtnRow = el("div", "set-row");
    var msOut = el("div", "pc-test");
    msBtnRow.appendChild(connBtn("保存", function () {
      desktopApi("/connectors/save", "POST", { id: "microsoft", patch: { clientId: document.getElementById("ms-clientid").value.trim(), clientSecret: document.getElementById("ms-clientsecret").value.trim() } })
        .then(function (d) {
          if (d && d.ok) { toast("Microsoft 应用已保存"); document.getElementById("ms-clientsecret").value = ""; refreshConnChips(d); }
          else toast("保存失败：" + ((d && d.error) || "服务桥离线"));
        });
    }, true));
    msBtnRow.appendChild(connBtn("发起设备码授权", function () {
      msOut.textContent = "申请设备码中…";
      desktopApi("/connectors/microsoft/start", "POST", {}).then(function (d) {
        if (d && d.ok) {
          msOut.className = "pc-test ok";
          msOut.innerHTML = "在手机或电脑打开 <a href=\"" + (d.url || "https://microsoft.com/link") + "\" target=\"_blank\" style=\"color:var(--accent)\">" + (d.url || "microsoft.com/link") + "</a>，输入代码：<b style=\"font-size:16px\">" + (d.userCode || "") + "</b>（15 分钟内有效），输完回来点「检查授权状态」";
        } else {
          msOut.className = "pc-test err";
          msOut.textContent = (d && d.error) || "服务桥离线";
        }
      });
    }));
    msBtnRow.appendChild(connBtn("检查授权状态", function () {
      msOut.textContent = "查询中…";
      desktopApi("/connectors/microsoft/poll", "POST", {}).then(function (d) {
        if (d && d.ok && d.pending) { msOut.className = "pc-test"; msOut.textContent = "还在等你输入代码（完成浏览器登录后再点一次）"; return; }
        if (d && d.ok) {
          msOut.className = "pc-test ok";
          msOut.textContent = "✅ 微软已连接" + (d.email ? "（" + d.email + "）" : "");
          desktopApi("/connectors").then(refreshConnChips);
        } else {
          msOut.className = "pc-test err";
          msOut.textContent = (d && d.error) || "失败";
        }
      });
    }));
    msBtnRow.appendChild(msOut);
    msAdvanced.appendChild(msBtnRow);
    msAdvanced.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:6px;line-height:1.9">' +
      '① 点上方「获取 Client ID」→ 应用注册 → 新注册。需要一个可注册应用的 Microsoft Entra 租户及相应权限。<br>' +
      '② 受支持的账户类型选择支持「个人 Microsoft 账户」的选项；Lumi 当前连接个人 Outlook 账号。<br>' +
      '③ 注册后在「概述 / Overview」复制 <b>Application (client) ID</b>，不是 Object ID 或 Directory (tenant) ID。<br>' +
      '④ 本机应用：在「身份验证 / Authentication」添加「移动和桌面应用」平台及上方回调 URI，保存 ID，Client Secret 留空。云端服务：添加「Web」平台及 HTTPS 回调，并创建 Client Secret（填入 Value）。<br>⑤ 保存后点「连接 Microsoft」即可直接登录授权。设备码仅作备用，使用时另需启用 <b>Allow public client flows</b>。<br>' +
      '完成授权后，在「活动 → 应用权限」开放需要的读取/写入。<a href="https://learn.microsoft.com/entra/identity-platform/quickstart-register-app" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">Microsoft 官方注册说明 ↗</a></div>');
    msCard.appendChild(msBody);
    secConn.appendChild(msCard);

    // —— 购物（淘宝 / Amazon：无消费者下单 API → 桌面虚拟机真实操作） ——
    var aCard = el("div", "provider-card");
    var aHead = el("div", "pc-head");
    aHead.innerHTML = '<span class="pc-name">淘宝 / Amazon · 购物</span><span class="pc-status off">走虚拟机操作</span>';
    aCard.appendChild(aHead);
    var aBody = el("div", "pc-body");
    var aRow = el("div", "set-row");
    aRow.appendChild(connBtn("派 Lumi 去逛淘宝", function () {
      closeSettings();
      var inp = document.getElementById("input");
      if (inp) {
        inp.value = "在虚拟机打开淘宝网，搜索并对比我要买的东西，把最值得的加进购物车，下单前先请示我（登录用凭证安全区，或我手机扫码）";
        inp.focus();
      }
    }, true));
    aRow.appendChild(connBtn("派 Lumi 去逛 Amazon", function () {
      closeSettings();
      var inp = document.getElementById("input");
      if (inp) {
        inp.value = "在虚拟机打开 amazon.cn，搜索并对比我要买的东西，下单前先请示我（登录密码从凭证安全区引用）";
        inp.focus();
      }
    }, true));
    aBody.appendChild(aRow);
    aBody.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:6px;line-height:1.9">' +
      "淘宝和亚马逊都不向个人开放下单 API，所以不装「假接口」：Lumi 在<b>桌面虚拟机</b>的真实浏览器里替你逛、比价、加购物车——登录凭证放「凭证安全区」，付款前每一步都经 Sentinel 请示。淘宝风控较严，建议先手动扫码登录一次（登录态留在虚拟机里）。</div>");
    aCard.appendChild(aBody);
    secConn.appendChild(aCard);

    // —— Bilibili（无公开写入 API → 桌面虚拟机） ——
    var bCard = el("div", "provider-card");
    var bHead = el("div", "pc-head");
    bHead.innerHTML = '<span class="pc-name">Bilibili · 视频</span><span class="pc-status off">走虚拟机操作</span>';
    bCard.appendChild(bHead);
    var bBody = el("div", "pc-body");
    var bRow = el("div", "set-row");
    bRow.appendChild(connBtn("派 Lumi 去虚拟机开 B 站", function () {
      closeSettings();
      var inp = document.getElementById("input");
      if (inp) {
        inp.value = "在虚拟机打开 bilibili.com，帮我查这个 UP 主最近的更新并总结要点（涉及登录的操作先请示我）";
        inp.focus();
      }
    }, true));
    bBody.appendChild(bRow);
    bBody.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:6px;line-height:1.9">' +
      "B 站没有开放个人写入 API：看视频、查更新、整理清单这类事，Lumi 直接在<b>桌面虚拟机</b>的真实浏览器里做；投币/充电等账户动作会先请示。</div>");
    bCard.appendChild(bBody);
    secConn.appendChild(bCard);

    function refreshConnChips(d) {
      if (d && d.googleRedirectUri && document.getElementById("g-redirect-uri")) {
        gRedirectInput.value = d.googleRedirectUri;
        gCopyRedirect.disabled = false;
      }
      if (d && d.microsoftRedirectUri) document.getElementById("ms-redirect-uri").value = d.microsoftRedirectUri;
      if (d && d.larkRedirectUri) larkRedirectInput.value = d.larkRedirectUri;
      var c = d && d.connectors;
      if (!c) return;
      ["lark", "google", "microsoft"].forEach(function (id) {
        var state = oauthUi[id], cfg = c[id] || {};
        state.configured = id === "lark" ? !!cfg.oauthConfigured : !!cfg.configured;
        state.managed = !!cfg.managed;
        state.resultAt = cfg.authResult ? cfg.authResult.at : 0;
        state.connect.textContent = (cfg.authorized ? "重新连接 " : "连接 ") + state.name;
        if (!state.waiting) {
          state.connect.disabled = !state.configured;
          state.out.className = "pc-test " + (cfg.authorized ? "ok" : "");
          var account = cfg.accountName || cfg.email;
          state.out.textContent = cfg.authorized ? ("已连接" + (account ? " · " + account : "")) : (state.configured ? "选择账户并授权即可连接" : (id === "lark" && cfg.region === "larksuite" ? "账户授权目前支持飞书国内版，国际 Lark 可使用高级设置中的机器人模式" : "等待应用维护者完成一次性配置，配置后即可直接登录授权"));
        }
        state.disconnect.hidden = !cfg.authorized;
        state.setup.hidden = state.configured;
        var clientInput = document.getElementById(id === "lark" ? "lark-appid" : id === "google" ? "g-clientid" : "ms-clientid");
        if (document.activeElement !== clientInput && (!clientInput.value || cfg.managed)) clientInput.value = (id === "lark" ? cfg.appId : cfg.clientId) || "";
        if (id === "lark") {
          [["lark-mode",cfg.mode || "oauth"],["lark-region",cfg.region || "feishu"],["lark-scopes",cfg.oauthScopes || ""],["lark-chatid",cfg.defaultChatId || ""]].forEach(function (field) {
            var input = document.getElementById(field[0]);
            if (document.activeElement !== input && (!input.value || input.value === state.fieldValues[field[0]] || (cfg.managed && (field[0] === "lark-region" || field[0] === "lark-scopes")))) input.value = field[1];
            state.fieldValues[field[0]] = field[1];
          });
          ["lark-appid","lark-appsecret","lark-region","lark-scopes"].forEach(function (key) { document.getElementById(key).disabled = !!cfg.managed; });
        } else {
          state.advanced.querySelectorAll("input:not([readonly])").forEach(function (input) { input.disabled = !!cfg.managed; });
          state.advanced.querySelectorAll("button").forEach(function (button) { if (button.textContent === "保存") button.disabled = !!cfg.managed; });
        }
      });
      var lc = document.getElementById("conn-lark-chip");
      var gc = document.getElementById("conn-google-chip");
      if (lc) lc.innerHTML = connChip(c.lark && (c.lark.authorized || (c.lark.mode !== "oauth" && c.lark.configured)), c.lark && c.lark.authorized ? ("已连接 · " + (c.lark.accountName || "飞书账户")) : (c.lark && c.lark.configured ? (c.lark.mode === "webhook" ? "已配置 · 群机器人" : c.lark.mode === "app" ? "已配置 · 应用机器人" : "待连接") : "应用待配置"));
      if (gc) gc.innerHTML = connChip(c.google && c.google.authorized, (c.google && c.google.authorized) ? ("已授权" + (c.google.email ? " · " + c.google.email : "")) : (c.google && c.google.configured ? "待连接" : "应用待配置"));
      var mc = document.getElementById("conn-mail-chip");
      var sc = document.getElementById("conn-ms-chip");
      if (mc) mc.innerHTML = connChip(c.mail && c.mail.configured, (c.mail && c.mail.configured) ? ("已配置 · " + (c.mail.user || c.mail.host)) : "未配置");
      if (sc) sc.innerHTML = connChip(c.microsoft && c.microsoft.authorized, (c.microsoft && c.microsoft.authorized) ? ("已授权" + (c.microsoft.email ? " · " + c.microsoft.email : "")) : (c.microsoft && c.microsoft.configured ? "待连接" : "应用待配置"));
    }
    desktopApi("/connectors").then(function (d) { if (d && d.ok) refreshConnChips(d); });
    body.appendChild(secConn);

    // —— 长期记忆引擎 · Hindsight（可选 · 开源记忆系统，本地 Docker） ——
    var secHs = el("div", "set-section");
    secHs.appendChild(el("h3", "", "长期记忆引擎 · Hindsight（可选 · 数据不出本机）"));
    var hsBox = el("div");
    hsBox.style.cssText = "font-size:13px;color:var(--ink-soft);line-height:1.9";
    secHs.appendChild(hsBox);
    var hsBtns = el("div", "set-row");
    var hsPolling = false;
    function renderHs() {
      desktopApi("/memory/hindsight/status?deep=1").then(function (d) {
        if (!d || !d.ok) { hsBox.textContent = "（服务桥离线）"; hsBtns.innerHTML = ""; return; }
        hsBtns.innerHTML = "";
        var reach = d.api && d.api.reachable;
        var stateTxt = d.busy ? "⏳ 启动中…（首次拉取镜像可能需要几分钟）"
          : reach ? "✅ 运行中 · <code>" + esc(d.url) + "</code> · 记忆库 <code>" + esc(d.bank) + "</code>" + (d.version ? " · v" + esc(d.version) : "")
          : d.enabled ? "⚠️ 已启用但服务未响应" + (d.lastError ? "：" + esc(String(d.lastError).slice(0, 80)) : "")
          : "○ 未启用";
        var bits = [];
        if (d.managed) bits.push(d.docker ? "Docker ✅" : "Docker ❌（未安装或未启动）");
        else bits.push("自建服务模式（LUMEN_HINDSIGHT_URL）");
        if (d.container) bits.push("容器 " + esc(d.container));
        if (d.llm) bits.push(d.llm.ok ? "LLM 探测 ✅" : "LLM 探测 ❌ " + esc(String(d.llm.detail || "").slice(0, 50)));
        if (d.memories != null) bits.push("记忆 " + d.memories + " 条");
        hsBox.innerHTML =
          "<div>" + stateTxt + "</div>" +
          '<div style="font-size:12.5px;color:var(--ink-faint)">' + bits.join(" · ") + "</div>" +
          '<div style="font-size:12.5px;color:var(--ink-faint)">开启后：对话自动沉淀入记忆库、回答前自动召回相关记忆；「记忆」页可语义检索、深度反思、逐条遗忘。抽取事实用的模型取 <code>LUMEN_HINDSIGHT_LLM_*</code>，缺省复用 <code>LUMEN_MODEL_*</code>；数据存本地 Docker 卷 <code>lumen-hindsight-data</code>。</div>';
        if (d.uiUrl) {
          var uiA = document.createElement("a");
          uiA.className = "chip";
          uiA.textContent = "打开 Hindsight 控制台";
          uiA.href = d.uiUrl; uiA.target = "_blank"; uiA.rel = "noopener";
          hsBtns.appendChild(uiA);
        }
        if (!reach) {
          var startB = el("button", "chip solid", d.busy ? "启动中…" : (d.enabled ? "重试启动" : "启用并启动"));
          startB.type = "button";
          startB.disabled = !!d.busy;
          startB.addEventListener("click", function () {
            startB.disabled = true;
            hsBox.innerHTML = "⏳ 启动中…（首次拉取镜像可能需要几分钟，可点「刷新」看进度）";
            desktopApi("/memory/hindsight/start", "POST").then(function () {
              store.audit("启用 Hindsight 深度记忆", "Docker 容器 lumen-hindsight", "info");
              if (window.LumenHindsight) window.LumenHindsight.invalidate();
              if (hsPolling) return;
              hsPolling = true;
              var n = 0;
              var iv = setInterval(function () {
                renderHs();
                if (++n > 40) { clearInterval(iv); hsPolling = false; }
              }, 4000);
            });
          });
          hsBtns.appendChild(startB);
        } else {
          var stopB = el("button", "chip", "停止并停用");
          stopB.type = "button";
          stopB.addEventListener("click", function () {
            desktopApi("/memory/hindsight/stop", "POST").then(function () {
              store.audit("停用 Hindsight 深度记忆", "", "info");
              if (window.LumenHindsight) window.LumenHindsight.invalidate();
              renderHs();
            });
          });
          hsBtns.appendChild(stopB);
        }
        var reB = el("button", "chip", "刷新");
        reB.type = "button";
        reB.addEventListener("click", function () { renderHs(); });
        hsBtns.appendChild(reB);
      });
    }
    renderHs();
    secHs.appendChild(hsBtns);
    secHs.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:8px;line-height:1.9">' +
      "Hindsight（<a href=\"https://github.com/vectorize-io/hindsight\" target=\"_blank\" rel=\"noopener\">vectorize-io/hindsight</a>，MIT）是开源的 Agent 记忆系统：retain 抽取事实、recall 四路检索（语义/关键词/图谱/时序）、reflect 基于记忆回顾。Lumen 的接入是<b>可选层</b>——不启用时本地轻量记忆照常工作。</div>");
    body.appendChild(secHs);
    if (focus === "hindsight") secHs.scrollIntoView({ behavior: "smooth", block: "start" });

    // —— 连接器（真实能力映射 + 读写权限粒度）——
    var sec4 = el("div", "set-section");
    sec4.appendChild(el("h3", "", "连接器 · 权限粒度（可随时断开）"));
    var cr = el("div", "radio-row");
    var CONNECTOR_NAMES = { gmail: "邮件", calendar: "日历", instagram: "Instagram", whatsapp: "WhatsApp" };
    Object.keys(CONNECTOR_NAMES).forEach(function (cid) {
      var st = store.connectorState(cid);
      var wrap = el("span", "radio-row");
      wrap.style.gap = "4px";
      function pill(label, active, onClick) {
        var p = el("button", "radio-pill" + (active ? " sel" : ""), label);
        p.type = "button";
        p.style.padding = "6px 10px";
        p.style.fontSize = "12px";
        p.addEventListener("click", onClick);
        return p;
      }
      wrap.appendChild(pill((st.on ? "● " : "○ ") + CONNECTOR_NAMES[cid], st.on, function () {
        store.state.settings.connectors[cid] = { on: !st.on, read: !st.on, write: !st.on };
        store.save();
        store.audit((!st.on ? "启用" : "断开") + "连接器", CONNECTOR_NAMES[cid], "info");
        renderSettings();
      }));
      if (st.on) {
        wrap.appendChild(pill(st.read ? "可读" : "禁读", st.read, function () {
          store.state.settings.connectors[cid] = { on: true, read: !st.read, write: st.write };
          store.save();
          renderSettings();
        }));
        wrap.appendChild(pill(st.write ? "可写" : "禁写", st.write, function () {
          store.state.settings.connectors[cid] = { on: true, read: st.read, write: !st.write };
          store.save();
          renderSettings();
        }));
      }
      cr.appendChild(wrap);
    });
    sec4.appendChild(cr);
    sec4.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:8px;line-height:1.9">' +
      "邮件 / 日历：真实文件化——草稿生成 <b>.eml</b>、日程生成 <b>.ics</b>（文件页可下载，导入系统客户端即用）。<br>" +
      "Instagram / WhatsApp：经 <b>QCU 电脑操作</b>接管浏览器会话，逐步执行并请示。开关仅影响 Lumi 的作答倾向。</div>");
    body.appendChild(sec4);

    // —— 规则与审批（对标 dots Custom Rules：允许 / 先问 / 转交本人） ——
    var secRules = el("div", "set-section");
    secRules.appendChild(el("h3", "", "规则与审批 · 按动作定制"));
    var rulesBox = el("div");
    rulesBox.style.cssText = "display:flex;flex-direction:column;gap:8px";
    secRules.appendChild(rulesBox);
    var kIn = document.createElement("input");
    kIn.type = "text"; kIn.placeholder = "动作关键词（空格=同时命中，如：客户 发送）"; kIn.style.width = "200px";
    var mSel = document.createElement("select");
    [["auto", "无需询问直接做"], ["explicit", "仅当我明确提到这些动作"], ["ask", "行动前先问我"], ["handoff", "转交本人（我碰都不碰）"]].forEach(function (m) {
      var op = document.createElement("option"); op.value = m[0]; op.textContent = m[1]; mSel.appendChild(op);
    });
    var addRule = el("button", "chip", "添加规则");
    addRule.type = "button";
    addRule.addEventListener("click", function () {
      var kws = kIn.value.trim();
      if (!kws) { toast("填关键词"); return; }
      (s.rules = s.rules || []).push({ id: "rule-" + Date.now().toString(36), keywords: kws, mode: mSel.value, note: "" });
      store.save(); syncRulesToBridge(); kIn.value = "";
      store.audit("新增动作规则", kws + " → " + mSel.options[mSel.selectedIndex].text, "done");
      renderSettings();
    });
    var rRow = el("div", "set-row");
    rRow.appendChild(kIn); rRow.appendChild(mSel); rRow.appendChild(addRule);
    secRules.appendChild(rRow);
    (function renderRules() {
      rulesBox.innerHTML = "";
      var list = s.rules || [];
      if (!list.length) {
        rulesBox.innerHTML = '<div class="vm-empty" style="padding:2px">（暂无规则）示例：「支付」→ 先问我；「删除 文件」→ 转交本人。规则会同步到服务桥，Sentinel 审查动作与聊天审批时优先查规则；硬拦截（恶意站点/SSRF）永不放宽。</div>';
        return;
      }
      var MODE_NAME = { auto: "✅ 无需询问", explicit: "💬 明确指示时", ask: "⚠️ 先问我", handoff: "✋ 转交本人" };
      list.forEach(function (r, i) {
        var row = el("div", "vm-file-row");
        row.innerHTML = "<span class='nm'>📋 " + esc(r.keywords) + "</span><span class='meta'>" + (MODE_NAME[r.mode] || r.mode) + "</span>";
        var del = el("button", "chip", "删除");
        del.type = "button";
        del.addEventListener("click", function () {
          s.rules.splice(i, 1);
          store.save(); syncRulesToBridge();
          renderSettings();
        });
        row.appendChild(del);
        rulesBox.appendChild(row);
      });
    })();
    body.appendChild(secRules);

    // —— 通知（浏览器通知 + Webhook，对标 dots 主动汇报） ——
    var secNotify = el("div", "set-section");
    secNotify.appendChild(el("h3", "", "通知 · 任务完成 / 监控命中 / 等待批准"));
    var nbRow = el("div", "set-row");
    nbRow.appendChild(el("label", "", "浏览器通知"));
    var nbBtn = el("button", "radio-pill" + (s.notifyBrowser ? " sel" : ""), s.notifyBrowser ? "● 开启（任务完成弹系统通知）" : "○ 开启（任务完成弹系统通知）");
    nbBtn.type = "button";
    nbBtn.addEventListener("click", function () {
      if (!s.notifyBrowser) {
        if (!window.Notification) { toast("此浏览器不支持系统通知"); return; }
        Notification.requestPermission().then(function (p) {
          if (p !== "granted") { toast("通知权限未授予"); return; }
          s.notifyBrowser = true; store.save(); renderSettings();
        });
      } else { s.notifyBrowser = false; store.save(); renderSettings(); }
    });
    nbRow.appendChild(nbBtn);
    secNotify.appendChild(nbRow);
    var whRow = el("div", "set-row");
    var whIn = document.createElement("input");
    whIn.type = "text"; whIn.placeholder = "Webhook URL（如企业微信/钉钉/飞书机器人）"; whIn.style.width = "260px";
    desktopApi("/notify/config").then(function (c) { if (c && c.webhook) whIn.value = c.webhook; }).catch(function () {});
    var whSave = el("button", "chip", "保存");
    whSave.type = "button";
    whSave.addEventListener("click", function () {
      desktopApi("/notify/config", "POST", { webhook: whIn.value.trim() }).then(function (r) {
        if (r && r.ok) { toast(r.webhook ? "Webhook 已保存" : "Webhook 已清空"); store.audit("通知 Webhook", r.webhook ? "已配置" : "已清空", "info"); }
        else toast("保存失败");
      });
    });
    var whTest = el("button", "chip", "发条测试");
    whTest.type = "button";
    whTest.addEventListener("click", function () {
      desktopApi("/notify", "POST", { title: "Lumen 测试通知", text: "收到这条说明 Webhook 通了 ✅" }).then(function (r) {
        toast(r && r.sent ? "已发送 ✓" : "未发出：" + ((r && r.reason) || "未知"));
      });
    });
    whRow.appendChild(whIn); whRow.appendChild(whSave); whRow.appendChild(whTest);
    secNotify.appendChild(whRow);
    secNotify.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:6px;line-height:1.8">触发点：监控命中、桌面任务完成/等待批准（服务桥直接发，浏览器关着也发）；聊天任务完成（浏览器通知 + Webhook 中继）。</div>');
    body.appendChild(secNotify);

    // —— 手机访问 ——
    var secMobile = el("div", "set-section");
    secMobile.appendChild(el("h3", "", "手机访问 · 同一 WiFi 下用手机遥控"));
    var mobBox = el("div");
    mobBox.style.cssText = "font-size:13px;color:var(--ink-soft);line-height:1.9";
    secMobile.appendChild(mobBox);
    desktopApi("/lan-ips").then(function (d) {
      if (!d || !d.ok) { mobBox.textContent = "（服务桥离线）"; return; }
      if (!d.open) {
        mobBox.innerHTML = "当前只监听本机（127.0.0.1）。想让手机访问：停掉服务桥，改用<br><code>LUMEN_HOST=0.0.0.0 node server.js</code>（或 <code>sh run.sh</code> 前加 <code>LUMEN_HOST=0.0.0.0</code>）启动，然后手机连同一 WiFi 打开下面地址。";
        return;
      }
      var urls = d.urls || [];
      var qrUrl = urls[0] || "";
      var cv = el("canvas");
      var qrOk = !!(qrUrl && window.LumenQR && (function () {
        var m = window.LumenQR.encode(qrUrl);
        if (!m) return false;
        var QZ = 4, SC = 8, N = m.length; // 4 模块静区 + 8px/模块，保证扫码器识别
        cv.width = cv.height = (N + QZ * 2) * SC;
        var ctx = cv.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = "#14181d";
        for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
          if (m[r][c]) ctx.fillRect((c + QZ) * SC, (r + QZ) * SC, SC, SC);
        }
        return true;
      })());
      var html = "✅ 已开放局域网。手机连同一 WiFi，浏览器打开：" +
        urls.map(function (u, i) {
          var tag = (i === 0 && d.mdns) ? ' <span style="font-size:11px;color:var(--ink-faint)">（iPhone 直接可用）</span>' : "";
          return '<div style="font-family:ui-monospace;font-size:15px;margin:4px 0">' + u + tag + "</div>";
        }).join("");
      html += '<div id="mob-qr-row" style="display:flex;gap:16px;align-items:flex-start;margin-top:10px;flex-wrap:wrap">';
      html += '<div style="flex:1;min-width:220px">';
      html += '<div>📱 <b>iPhone</b>：' + (qrOk ? "相机扫码" : "Safari 打开上面地址") + ' → 底部「分享」→「添加到主屏幕」。之后从主屏幕图标进入即是全屏 App，不用再记地址。</div>';
      html += '<div style="margin-top:4px">🤖 安卓：Chrome 打开地址 → 菜单「添加到主屏幕」，效果相同。</div>';
      html += '<div style="font-size:12px;color:#9a6b1a;margin-top:6px">⚠ 局域网内任何设备都可访问本服务桥（含凭证安全区接口），仅在你信任的家庭/办公 WiFi 下开放。</div>';
      html += "</div></div>";
      mobBox.innerHTML = html;
      if (qrOk) {
        cv.style.cssText = "width:148px;height:148px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.35);display:block";
        var wrap = document.createElement("div");
        wrap.style.cssText = "flex:none;text-align:center";
        wrap.appendChild(cv);
        wrap.insertAdjacentHTML("beforeend", '<div style="font-size:11.5px;color:var(--ink-faint);margin-top:4px">相机扫码直达</div>');
        mobBox.querySelector("#mob-qr-row").insertBefore(wrap, mobBox.querySelector("#mob-qr-row").firstChild);
      }
    }).catch(function () { mobBox.textContent = "（服务桥离线）"; });
    body.appendChild(secMobile);

    // —— 虚拟计算机（LumenBox）——
    var secVm = el("div", "set-section");
    secVm.appendChild(el("h3", "", "虚拟计算机 · Lumi 自己的电脑（不碰你的本机）"));
    var vmRow1 = el("div", "set-row");
    vmRow1.appendChild(el("label", "", "上网任务"));
    var vmFirstBtn = el("button", "radio-pill" + (s.vmFirst !== false ? " sel" : ""), s.vmFirst !== false ? "● 优先在虚拟计算机" : "○ 优先在虚拟计算机");
    vmFirstBtn.type = "button";
    vmFirstBtn.addEventListener("click", function () {
      s.vmFirst = s.vmFirst === false ? true : false;
      store.save();
      store.audit("虚拟计算机设置", s.vmFirst !== false ? "上网任务默认在虚拟计算机执行" : "上网任务改走 QCU 真机流", "info");
      renderSettings();
    });
    vmRow1.appendChild(vmFirstBtn);
    secVm.appendChild(vmRow1);
    var vmRow2 = el("div", "set-row");
    vmRow2.appendChild(el("label", "", "虚拟终端"));
    var vmShellBtn = el("button", "radio-pill" + (s.vmShell ? " sel" : ""), s.vmShell ? "● 开启（软沙箱）" : "○ 开启（软沙箱）");
    vmShellBtn.type = "button";
    vmShellBtn.addEventListener("click", function () {
      if (!s.vmShell && !window.confirm("开启虚拟终端？它是软沙箱：命令真实运行于本机，仅工作目录与 HOME 被限制在 vm-home/，并非系统级隔离。")) return;
      s.vmShell = !s.vmShell;
      store.save();
      store.audit("虚拟终端 " + (s.vmShell ? "开启" : "关闭"), s.vmShell ? "软沙箱，目录受限" : "", "info");
      renderSettings();
    });
    vmRow2.appendChild(vmShellBtn);
    secVm.appendChild(vmRow2);

    // —— 桌面虚拟机模式（LumenBox Desktop） ——
    var vmRow3 = el("div", "set-row");
    vmRow3.appendChild(el("label", "", "桌面虚拟机"));
    var DT_MODES = [
      ["auto", "自动（GUI 任务用）"],
      ["always", "总是优先"],
      ["off", "关闭"],
    ];
    DT_MODES.forEach(function (m2) {
      var cur = s.vmDesktop || "auto";
      var p2 = el("button", "radio-pill" + (cur === m2[0] ? " sel" : ""), m2[1]);
      p2.type = "button";
      p2.addEventListener("click", function () {
        s.vmDesktop = m2[0];
        store.save();
        store.audit("桌面虚拟机模式", m2[1], "info");
        renderSettings();
      });
      vmRow3.appendChild(p2);
    });
    secVm.appendChild(vmRow3);

    // —— 凭证安全区（值只进不出，模型看不到明文） ——
    var vaultBox = el("div");
    vaultBox.style.marginTop = "10px";
    vaultBox.appendChild(el("div", "set-row", "<b>凭证安全区</b><span style='font-size:12px;color:var(--ink-faint)'>（值加密存于本机 0600 文件；API 永不回传，代理获批后由服务桥直注虚拟机）</span>"));
    var vaultList = el("div", "vm-files");
    vaultList.style.margin = "6px 0";
    vaultBox.appendChild(vaultList);
    var vName = document.createElement("input");
    vName.type = "text"; vName.placeholder = "名称（如：淘宝密码）"; vName.style.width = "130px";
    var vKind = document.createElement("select");
    ["密码", "卡号", "文本"].forEach(function (k) {
      var op = document.createElement("option"); op.value = k; op.textContent = k; vKind.appendChild(op);
    });
    var vVal = document.createElement("input");
    vVal.type = "password"; vVal.placeholder = "值（保存后不再显示）"; vVal.style.width = "150px";
    var vAdd = el("button", "chip", "存入安全区");
    vAdd.type = "button";
    vAdd.addEventListener("click", function () {
      if (!vName.value.trim() || !vVal.value) { toast("名称与值都要填"); return; }
      desktopApi("/vm/vault/set", "POST", { name: vName.value.trim(), kind: vKind.value, value: vVal.value }).then(function (r) {
        if (r && r.ok) {
          store.audit("安全区写入凭证", vName.value.trim() + "（值不留痕）", "info");
          vName.value = ""; vVal.value = "";
          toast("已存入安全区（明文永不可见）");
          renderVault();
        } else toast("保存失败：" + (r && r.error || ""));
      });
    });
    var vRow = el("div", "set-row");
    vRow.appendChild(vName); vRow.appendChild(vKind); vRow.appendChild(vVal); vRow.appendChild(vAdd);
    vaultBox.appendChild(vRow);

    function renderVault() {
      desktopApi("/vm/vault").then(function (d) {
        vaultList.innerHTML = "";
        var items = (d && d.vault) || [];
        if (!items.length) {
          vaultList.innerHTML = '<div class="vm-empty" style="padding:2px">（空）支付/登录时，Lumi 会请求引用这里的凭证；获批后由服务桥注入，模型全程看不到值。</div>';
          return;
        }
        items.forEach(function (it) {
          var row = el("div", "vm-file-row");
          row.innerHTML = "<span class='nm'>🔐 " + esc(it.name) + "</span><span class='meta'>" + esc(it.kind) + "</span>";
          var del = el("button", "chip", "删除");
          del.type = "button";
          del.addEventListener("click", function () {
            desktopApi("/vm/vault/del", "POST", { name: it.name }).then(function () {
              store.audit("安全区删除凭证", it.name, "info");
              renderVault();
            });
          });
          row.appendChild(del);
          vaultList.appendChild(row);
        });
      });
    }
    renderVault();
    secVm.appendChild(vaultBox);

    secVm.insertAdjacentHTML("beforeend",
      '<div style="font-size:12.5px;color:var(--ink-faint);margin-top:8px;line-height:1.9">' +
      "Lumi 上网检索、阅读、存笔记都在<b>自己的虚拟计算机</b>（服务桥内的虚拟浏览器 + 囚笼工作区 <code>vm-home/</code>）里完成，不需要也不应该动你的电脑。<br>" +
      "关掉「优先在虚拟计算机」或对它说「用我的电脑……」时，才走 QCU 真机操作（每步请示）。终端默认关闭，且为<b>软沙箱</b>（进程仍在本机运行，仅目录受限），追求硬隔离可设环境变量 <code>LUMEN_VM_SHELL=0</code> 彻底禁用。</div>");
    body.appendChild(secVm);

    // —— 用量计（模型用量统计）——
    var secUsage = el("div", "set-section");
    secUsage.appendChild(el("h3", "", "用量计 · 模型调用统计（近似 token，中文约 1.7 字/token）"));
    var u = store.state.usage;
    var today = new Date().toISOString().slice(0, 10);
    var days = Object.keys(u.byDay).sort().reverse().slice(0, 7);
    var usageHtml = "<div style='font-size:13.5px;line-height:2;color:var(--ink-soft)'>" +
      "累计调用 <b>" + u.calls + "</b> 次 · 累计约 <b>" + Math.round((u.inChars + u.outChars) / 1.7 / 10000) / 10 + " 万</b> token（今日约 <b>" + (u.byDay[today] || 0) + "</b>）</div>";
    if (days.length) {
      var max = Math.max.apply(null, days.map(function (d) { return u.byDay[d] || 0; })) || 1;
      usageHtml += days.map(function (d) {
        var v = u.byDay[d] || 0;
        var w = Math.max(3, Math.round((v / max) * 100));
        return "<div style='display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink-faint);margin:2px 0'>" +
          "<span style='width:74px'>" + d.slice(5) + "</span>" +
          "<span style='flex:1;height:8px;border-radius:4px;background:rgba(111,163,194,.15);overflow:hidden'>" +
          "<i style='display:block;height:100%;width:" + w + "%;background:linear-gradient(90deg,var(--water),var(--lily))'></i></span>" +
          "<span style='width:60px;text-align:right'>" + v + "</span></div>";
      }).join("");
    }
    secUsage.insertAdjacentHTML("beforeend", usageHtml);
    body.appendChild(secUsage);

    // —— 审计日志 ——
    var sec5 = el("div", "set-section");
    sec5.appendChild(el("h3", "", "审计日志 · 代理做过什么、凭什么做的"));
    var al = el("div", "audit-list");
    var logs = store.state.audit.slice().reverse().slice(0, 80);
    if (!logs.length) {
      al.innerHTML = '<div style="padding:10px;color:var(--ink-faint);font-size:13px">暂无记录。代理的每一步都会在这里留痕。</div>';
    }
    logs.forEach(function (a) {
      var status = { approved: "a-ok", denied: "a-deny", auto: "a-auto" }[a.status] || "";
      var statusText = { approved: "· 已批准", denied: "· 已拒绝", auto: "· 自动放行", info: "", done: "· 完成" }[a.status] || "";
      al.insertAdjacentHTML("beforeend",
        '<div class="audit-item"><time>' + new Date(a.t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + "</time>" +
        "<span><span class=\"a-act\">" + esc(a.action) + "</span>" + (a.detail ? " — " + esc(a.detail) : "") +
        ' <span class="' + status + '">' + statusText + "</span></span></div>");
    });
    sec5.appendChild(al);
    body.appendChild(sec5);

    // —— 数据 ——
    var sec6 = el("div", "set-section");
    sec6.appendChild(el("h3", "", "数据"));
    var dr = el("div", "set-row");
    var exportBtn = el("button", "chip", "导出全部数据（JSON）");
    exportBtn.type = "button";
    exportBtn.addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(store.state, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "lumen-data.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    var resetBtn = el("button", "chip", "清空本地数据");
    resetBtn.type = "button";
    resetBtn.style.borderColor = "rgba(194,96,122,.4)";
    resetBtn.style.color = "var(--danger)";
    resetBtn.addEventListener("click", function () {
      if (!window.confirm("确定清空所有对话、目标、文件与设置？此操作不可恢复。")) return;
      store.resetAll();
      liveMsgs = {}; // 放开对旧 state（含画作 dataURL）的引用，允许 GC
      closeSettings();
      updateIdentity();
      renderChat();
      updateBadges();
      toast("已恢复初始状态");
    });
    dr.appendChild(exportBtn);
    dr.appendChild(resetBtn);
    sec6.appendChild(dr);
    body.appendChild(sec6);
  }

  function openSettings(focus) {
    renderSettings(focus || "");
    $("#settings-modal").hidden = false;
  }
  function closeSettings() { $("#settings-modal").hidden = true; }

  // ———————————————————————————— 事件绑定 ————————————————————————————

  function bindGlobal() {
    document.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        switchTab(btn.getAttribute("data-tab"));
      });
    });
    $("#btn-settings").addEventListener("click", function () { openSettings(); });
    $("#btn-close-settings").addEventListener("click", closeSettings);
    $("#settings-modal").addEventListener("click", function (e) {
      if (e.target === $("#settings-modal")) closeSettings();
    });
    $("#btn-close-viewer").addEventListener("click", closeViewer);
    $("#viewer-modal").addEventListener("click", function (e) {
      if (e.target === $("#viewer-modal")) closeViewer();
    });
    $("#model-chip").addEventListener("click", function (e) {
      e.stopPropagation();
      var pop = $("#model-popover");
      if (pop.hidden) renderModelPopover(); else closePopover();
    });
    document.addEventListener("click", function (e) {
      var pop = $("#model-popover");
      if (!pop.hidden && !pop.contains(e.target) && e.target !== $("#model-chip")) closePopover();
    });
    $("#btn-history").addEventListener("click", function (e) {
      e.stopPropagation();
      var pop = $("#model-popover");
      if (pop.hidden) renderHistoryPopover(); else closePopover();
    });
    var sideVer = document.querySelector("#side-ver");
    if (sideVer) sideVer.addEventListener("click", function () { openSettings(); });
    $("#btn-add-goal").addEventListener("click", openAddGoal);
    $("#btn-add-memory").addEventListener("click", openAddMemory);
    var vmRefresh = $("#btn-vm-refresh");
    if (vmRefresh) vmRefresh.addEventListener("click", function () { renderVm(true); });
    // Feed 卡片的委托点击（绑一次即可，renderFeed 重渲染不影响）
    $("#feed-list").addEventListener("click", function (e) {
      var t = e.target.closest("[data-task]");
      if (t) { send(t.getAttribute("data-task")); return; }
      var of = e.target.closest("[data-open-file]");
      if (of) { openViewer(of.getAttribute("data-open-file")); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeSettings(); closeViewer(); closePopover(); }
    });
    // 弹窗滚轮死区修复：鼠标悬停在标题栏/卡片间隙时，滚轮转发给正文滚动区
    // （此前可滚动区只有 modal-body，指针落在弹窗其他位置时滚轮毫无反应）
    document.querySelectorAll(".modal-card").forEach(function (card) {
      card.addEventListener("wheel", function (e) {
        var body = card.querySelector(".modal-body");
        if (!body || body.contains(e.target)) return; // 在正文上：浏览器原生处理
        var max = body.scrollHeight - body.clientHeight;
        if (max <= 0) return;
        body.scrollTop = Math.max(0, Math.min(max, body.scrollTop + e.deltaY));
      }, { passive: true });
    });
  }

  // ———————————————————————————— 启动 ————————————————————————————

  function init() {
    injectGrain();
    store.activeConversation(); // 确保至少有一个会话
    updateIdentity();
    bindComposer();
    bindGlobal();
    renderChat();
    switchTab("chat");
    updateStatus();
    updateBadges();
    loadSkills(); // 异步连接本地服务桥的技能库，失败则技能页显示引导
    window.addEventListener("lumen-save-failed", function () {
      toast("⚠️ 本地存储空间不足，最新数据可能未保存（可到文件页删除大画作）");
    });
    store.audit("Lumen 启动", window.LumenAI.current() ? "已连接模型" : "演示模式", "info");
  }

  window.LumenUI = { init: init, send: send, switchTab: switchTab, taskHooks: hooks, markdown: md, refreshIdentity: updateIdentity };
})();
