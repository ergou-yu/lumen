/* ============================================================
   store.js —— Lumen 状态持久化（localStorage）
   所有数据只存在用户本机：对话、目标、文件、审计日志、模型配置。
   ============================================================ */
(function () {
  "use strict";

  var KEY = "lumen-state-v1";

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function defaults() {
    return {
      settings: {
        agentName: "Lumi",
        autonomy: "sensitive", // ask=每次都问 | sensitive=仅敏感操作 | auto=全自动
        activeProvider: "",    // 空 = 演示模式
        activeModel: "",
        providers: {},         // id -> {apiKey, baseUrl, model}
        interests: ["ai", "art", "life"],
        connectors: { gmail: false, calendar: false, instagram: false, whatsapp: false },
        skills: {},             // 技能 id -> enabled（缺省视为启用）
        tone: "monet",          // 说话方式：monet 温柔印象派 | pro 简洁高效 | warm 热心絮叨
        avatarId: "avatar-1",   // 头像：avatar-1/2/3
        speakReplies: false,    // 朗读回复（语音模式输出侧）
      },
      conversations: [],
      activeConvId: "",
      goals: [],
      files: [],
      memories: [],            // 长期记忆：{id, text, kind, time, source}
      usage: { calls: 0, inChars: 0, outChars: 0, byDay: {} }, // 模型用量计
      audit: [],
      alwaysAllow: {},        // 动作类型 -> true（「总是允许」记忆）
      feedSeen: 0,            // 动态卡片已读水位
      lastBriefDate: "",      // 每日简报去重
    };
  }

  var state = defaults();

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      // 浅合并默认值，保证旧数据在新版本字段缺失时也能跑
      state = Object.assign(defaults(), saved);
      state.settings = Object.assign(defaults().settings, saved.settings || {});
    } catch (e) {
      console.warn("Lumen: 本地状态读取失败，使用初始状态", e);
    }
  }

  var saveTimer = null;
  var saveFailedNotified = false;
  function save() {
    // 防抖写盘：任务流式更新时每帧都 save 会卡
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        // 审计日志只留最近 300 条，防止无限膨胀
        if (state.audit.length > 300) state.audit = state.audit.slice(-300);
        localStorage.setItem(KEY, JSON.stringify(state));
        saveFailedNotified = false;
      } catch (e) {
        console.warn("Lumen: 状态保存失败", e);
        // 配额溢出等持续失败只提醒一次（例如生成画作过大占满 localStorage）
        if (!saveFailedNotified) {
          saveFailedNotified = true;
          try {
            window.dispatchEvent(new CustomEvent("lumen-save-failed"));
          } catch (e2) {}
        }
      }
    }, 250);
  }

  // —— 审计日志：「代理做过什么、打算做什么」的完整台账 ——
  function audit(action, detail, status) {
    state.audit.push({
      t: Date.now(),
      action: action,
      detail: detail || "",
      status: status || "done", // done | approved | denied | auto | info
    });
    save();
  }

  // —— 会话 ——
  function newConversation(title) {
    var conv = {
      id: uid(),
      title: title || "新对话",
      createdAt: Date.now(),
      messages: [], // {id, role:'user'|'agent'|'activity'|'approval', ...}
    };
    state.conversations.unshift(conv);
    state.activeConvId = conv.id;
    save();
    return conv;
  }

  function activeConversation() {
    for (var i = 0; i < state.conversations.length; i++) {
      if (state.conversations[i].id === state.activeConvId) return state.conversations[i];
    }
    if (state.conversations.length) {
      state.activeConvId = state.conversations[0].id;
      return state.conversations[0];
    }
    return newConversation("新的开始");
  }

  function addMessage(msg) {
    var conv = activeConversation();
    return addMessageTo(conv.id, msg);
  }

  // 指定会话内追加消息：任务运行期间用户切了新会话，旧任务仍写回自己的会话
  function addMessageTo(convId, msg) {
    msg.id = msg.id || uid();
    msg.time = Date.now();
    var conv = null;
    for (var i = 0; i < state.conversations.length; i++) {
      if (state.conversations[i].id === convId) conv = state.conversations[i];
    }
    if (!conv) return msg; // 会话已被清空：返回带 id 的消息，避免下游以 undefined 为键
    conv.messages.push(msg);
    if (conv.title === "新对话" && msg.role === "user") {
      conv.title = (msg.text || "").slice(0, 18) || "新对话";
    }
    save();
    return msg;
  }

  function findMessage(convId, id) {
    for (var i = 0; i < state.conversations.length; i++) {
      if (state.conversations[i].id !== convId) continue;
      var msgs = state.conversations[i].messages;
      for (var j = 0; j < msgs.length; j++) {
        if (msgs[j].id === id) return msgs[j];
      }
    }
    return null;
  }

  function updateMessage(id, patch) {
    var conv = activeConversation();
    return updateMessageIn(conv.id, id, patch);
  }

  function updateMessageIn(convId, id, patch) {
    var m = findMessage(convId, id);
    if (m) { Object.assign(m, patch); save(); }
    return m;
  }

  function getMessage(id) {
    var conv = activeConversation();
    for (var i = 0; i < conv.messages.length; i++) {
      if (conv.messages[i].id === id) return conv.messages[i];
    }
    return null;
  }

  // —— 目标 ——
  function addGoal(goal) {
    var g = {
      id: uid(),
      title: goal.title,
      steps: (goal.steps || []).map(function (s) {
        return typeof s === "string" ? { text: s, done: false } : s;
      }),
      createdAt: Date.now(),
      source: goal.source || "manual",
    };
    state.goals.unshift(g);
    save();
    return g;
  }

  function goalProgress(g) {
    if (!g.steps.length) return 0;
    var done = g.steps.filter(function (s) { return s.done; }).length;
    return Math.round((done / g.steps.length) * 100);
  }

  function toggleGoalStep(goalId, idx) {
    for (var i = 0; i < state.goals.length; i++) {
      if (state.goals[i].id === goalId) {
        var st = state.goals[i].steps[idx];
        if (st) {
          st.done = !st.done;
          save();
        }
        return;
      }
    }
  }

  function removeGoal(goalId) {
    state.goals = state.goals.filter(function (g) { return g.id !== goalId; });
    save();
  }

  // —— 文件 ——
  function addFile(file) {
    var f = {
      id: uid(),
      kind: file.kind || "doc", // doc | art | reminder
      title: file.title || "未命名",
      body: file.body || "",
      dataURL: file.dataURL || "",
      createdAt: Date.now(),
      source: file.source || "lumi",
    };
    state.files.unshift(f);
    save();
    return f;
  }

  function removeFile(id) {
    state.files = state.files.filter(function (f) { return f.id !== id; });
    save();
  }

  // —— 长期记忆（越用越懂你，可查看/编辑/遗忘）——
  function addMemory(text, kind, source) {
    text = String(text || "").trim().slice(0, 140);
    if (!text) return null;
    // 简单去重：与任一现有记忆高度重叠（前 10 字相同）则跳过
    var head = text.slice(0, 10);
    for (var i = 0; i < state.memories.length; i++) {
      if (state.memories[i].text.slice(0, 10) === head) return null;
    }
    var m = { id: uid(), text: text, kind: kind || "事实", time: Date.now(), source: source || "conversation" };
    state.memories.unshift(m);
    if (state.memories.length > 100) state.memories = state.memories.slice(0, 100);
    save();
    return m;
  }

  function updateMemory(id, text) {
    for (var i = 0; i < state.memories.length; i++) {
      if (state.memories[i].id === id) {
        state.memories[i].text = String(text || "").trim().slice(0, 140);
        save();
        return;
      }
    }
  }

  function removeMemory(id) {
    state.memories = state.memories.filter(function (m) { return m.id !== id; });
    save();
  }

  // —— 用量计（近似：中文 ~1.7 字/token）——
  function addUsage(inChars, outChars) {
    var day = new Date().toISOString().slice(0, 10);
    state.usage.calls += 1;
    state.usage.inChars += inChars | 0;
    state.usage.outChars += outChars | 0;
    state.usage.byDay[day] = (state.usage.byDay[day] || 0) + Math.round(((inChars + outChars) / 1.7));
    save();
  }

  // —— 连接器权限（bool 兼容升级为 {on, read, write}）——
  function connectorState(cid) {
    var c = state.settings.connectors[cid];
    if (c === true) return { on: true, read: true, write: true };
    if (c === false || c === undefined || c === null) return { on: false, read: false, write: false };
    return { on: !!c.on, read: !!c.read, write: !!c.write };
  }

  function resetAll() {
    state = defaults();
    try { localStorage.removeItem(KEY); } catch (e) {}
    save();
  }

  load();

  window.LumenStore = {
    get state() { return state; },
    save: save,
    audit: audit,
    uid: uid,
    newConversation: newConversation,
    activeConversation: activeConversation,
    addMessage: addMessage,
    addMessageTo: addMessageTo,
    updateMessage: updateMessage,
    updateMessageIn: updateMessageIn,
    findMessage: findMessage,
    getMessage: getMessage,
    addGoal: addGoal,
    goalProgress: goalProgress,
    toggleGoalStep: toggleGoalStep,
    removeGoal: removeGoal,
    addFile: addFile,
    removeFile: removeFile,
    addMemory: addMemory,
    updateMemory: updateMemory,
    removeMemory: removeMemory,
    addUsage: addUsage,
    connectorState: connectorState,
    resetAll: resetAll,
  };
})();
