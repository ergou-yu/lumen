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
  window.LumenBridgeBase = BRIDGE_CANDIDATES[BRIDGE_CANDIDATES.length - 1];
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

  // —— 头像预置（莫奈真迹三选一）——
  var AVATARS = { "avatar-1": "assets/avatar-1.jpg", "avatar-2": "assets/avatar-2.jpg", "avatar-3": "assets/avatar-3.jpg" };
  function applyAvatar() {
    var s = store.state.settings;
    var src = AVATARS[s.avatarId] || AVATARS["avatar-1"];
    $("#agent-avatar").innerHTML = '<img src="' + src + '" alt="">';
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
    $("#model-chip").textContent = cur ? (cur.model + " · " + cur.name.split(" ")[0] + " ▾") : "演示模式 ▾";
  }

  function updateStatus() {
    var n = window.LumenAgent.running;
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
    if (!text) return;
    // 移除欢迎屏（若在）
    var list = $("#chat-list");
    var w = list.querySelector(".welcome");
    if (w) w.remove();
    var m = store.addMessage({ role: "user", text: text });
    var node = messageNode(m);
    msgDom[m.id] = node;
    list.appendChild(node);
    scrollBottom(true);
    $("#input").value = "";
    autosize();
    window.LumenAgent.runTask(text, hooks);
    if (currentTab !== "chat") switchTab("chat"); // 已在聊天页时不重放转场动画
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

  function bindComposer() {
    var ta = $("#input");
    ta.addEventListener("input", autosize);
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

    var demo = el("button", "pop-item" + (cur ? "" : " sel"));
    demo.type = "button";
    demo.innerHTML = "🪄 演示模式<span class=\"m-prov\">本地引擎</span>";
    demo.addEventListener("click", function () {
      store.state.settings.activeProvider = "";
      store.state.settings.activeModel = "";
      store.save();
      updateModelChip();
      closePopover();
      toast("已切换到演示模式");
    });
    pop.appendChild(demo);

    var readyCount = 0;
    Object.keys(window.LumenAI.PRESETS).forEach(function (pid) {
      if (!window.LumenAI.isReady(pid)) return;
      readyCount++;
      var cfg = window.LumenAI.providerConfig(pid);
      pop.appendChild(el("div", "pop-group", esc(cfg.name)));
      var models = cfg.models.slice();
      if (cfg.model && models.indexOf(cfg.model) === -1) models.unshift(cfg.model);
      models.forEach(function (mo) {
        var sel = cur && store.state.settings.activeProvider === pid && store.state.settings.activeModel === mo;
        var item = el("button", "pop-item" + (sel ? " sel" : ""));
        item.type = "button";
        item.innerHTML = esc(mo) + "<span class=\"m-prov\">" + (sel ? "● 使用中" : "") + "</span>";
        item.addEventListener("click", function () {
          store.state.settings.activeProvider = pid;
          store.state.settings.activeModel = mo;
          store.save();
          updateModelChip();
          closePopover();
          toast("已切换到 " + mo);
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

  var DESK_STATE = {
    running: ["运行中", ""],
    starting: ["启动中…", "off"],
    building: ["构建镜像中…", "off"],
    stopped: ["已停止", "off"],
    nodocker: ["Docker 未运行", "off"],
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

    var liveWrap = el("div", "vm-live");
    liveWrap.hidden = true;
    card.appendChild(liveWrap);

    var tasksBox = el("div", "vm-tasks");
    card.appendChild(tasksBox);

    card.insertAdjacentHTML("beforeend",
      '<div class="vm-note" style="margin-top:10px">容器里是一台完整的 Linux 桌面 + 真实浏览器，Cookie 与历史保存在私有卷；每个动作都经宿主 <b>Sentinel</b> 审查（放行 / 阻止 / 请示你批准）。你可以在 Live 画面里随时接管——亲手操作时，Lumi 的下一步会先重新观察再动作。</div>');

    box.appendChild(card);
    vmDeskNodes = { card: card, chip: chip, statusLine: statusLine, toolbar: toolbar, liveWrap: liveWrap, tasksBox: tasksBox };

    refreshVmDesktop(true);
  }

  function refreshVmDesktop(first) {
    if (!vmDeskNodes) return;
    desktopApi("/vm/desktop/status").then(function (st) {
      if (!vmDeskNodes) return;
      window.LumenDesktop.available = !!(st && st.daemon);
      window.LumenDesktop.imageReady = !!(st && st.imageReady);
      var state = st && st.daemon ? (st.state || "stopped") : "nodocker";
      var pair = DESK_STATE[state] || DESK_STATE.unknown;
      vmDeskNodes.chip.textContent = pair[0];
      vmDeskNodes.chip.className = "vm-tag" + (pair[1] ? " " + pair[1] : "");

      var img = st && st.imageReady;
      vmDeskNodes.statusLine.innerHTML =
        "Docker：" + (st && st.daemon ? "✅ " + String(st.daemon).slice(0, 14) : "❌ 未运行（打开 Docker Desktop）") +
        " · 镜像：" + (img ? "✅ lumen-box" : "⏳ 未构建（首次启动会自动构建）") +
        (st && st.ports ? " · 端口 " + st.ports.http + "/" + st.ports.vnc : "");

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
      } else if (st && st.daemon) {
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
      if (st && st.state === "running" && st.novncUrl) {
        vmDeskNodes.liveWrap.hidden = false;
        if (!vmDeskNodes.liveWrap.querySelector("iframe")) {
          var bar = el("div", "vm-live-bar", "实时画面（可接管：直接在画面里操作鼠标键盘）");
          var frame = document.createElement("iframe");
          frame.src = st.novncUrl;
          frame.setAttribute("allow", "clipboard-read; clipboard-write");
          vmDeskNodes.liveWrap.appendChild(bar);
          vmDeskNodes.liveWrap.appendChild(frame);
        }
      } else {
        vmDeskNodes.liveWrap.hidden = true;
      }

      // 任务列表
      desktopApi("/vm/desktop/tasks").then(function (d) {
        if (!vmDeskNodes) return;
        var list = (d && d.tasks) || [];
        var box2 = vmDeskNodes.tasksBox;
        box2.innerHTML = "";
        if (!list.length) return;
        box2.appendChild(el("div", "vm-card-head", "📋 桌面任务 · " + list.length + "（服务端执行，关页不中断）"));
        list.slice(0, 5).forEach(function (t) {
          var row = el("div", "vm-task");
          var stChip = { running: "● 执行中", waiting_approval: "⚠ 待批准", done: "✓ 完成", failed: "✗ 失败", stopped: "⏹ 已停止", queued: "…排队" }[t.status] || t.status;
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
          } else if (t.status === "running" || t.status === "waiting_approval" || t.status === "queued") {
            var stopT = el("button", "chip", "停止任务");
            stopT.type = "button";
            stopT.style.marginTop = "6px";
            stopT.addEventListener("click", function () {
              desktopApi("/vm/desktop/tasks/" + t.id + "/stop", "POST", {}).then(function () { refreshVmDesktop(); });
            });
            row.appendChild(stopT);
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
          var rm = el("button", "chip", "删除");
          rm.type = "button";
          rm.addEventListener("click", function () {
            vmApi("files", "rm", { name: f.name }).then(function () {
              store.audit("虚拟计算机 · 删除文件", f.name, "info");
              renderVm();
            });
          });
          row.appendChild(dl);
          row.appendChild(rm);
          fl.appendChild(row);
        });
        fc.appendChild(fl);
      } else {
        fc.appendChild(el("div", "vm-empty", "工作区是空的。Lumi 浏览后会把笔记存到这里（notes/）。"));
      }
      box.appendChild(fc);

      // —— 虚拟终端 ——
      var tc = el("div", "vm-card");
      var shellOn = !!store.state.settings.vmShell && d.shell.enabled;
      tc.appendChild(el("div", "vm-card-head", "⌨ 虚拟终端" +
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
        term.appendChild(el("div", "vm-empty", "终端默认关闭。它是软沙箱：进程真实运行于本机，仅工作目录与 HOME 被钉在 vm-home/——请到 设置 → 虚拟计算机 里了解边界后再开启。"));
      }
      tc.appendChild(term);
      box.appendChild(tc);

      // —— 说明与清空 ——
      var nc = el("div", "vm-card");
      nc.appendChild(el("div", "vm-card-head", "🛡 隔离边界"));
      nc.insertAdjacentHTML("beforeend",
        '<div class="vm-note">这台「电脑」属于 Lumi 自己：虚拟浏览器与检索在服务桥进程内完成，文件被严格囚在 <code>vm-home/</code>（路径穿越一律拒绝）——<b>浏览与存档不碰你的本机</b>。终端是可选的软沙箱（进程仍在本机运行，仅目录受限），默认关闭。需要 Lumi 操控你的真实电脑时，明确说「用我的电脑……」，它会改走 QCU 并逐步请示。</div>');
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
      return;
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

    // 头像（莫奈真迹三选一）
    sec1.appendChild(el("h3", "", "形象"));
    var avRow = el("div", "radio-row");
    Object.keys(AVATARS).forEach(function (aid) {
      var img = document.createElement("img");
      img.src = AVATARS[aid];
      img.style.cssText = "width:52px;height:52px;border-radius:50%;object-fit:cover;cursor:pointer;border:3px solid " +
        (s.avatarId === aid ? "var(--water-deep)" : "transparent");
      img.title = aid;
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

      // 本地网关卡片：实时探测网关状态，把环境变量里配置的模型直接亮出来
      // （卡片状态显示「已就绪 · GLM-5.3」这类字样，一眼认出网关在跑什么模型）
      if (pid === "localgw") {
        fetch(bridgeBase() + "/v1/models").then(function (r) { return r.json(); }).then(function (d) {
          var models = ((d && d.data) || []).map(function (m) { return m.id; });
          if (!models.length) return;
          var chipEl = card.querySelector(".pc-status");
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

  window.LumenUI = { init: init };
})();
