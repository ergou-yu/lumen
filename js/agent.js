/* ============================================================
   agent.js —— 代理引擎（任务编排与审批核心）
   · classify：从用户话语里识别意图
   · buildPlan：把任务拆成可见的执行步骤（含浏览器的「小剧场」）
   · 审批闸门：关键动作前暂停，等待 允许一次/总是允许/拒绝
   · 双引擎：接入真实模型则流式调用；未接入则本地演示引擎接管
   · 副作用：从对话中沉淀目标、生成文件，全程写入审计日志
   ============================================================ */
(function () {
  "use strict";

  var store = window.LumenStore;
  var BRIDGE = "http://127.0.0.1:8787"; // 兜底基址；同源运行时会被 ui.js 的探测结果覆盖

  // —— QCU 执行桥：受控调用本机 qcu CLI ——
  function qcuExec(argv, task) {
    var base = bridgeBase();
    return fetch(base + "/qcu/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ argv: argv }),
      signal: task ? task.controller.signal : undefined,
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  // 从观察输出里提取一个「界面概况」摘要给活动卡与模型看
  function digestObservation(stdout) {
    var text = String(stdout || "");
    var lines = text.split("\n").filter(function (l) { return l.trim(); });
    var sample = lines.slice(0, 6).map(function (l) { return l.trim().slice(0, 90); });
    return {
      lineCount: lines.length,
      chars: text.length,
      sample: sample.join(" ｜ "),
    };
  }

  // —— 虚拟计算机执行桥（LumenBox）：Lumi 自己的电脑，浏览不碰用户本机 ——
  function vmExec(tool, op, args, task) {
    var s = store.state.settings;
    return fetch(bridgeBase() + "/vm/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: tool, op: op, args: args || {},
        shellEnabled: tool === "shell" ? !!s.vmShell : undefined,
      }),
      signal: task ? task.controller.signal : undefined,
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  // computer 意图选路：默认在虚拟计算机上干（「代理自己的电脑」），
  // 只有用户点名本机 / 设置里关掉虚拟机优先时才走 QCU 操控真机
  function preferVm(text) {
    if (store.state.settings.vmFirst === false) return false;
    return !/我的电脑|这台电脑|本机|真机|系统设置|访达|Finder/.test(String(text || ""));
  }

  // 桌面虚拟机（LumenBox Desktop）优先判定：GUI 型任务（网站/登录/下单/表单）或「总是」
  function desktopPreferred(text) {
    var s = store.state.settings;
    if (s.vmDesktop === "off") return false;
    if (s.vmDesktop === "always") return true;
    var want = /网站|网页|登录|注册|下单|购物|买|订|表单|比价|预订|加购|支付|收藏|桌面|操作浏览|游戏|试玩|玩一|体验|交互|测试一|找 ?bug|有什么 ?bug/i.test(String(text || ""));
    return !!want && !!window.LumenDesktop && !!window.LumenDesktop.available;
  }

  // 给模型看的当前页观察（JSON 化，紧凑）
  function vmObservation(r) {
    var p = (r && r.page) || null;
    if (!p) return "（尚未打开页面）";
    var links = (p.links || []).slice(0, 8).map(function (l) {
      return l.n + "." + l.title.slice(0, 40);
    }).join(" ");
    return "标题：" + p.title + "\n地址：" + p.url +
      "\n正文开头：" + String(p.excerpt || p.text || "").slice(0, 500) +
      (links ? "\n可点链接：" + links : "");
  }

  // ———————————————————————————— 真实网络层（经本地服务桥）————————————————————————————

  // 服务桥基址：同源运行时 LumenBridgeBase 是空串（表示同源，必须原样保留，
  // 不能 || 回退——否则自定义端口如 PORT=9000 时会错连 8787）
  function bridgeBase() {
    var b = window.LumenBridgeBase;
    return (b === undefined || b === null) ? BRIDGE : b;
  }

  function webSearch(query, count, task) {
    return fetch(bridgeBase() + "/web/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, count: count || 5 }),
      signal: task ? task.controller.signal : undefined,
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  function webFetch(url, task) {
    return fetch(bridgeBase() + "/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url }),
      signal: task ? task.controller.signal : undefined,
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  // —— Hindsight 深度记忆（可选 · 服务桥 /memory/hindsight/* 代理）——
  // enabled 状态带 60s 缓存：服务关闭时每分钟最多探测一次，不拖慢对话
  var hsCache = { at: 0, on: false };
  function hsActive() {
    if (Date.now() - hsCache.at < 60000) return Promise.resolve(hsCache.on);
    return fetch(bridgeBase() + "/memory/hindsight/status").then(function (r) { return r.json(); })
      .then(function (d) {
        hsCache = { at: Date.now(), on: !!(d && d.enabled && d.api && d.api.reachable) };
        return hsCache.on;
      }).catch(function () { hsCache = { at: Date.now(), on: false }; return false; });
  }
  function hsRecall(query, task) {
    return fetch(bridgeBase() + "/memory/hindsight/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, maxTokens: 1536 }),
      signal: task ? task.controller.signal : undefined,
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }
  function hsRetain(content, context) {
    return fetch(bridgeBase() + "/memory/hindsight/retain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content, context: context || "chat" }),
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }
  window.LumenHindsight = { invalidate: function () { hsCache.at = 0; } };

  // —— 应用连接（飞书/Lark · Google 邮件日历）：真实 API 动作，优先于演示流 ——
  var CONNECTOR_LABELS = {
    "lark.send": "发送飞书消息", "lark.doc": "创建飞书文档", "lark.event": "创建飞书日程",
    "mail.send": "发送邮件", "mail.event": "创建日历日程",
    "google.send": "发送 Gmail 邮件", "google.event": "创建 Google 日历日程",
  };
  function connLabel(conn) { return CONNECTOR_LABELS[conn.id + "." + conn.action] || "应用连接动作"; }

  // 纯文本匹配：飞书必须点名；Google 邮件按发送动词；日历需点名谷歌（避免劫持普通「日历」指令）
  function matchConnector(text) {
    var t = (text || "").toLowerCase();
    if (/飞书|lark/.test(t)) {
      if (/文档|笔记|doc\b/.test(t)) return { id: "lark", action: "doc" };
      if (/日历|日程|会议|提醒/.test(t)) return { id: "lark", action: "event" };
      return { id: "lark", action: "send" };
    }
    if (/发(送)?邮件|邮件发|gmail|outlook|代发邮件/.test(t)) return { id: "mail", action: "send" };
    if (/日历|日程/.test(t) && (/谷歌|google/.test(t) || /微软|outlook|microsoft/.test(t))) return { id: "mail", action: "event" };
    return null;
  }

  function connectorsStatus(task) {
    return fetch(bridgeBase() + "/connectors", { signal: task && task.controller.signal })
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  // 参数抽取：先正则（「说：」「内容：」显式格式），抽不中且已接模型则让模型转 JSON
  function extractConnectorArgs(task, text, conn) {
    var key = conn.id + "." + conn.action;
    var m = null;
    if (key === "lark.send") {
      m = text.match(/(?:说|内容|发|发送|通知)(?:给)?(?:飞书|群|lark)?(?:消息|通知)?\s*[：:]\s*([\s\S]+)/i)
        || text.match(/(?:发|发送|通知)(?:一下)?(?:给)?(?:飞书|群|lark)\s*(?:说)?\s*([\s\S]+)/i);
      if (m) return Promise.resolve({ text: m[1].trim() });
    } else if (key === "mail.send") {
      m = text.match(/发(?:送)?邮件给\s*([^\s，,]+)\s*主题[：:]\s*([^\n]+?)\s*内容[：:]\s*([\s\S]+)/i);
      if (m) return Promise.resolve({ to: m[1].trim(), subject: m[2].trim(), body: m[3].trim() });
    } else if (key === "lark.doc") {
      m = text.match(/[：:]\s*([\s\S]+)/) || text.match(/(?:写|记|存)(?:一份|一个|篇)?(.+)/);
      if (m) {
        var body = m[1].trim().replace(/^(到|到飞书|进飞书|在飞书里?|飞书)[的]?(文档|笔记|上)?/, "");
        var title = text.replace(/[：:][\s\S]*$/, "").slice(0, 40)
          .replace(/飞书|lark|文档|笔记|帮我|请|创建|生成|一份|一个/g, "").trim();
        return Promise.resolve({ title: title || ("Lumi 笔记 · " + new Date().toISOString().slice(0, 10)), text: body });
      }
    }
    var cfg = window.LumenAI.current();
    if (!cfg) return Promise.resolve(null);
    var schema = "lark.send:{text}｜lark.doc:{title,text}｜lark.event:{summary,startISO,endISO}｜google.send:{to,subject,body}｜google.event:{summary,startISO,endISO}";
    return window.LumenAI.chatStream({
      provider: cfg,
      messages: [{
        role: "user",
        content: "把用户指令转成一个 JSON 参数对象（只输出 JSON，别解释）。动作 " + key + " 的可用字段：" + schema +
          "。时间用带时区 ISO（如 2026-10-02T09:00:00+08:00），缺结束时间按开始+1小时。当前时间 " + new Date().toISOString() + "。\n指令：" + text,
      }],
      signal: task ? task.controller.signal : undefined,
      onDelta: function () {},
    }).then(function (rep) {
      var mm = String(rep || "").match(/\{[\s\S]*\}/);
      if (!mm) return null;
      try { var o = JSON.parse(mm[0]); return (o && typeof o === "object") ? o : null; } catch (e) { return null; }
    }).catch(function () { return null; });
  }

  function connectorReply(conn, args, ok, result, failReason) {
    var key = conn.id + "." + conn.action, label = connLabel(conn);
    if (ok) {
      var det = "";
      if (key === "lark.send") det = "消息已" + (((result && result.channel) === "webhook") ? "通过群机器人送达飞书群" : "送达飞书（应用身份）") + "。";
      if (key === "lark.doc") det = "文档已创建：" + ((result && result.url) || "") + ((result && result.note) || "");
      if (key === "lark.event") det = "飞书日程已创建（事件号 " + ((result && result.eventId) || "-") + "）。";
      if (key === "mail.send") {
        var via = (result && result.via) || "";
        det = "邮件已发给 " + ((result && result.to) || "收件人") + "（" + (via.indexOf("smtp:") === 0 ? "SMTP 直发 · " + via.slice(5) : via === "graph" ? "微软 Graph" : "Gmail") + "）。";
      }
      if (key === "mail.event") det = "日历日程已创建：" + ((result && result.htmlLink) || "（可在日历应用查看）");
      if (key === "google.send") det = "邮件已通过你的 Gmail 发给 " + ((result && result.to) || "收件人") + "。";
      if (key === "google.event") det = "Google 日历日程已创建：" + ((result && result.htmlLink) || "");
      return label + "办好了 ✅\n\n" + det + "\n\n（发送前经过了你的批准，动作已写入审计日志）";
    }
    if (failReason === "BRIDGE_OFF") return "这次没法" + label + "：本地服务桥不在线。请先启动服务桥（node server.js 或 sh run.sh）再说一次。";
    if (failReason && failReason.indexOf("NOT_CONFIGURED") === 0) {
      if (conn.id === "lark") return "飞书还没连接，这次我没有发送任何东西（不想假装发过）。\n\n两种连法（设置 → 应用连接 → 飞书）：\n1. **群机器人 Webhook**——在飞书群里加「自定义机器人」，把 Webhook 地址贴进来即可发群消息，最简单；\n2. **自建应用**——飞书开放平台建应用，填 App ID/Secret，还能建文档、建日程。\n\n连好后再说一次「飞书发：…」，我就真发了。";
      return "邮件通道还没连接，这次我没有发送任何东西。\n\n三种连法按省事程度排（设置 → 应用连接）：\n1. **SMTP 授权码（最快，QQ/163/126/Gmail/Outlook 通用）**——在邮箱设置里开启 SMTP 服务拿「授权码」，填进来就能用；\n2. **微软设备码**——Azure 注册个免费应用拿 client_id，点「发起设备码授权」后到 microsoft.com/link 输个代码，Outlook 邮件+日历都通；\n3. **Google OAuth**——Cloud Console 建桌面应用客户端，授权一次。\n\n（过渡方案：说「生成邮件草稿」，我先给你 .eml 文件）";
    }
    if (failReason === "NEED_ARGS") {
      var fmt = (conn.id === "google" && conn.action === "send")
        ? "发邮件给 someone@example.com 主题：周报 内容：本周完成……"
        : "飞书发：要说的内容";
      return "我不太确定这次「" + label + "」的具体内容，就不瞎猜了。换个明确说法，比如：\n\n> " + fmt;
    }
    if (failReason && failReason.indexOf("HANDOFF") === 0) {
      return "按你设定的规则，「" + label + "」我碰都不碰——这一步转交你本人执行。（设置 → 规则与审批 可调整）";
    }
    return label + "失败了，如实报告：\n\n" + String(failReason || "").replace(/^API_FAIL:/, "") +
      "\n\n没有东西被发出或创建（失败发生在调用阶段）。可到 设置 → 应用连接 点「测试」检查配置。";
  }

  function runConnectorFlow(task, text, conn, steps, actMsgId, ctx, hooks) {
    var label = connLabel(conn);
    var args = null, result = null;
    function step(i, fn) {
      steps[i].status = "active";
      hooks.patchActivity(actMsgId, { activeStep: i });
      return fn().then(function (r) {
        if (task.aborted) throw new Error("__ABORT__");
        steps[i].status = "done";
        hooks.patchActivity(actMsgId, {});
        return r;
      });
    }
    var chain = step(0, function () {
      return connectorsStatus(task).then(function (d) {
        var c = d && d.connectors && d.connectors[conn.id];
        if (!c) throw new Error("BRIDGE_OFF");
        if (!c.configured || (conn.id === "google" && !c.authorized)) throw new Error("NOT_CONFIGURED");
        return sleep(200, task);
      });
    });
    chain = chain.then(function () {
      return step(1, function () {
        return extractConnectorArgs(task, text, conn).then(function (a) { args = a; });
      });
    });
    chain = chain.then(function () {
      return step(2, function () {
        if (!args) throw new Error("NEED_ARGS");
        var rule = matchRule(label + " 对外发送 appsend");
        if (rule && rule.mode === "auto") {
          store.audit("规则放行 · " + label, "规则「" + rule.keywords + "」", "auto");
          hooks.patchActivity(actMsgId, { autoNote: "「" + label + "」按规则「" + rule.keywords + "」直接放行" });
          return sleep(300, task);
        }
        if (rule && rule.mode === "handoff") throw new Error("HANDOFF");
        var gate = shouldAskApproval("email"); // 对外发送按敏感类审批
        if (gate.mode === "always" || gate.mode === "auto") {
          store.audit(label, "按你的授权策略自动通过", gate.mode === "always" ? "approved" : "auto");
          hooks.patchActivity(actMsgId, { autoNote: "「" + label + "」按你的授权策略自动通过" });
          return sleep(400, task);
        }
        steps[2].status = "blocked";
        hooks.patchActivity(actMsgId, {});
        store.audit("请求批准 · " + label, JSON.stringify(args).slice(0, 120), "info");
        return hooks.requestApproval({
          messageId: actMsgId, intent: "appsend", risk: "send",
          title: label, detail: JSON.stringify(args, null, 2).slice(0, 400),
        }).then(function (decision) {
          if (decision === "deny") { task.abort(); throw new Error("DENIED"); }
          if (decision === "always") { store.state.alwaysAllow["send"] = true; store.save(); }
          store.audit("已批准 · " + label, decision === "always" ? "并记住为「总是允许」" : "仅此一次", "approved");
          steps[2].status = "done";
          hooks.patchActivity(actMsgId, {});
          return sleep(300, task);
        });
      });
    });
    chain = chain.then(function () {
      return step(3, function () {
        return fetch(bridgeBase() + "/connectors/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: conn.id, action: conn.action, args: args }),
          signal: task.controller.signal,
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d || d.ok !== true) throw new Error("API_FAIL:" + ((d && d.error) || "服务桥无响应"));
          result = d.result || {};
          store.audit(label, "真实执行成功", "done");
          return sleep(200, task);
        });
      });
    });
    return chain.then(function () {
      ctx.connectorResult = { text: connectorReply(conn, args, true, result, "") };
      return ctx.connectorResult;
    }).catch(function (e) {
      var msg = String((e && e.message) || e);
      if (msg === "DENIED" || msg === "__ABORT__") throw e; // 交给 runTask 统一收尾
      ctx.connectorResult = { text: connectorReply(conn, args, false, null, msg) };
      return ctx.connectorResult;
    });
  }

  // 需要真实检索的意图
  var RESEARCHY = { travel: true, purchase: true, research: true };

  // 让模型把任务翻译成专业搜索词（中英各一），失败则回退清洗后的任务原文
  function makeQueries(text, signal) {
    var cfg = window.LumenAI.current();
    var fallback = [text.replace(/帮我|请|一下|查查|看看|麻烦/g, "").slice(0, 50)];
    if (!cfg) return Promise.resolve(fallback);
    return window.LumenAI.chatStream({
      provider: cfg,
      messages: [{
        role: "user",
        content: "为下面的任务生成 2 条联网搜索关键词：第一条中文、第二条英文或更精准的变体（去掉口语、保留关键实体与日期）。只输出 JSON，格式：" +
          '{"queries":["…","…"]}' + "\n\n任务：" + text,
      }],
      signal: signal,
      onDelta: function () {},
    }).then(function (rep) {
      var m = String(rep || "").match(/\{[\s\S]*\}/);
      if (m) {
        try {
          var q = JSON.parse(m[0]).queries;
          if (q && q.length) return q.slice(0, 2).map(function (x) { return String(x).slice(0, 80); }).concat(fallback).slice(0, 3);
        } catch (e) { /* 回退 */ }
      }
      return fallback;
    }).catch(function () { return fallback; });
  }

  /**
   * 真实研究管线：模型生成搜索词 → 多引擎检索 → 读源提取证据。
   * 把「检索 → 读源」作为新步骤动态追加进活动卡并真实执行。
   * 返回证据文本（供模型作答引用）；检索不可用时返回 null（后续由模型直接作答）。
   */
  function gatherEvidence(task, text, intent, steps, actMsgId, ctx, hooks) {
    var stepPlan = { label: "规划搜索关键词", type: "think", status: "pending" };
    var stepSearch = { label: "联网检索", type: "browse", url: "bing.com/search", status: "pending" };
    var stepRead = { label: "阅读来源并提取证据", type: "app", status: "pending" };
    steps.splice(steps.length - 1, 0, stepPlan, stepSearch, stepRead); // 插在收尾步骤前
    hooks.patchActivity(actMsgId, {});

    stepPlan.status = "active";
    hooks.patchActivity(actMsgId, {});
    return makeQueries(text, task.controller.signal).then(function (queries) {
      if (task.aborted) return null;
      stepPlan.status = "done";
      stepPlan.label = "规划搜索关键词 —— " + queries.join(" ／ ").slice(0, 70);
      hooks.patchActivity(actMsgId, {});

      stepSearch.status = "active";
      stepSearch.url = "bing.com/search?q=" + encodeURIComponent(queries[0]);
      stepSearch.label = "联网检索：「" + queries[0].slice(0, 40) + "」";
      hooks.patchActivity(actMsgId, {});
      return webSearch(queries[0], 6, task).then(function (sr) {
        if (task.aborted) return null;
        // 首轮命中不足且有第二条词 → 补一轮
        var second = (!sr || !sr.ok || !sr.results || sr.results.length < 3) && queries[1] ? webSearch(queries[1], 6, task) : Promise.resolve(null);
        return second.then(function (sr2) {
          if (task.aborted) return null;
          var results = ((sr && sr.ok && sr.results) || []).concat(((sr2 && sr2.ok && sr2.results) || []));
          var seen = {};
          results = results.filter(function (r) {
            if (!r.url || seen[r.url]) return false;
            seen[r.url] = true;
            return true;
          }).slice(0, 8);
          stepSearch.status = "done";
          if (!results.length) {
            stepSearch.label = "联网检索 —— 不可用（" + String(sr && sr.error || "无结果").slice(0, 60) + "），改由模型直接作答";
            hooks.patchActivity(actMsgId, {});
            return null;
          }
          stepSearch.label = "联网检索 —— 命中 " + results.length + " 条（关键词 " + queries.length + " 轮）";
          hooks.patchActivity(actMsgId, {});
          store.audit("联网检索", queries.join(" / ").slice(0, 80) + " · " + results.length + " 条", "info");

          var listLine = results.map(function (r, i) {
            return "[" + (i + 1) + "] " + r.title + " — " + r.url + (r.snippet ? "\n    " + r.snippet : "");
          }).join("\n");

          stepRead.status = "active";
          hooks.patchActivity(actMsgId, {});
          var picks = results.slice(0, 3);
          var reads = picks.map(function (r) {
            return webFetch(r.url, task).then(function (page) {
              if (page && page.ok && page.text) {
                return { title: page.title || r.title, url: r.url, text: page.text.slice(0, 2200) };
              }
              return null;
            }).catch(function () { return null; });
          });
          return Promise.all(reads).then(function (pages) {
            if (task.aborted) return null;
            var okPages = pages.filter(Boolean);
            stepRead.status = "done";
            stepRead.label = "阅读来源 —— " + okPages.length + "/" + picks.length + " 个页面提取成功";
            hooks.patchActivity(actMsgId, {});
            okPages.forEach(function (pg) { store.audit("阅读来源", pg.title.slice(0, 40), "info"); });
            var evidence = "【联网检索结果：" + queries.join("；") + "】\n" + listLine;
            if (okPages.length) {
              evidence += "\n\n【来源正文节选】\n" + okPages.map(function (pg, i) {
                return "— 来源 " + (i + 1) + "：" + pg.title + "（" + pg.url + "）\n" + pg.text;
              }).join("\n\n");
            }
            ctx.evidence = evidence.slice(0, 9000);
            return ctx.evidence;
          });
        });
      });
    });
  }

  // ———————————————————————————— 真实产物：.ics 日历事件 / .eml 邮件草稿 ————————————————————————————

  function pad2(n) { return String(n).padStart(2, "0"); }

  function icsEscape(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }

  function icsDateTime(iso) {
    // "2026-10-08T12:00"（本地时间）→ "20261008T120000"（浮动本地时间，导入按本地时区解释）
    var m = String(iso || "").match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return null;
    return m[1] + m[2] + m[3] + "T" + m[4] + m[5] + "00";
  }

  function buildIcs(ev) {
    var d = new Date();
    var stamp = "" + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + "T" +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + "Z";
    var start = icsDateTime(ev.startISO);
    if (!start) return null;
    var lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lumen//Personal Agent//CN", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      "UID:" + store.uid() + "@lumen.local",
      "DTSTAMP:" + stamp,
      "DTSTART:" + start,
      "DURATION:PT" + (ev.durationMin || 60) + "M",
      "SUMMARY:" + icsEscape(ev.title || "Lumi 日程"),
    ];
    if (ev.location) lines.push("LOCATION:" + icsEscape(ev.location));
    if (ev.notes) lines.push("DESCRIPTION:" + icsEscape(ev.notes));
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n");
  }

  function emlEscapeHeader(s) { return String(s || "").replace(/[\r\n]+/g, " ").trim(); }

  function stripMd(s) {
    return String(s || "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*[-*]\s+/gm, "· ")
      .replace(/^\s*>\s?/gm, "");
  }

  function buildEml(subject, body) {
    return [
      "X-Unsent: 1",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "From: me@lumen.local",
      "To: ",
      "Subject: " + emlEscapeHeader(subject),
      "",
      stripMd(body),
    ].join("\r\n");
  }

  function deriveTitle(task, answer) {
    var h = String(answer || "").match(/^#{1,3}\s+(.+)$/m);
    if (h) return h[1].trim().slice(0, 30);
    var subj = String(answer || "").match(/主题[：:]\s*(.+)/m);
    if (subj) return subj[1].trim().slice(0, 30);
    return String(task || "文档").slice(0, 22);
  }

  // ———————————————————————————— 意图识别 ————————————————————————————

  var INTENTS = [
    { id: "monitor",  kw: ["盯着", "盯住", "监控", "降价", "提醒我", "一旦有", "开票", "开放申请", "关注价格", "到货提醒", "有货了", "盯着价格", "持续关注"] },
    { id: "computer", kw: ["操作电脑", "打开应用", "帮我点", "点击", "点一下", "按一下", "屏幕上", "截图", "电脑上", "浏览器里", "网页上", "网页", "填表", "表单里", "关掉", "关闭窗口", "登录一下", "鼠标", "键盘", "切换窗口", "虚拟机", "虚拟电脑", "虚拟计算机", "自己的电脑", "上网查", "打开网页", "打开网站", "玩游戏", "玩一下", "玩这", "游戏", "试玩", "测试", "试试", "体验", "交互", "bug", "毛病"] },
    { id: "travel",   kw: ["机票", "航班", "飞机", "旅行", "旅游", "酒店", "民宿", "行程", "火车票", "高铁", "签证", "预订", "出发"] },
    { id: "purchase", kw: ["买", "购买", "下单", "退款", "退货", "比价", "购物", "订单", "优惠券", "折扣", "多少钱"] },
    { id: "email",    kw: ["邮件", "发邮件", "回信", "写信", "写给", "答复", "跟进函", "email"] },
    { id: "schedule", kw: ["日历", "安排", "提醒", "会议", "日程", "预约", "订个时间", "别忘"] },
    { id: "paint",    kw: ["画一", "画幅", "画作", "画个", "印象派", "睡莲", "涂鸦"] },
    { id: "create",   kw: ["写", "起草", "文案", "文章", "总结", "报告", "规划", "清单", "大纲", "方案", "翻译"] },
    { id: "research", kw: ["查", "调研", "研究", "对比", "了解", "找一下", "找一个", "找个", "找点", "帮我找", "搜索", "攻略", "看看", "分析", "哪里", "哪儿", "什么地方", "能用", "可以用", "有没有", "推荐"] },
    { id: "goal",     kw: ["坚持", "每天", "每周", "目标", "养成", "学习计划", "健身", "减肥", "省钱", "攒钱", "读书"] },
  ];

  function classify(text) {
    var t = (text || "").toLowerCase();
    var best = null, bestHit = 0;
    for (var i = 0; i < INTENTS.length; i++) {
      var hit = 0;
      for (var k = 0; k < INTENTS[i].kw.length; k++) {
        if (t.indexOf(INTENTS[i].kw[k]) !== -1) hit++;
      }
      if (hit > bestHit) { bestHit = hit; best = INTENTS[i].id; }
    }
    return best || "chat";
  }

  // —— 动作规则（对标 dots Custom Rules；设置页维护，Sentinel/审批门共用语义） ——
  function matchRule(text) {
    var rules = (store.state.settings.rules || []);
    var hay = String(text || "");
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r || !r.keywords || !r.mode) continue;
      var kws = String(r.keywords).split(/[\s、|｜，,]+/).map(function (k) { return k.trim(); }).filter(Boolean);
      if (!kws.length) continue;
      var all = kws.every(function (k) { return hay.indexOf(k) !== -1; });
      if (all) return r;
    }
    return null;
  }

  // 浏览器系统通知（页面开着时；权限在设置页授予）
  function notifyUser(title, body) {
    try {
      if (store.state.settings.notifyBrowser && window.Notification && Notification.permission === "granted") {
        new Notification(title, { body: String(body || "").slice(0, 120), tag: "lumen" });
      }
    } catch (e) {}
    // Webhook 中继（桌面任务/监控由服务桥直接发；聊天任务经这里补发）
    fetch(bridgeBase() + "/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title, text: body }),
    }).catch(function () {});
  }

  // 需要审批闸门的「关键动作」意图（花钱/对外发送类必须经你同意）
  var CRITICAL = { travel: true, purchase: true, email: true };

  // ———————————————————————————— 计划编排 ————————————————————————————

  function rd(min, max) { return min + Math.random() * (max - min); }

  var APPROVALS = {
    travel:   { type: "book",    title: "整理真实预订方案", detail: "Lumi 将基于联网检索整理真实预订入口、价格与退改规则。涉及付款的最后一步永远由你本人完成——需要时可用「电脑操作」让 Lumi 在浏览器里陪你走到下单页（每步仍会请示）。" },
    purchase: { type: "purchase", title: "整理下单方案", detail: "Lumi 将联网比价并生成真实购买链接清单。付款由你本人完成；也可以用「电脑操作」让 Lumi 陪你在浏览器里走完下单流程（每步仍会请示）。" },
    email:    { type: "send",    title: "生成邮件草稿", detail: "Lumi 已起草完毕，将生成 .eml 草稿文件（可导入邮件客户端）。真正的发送动作由你完成——或经「电脑操作」在你的邮箱里逐步执行并请示。" },
    general:  { type: "action",  title: "代表你执行操作", detail: "Lumi 即将执行上述步骤。整个过程会记录在审计日志中，随时可中断。" },
  };

  function buildPlan(text, intent, env) {
    var plans = {
      travel: [
        { label: "理解出行需求", type: "think" },
        { label: "打开比价网站检索航班与酒店", type: "browse", url: "flights.lumen/search?q=" + encodeURIComponent(text.slice(0, 24)) },
        { label: "按价格与时段筛选前 5 方案", type: "browse", url: "flights.lumen/filter?sort=best" },
        { label: "生成行程对比文档", type: "write" },
      ],
      purchase: [
        { label: "理解购买需求", type: "think" },
        { label: "在购物平台检索商品", type: "browse", url: "shop.lumen/search?q=" + encodeURIComponent(text.slice(0, 24)) },
        { label: "比价并核对优惠券", type: "browse", url: "shop.lumen/compare" },
        { label: "生成比价小结", type: "write" },
      ],
      email: [
        { label: "分析往来语境与语气", type: "think" },
        { label: "起草邮件正文", type: "write" },
        { label: "检查称呼、错别字与附件", type: "think" },
      ],
      schedule: [
        { label: "查看你的日历空档", type: "app" },
        { label: "协调各方时间并创建日程", type: "app" },
        { label: "设置提前提醒", type: "app" },
      ],
      paint: [
        { label: "构思构图与光色", type: "think" },
        { label: "在虚拟画布上起笔铺色", type: "app" },
        { label: "叠加笔触，让光在水面聚起来", type: "app" },
      ],
      create: [
        { label: "理解写作意图与受众", type: "think" },
        { label: "搭建结构并起草内容", type: "write" },
        { label: "润色并排版成文档", type: "write" },
      ],
      research: [
        { label: "拆解调研问题", type: "think" },
        { label: "多来源检索与交叉验证", type: "browse", url: "research.lumen/query?q=" + encodeURIComponent(text.slice(0, 24)) },
        { label: "整理成要点与结论", type: "write" },
      ],
      goal: [
        { label: "把愿望翻译成可执行的目标", type: "think" },
        { label: "拆分阶段里程碑", type: "write" },
        { label: "设置每日/每周跟进节奏", type: "app" },
      ],
      chat: [
        { label: "理解你的问题", type: "think" },
        { label: "组织回答", type: "write" },
      ],
      computer: env === "desktop" ? [
        { label: "唤醒桌面虚拟机（LumenBox Desktop）", type: "app" },
        { label: "向 Sentinel 登记任务（全程审计）", type: "wait" },
        { label: "在虚拟机桌面操作浏览器（可在计算机页实时观看）", type: "browse", url: "lumenbox-desktop://live" },
        { label: "收集证据（Sentinel 审查每个动作）", type: "app" },
        { label: "笔记存入虚拟工作区", type: "write" },
        { label: "收工（全程未碰你的电脑）", type: "app" },
      ] : env === "vm" ? [
        { label: "唤醒虚拟计算机（LumenBox）", type: "app" },
        { label: "规划浏览路线", type: "think" },
        { label: "在虚拟浏览器里检索与打开页面", type: "browse", url: "lumenbox://home" },
        { label: "阅读页面并提取证据", type: "app" },
        { label: "把笔记存进虚拟工作区", type: "write" },
        { label: "收工（全程未碰你的电脑）", type: "app" },
      ] : [
        { label: "启动 QCU 会话（电脑操作技能）", type: "app" },
        { label: "观察当前界面（无障碍树）", type: "app" },
        { label: "规划下一步操作", type: "think" },
        { label: "等待你的批准", type: "wait" },
        { label: "执行操作", type: "app" },
        { label: "复核操作结果", type: "app" },
        { label: "关闭会话", type: "app" },
      ],
      monitor: [
        { label: "理解监控目标", type: "think" },
        { label: "在服务桥注册 7×24 后台任务", type: "app" },
        { label: "首轮基线检索", type: "browse" },
        { label: "安排持续跟踪节奏", type: "app" },
      ],
    };
    var steps = (plans[intent] || plans.chat).slice();
    // 敏感意图在收尾前插入审批闸门（是否真的弹卡由 autonomy 与 alwaysAllow 决定）
    if (CRITICAL[intent]) {
      steps.splice(steps.length - 1, 0, {
        label: APPROVALS[intent].title,
        type: "wait",
        approval: APPROVALS[intent],
      });
    } else if (store.state.settings.autonomy === "ask" && intent !== "computer") {
      // 「每次都问」模式：非敏感任务也设一道总闸门，与设置文案「任何动作执行前都请求批准」一致
      // computer 意图例外：两条流（虚拟计算机 / QCU）各自内置审批与索引约定，不外插步骤
      steps.splice(1, 0, {
        label: APPROVALS.general.title,
        type: "wait",
        approval: APPROVALS.general,
      });
    }
    steps.forEach(function (s) { s.status = "pending"; });
    return steps;
  }

  // ———————————————————————————— 系统提示词 ————————————————————————————

  var TONES = {
    monet: "说话方式：像莫奈笔下的光——温柔、从容、有画面感，但不啰嗦。",
    pro: "说话方式：简洁高效，结论先行，要点清单化，少寒暄。",
    warm: "说话方式：热心周到，主动补充小提示与关心，像老朋友。",
  };

  // 语气 + 长期记忆 + 连接器权限 → 全部注入系统提示词（个性化与长期记忆）
  function personaDigest() {
    var s = store.state.settings;
    var lines = [TONES[s.tone] || TONES.monet];
    var mem = store.state.memories;
    if (mem.length) {
      lines.push("你记住的关于用户的信息（回答时自然运用，不要生硬复述）：");
      mem.slice(0, 12).forEach(function (m) { lines.push("· [" + m.kind + "] " + m.text); });
    }
    var conns = [];
    Object.keys(s.connectors).forEach(function (cid) {
      var st = store.connectorState(cid);
      var name = { gmail: "邮件", calendar: "日历", instagram: "Instagram", whatsapp: "WhatsApp" }[cid] || cid;
      if (st.on) conns.push(name + "(" + (st.read ? "可读" : "不可读") + "/" + (st.write ? "可写" : "不可写") + ")");
    });
    if (conns.length) lines.push("用户已授权的连接器：" + conns.join("、") + "；未列出的应用一律视为未授权，不要假装能访问。");
    return lines.join("\n");
  }

  // 启用中的内置技能摘要（+限量全文），让 Lumi 带着专业技能做事
  function skillsDigest() {
    var sk = window.LumenSkills;
    if (!sk || !sk.list || !sk.list.length) return "";
    var s = store.state.settings;
    var lines = [];
    var budget = 7000;
    sk.list.forEach(function (skill) {
      if (s.skills && s.skills[skill.id] === false) return; // 已停用
      lines.push("· " + skill.name + "（" + skill.id + "）" + (skill.exec ? " [可执行]" : "") + "：" + (skill.desc || ""));
      var full = (sk.contents || {})[skill.id];
      if (full && budget > 0) {
        var seg = full.replace(/\r/g, "").slice(0, 900);
        budget -= seg.length;
        lines.push("  方法论节选：" + seg.replace(/\n+/g, " ⏎ "));
      }
    });
    if (!lines.length) return "";
    return "你内置了以下技能，相关任务请遵循其方法论（完整说明可向用户展示）：\n" + lines.join("\n");
  }

  function systemPrompt() {
    var s = store.state.settings;
    var goals = store.state.goals.slice(0, 5).map(function (g) { return "· " + g.title; }).join("\n");
    var d = new Date();
    var week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
    var digest = skillsDigest();
    return [
      "你是 Lumi，用户的私人 AI 代理（Personal Agent），运行在印象派风格的 Lumen 应用里。",
      "今天是 " + d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月 " + d.getDate() + " 日，星期" + week + "。",
      "与普通聊天机器人不同：你要像一位可靠的私人助理那样「把事情办成」，回答要行动导向、给出下一步。",
      personaDigest(),
      "语气温暖、自然、简洁，使用中文，可用 Markdown 适度排版（小标题、列表、粗体），不要过度使用表格。",
      goals ? "用户正在推进的目标：\n" + goals : "",
      digest,
      "你拥有自己的虚拟计算机（LumenBox）：轻量虚拟浏览器（检索/阅读）与可选的桌面虚拟机（LumenBox Desktop：容器里的完整 Linux 桌面 + 真实 Chromium，GUI 型任务如登录/下单/表单在上面执行，用户可实时观看）——产物会出现在「计算机」页，全程不触碰用户的电脑。",
      "桌面虚拟机内每个动作都经宿主 Sentinel 审查：普通浏览直接放行，导航恶意/私网地址会被阻止，支付/发送/填写敏感字段必须用户批准（批准一次发 10 分钟能力凭证）；涉及密码/卡号时优先引用「安全区凭证」（按名称引用，值由服务桥直注，你永远看不到明文）。",
      "需要真正操控用户本机应用时（用户说「用我的电脑」「在这台电脑上」等），才走 QCU 电脑操作（观察→规划→批准→执行）。",
      "涉及花钱、对外发送或操作用户电脑的动作，会由用户在界面上批准。",
      "诚实红线：只有当任务真实进入执行流（虚拟计算机/桌面虚拟机/QCU）并有执行摘要时，你才真的做过浏览或操作。若上下文没有执行摘要、也没有检索证据，就绝不能声称「我打开过网页/操作过虚拟机/试玩过游戏」——如实说明这次没有实际操作，并告诉用户怎么说可以触发（例如「用你的电脑打开……试玩/测试」）。",
    ].filter(Boolean).join("\n");
  }

  // ———————————————————————————— 演示引擎文案 ————————————————————————————

  function demoAnswer(text, intent) {
    var name = store.state.settings.agentName;
    var docs = {
      travel: "我把真实检索到的方案整理好了：\n\n**推荐方案**（详见文件页，附来源链接）\n- ✈️ 已按价格与时段筛出最优组合\n- 🏨 住宿含评分与位置权衡\n- 💰 合计与近期价位对比\n\n**下一步由你决定**：链接都在文件页，付款那一步请你本人完成；想让我陪你在浏览器里走完下单，说「用电脑操作」即可（每步都会请示）。",
      purchase: "真实比价完成 ✅（来源见文件页）\n\n- 同款各平台价差已核实\n- 最低价与历史区间对比\n- 第三方发货等风险已标注\n\n购买链接已整理进**文件**页。付款请本人完成，或让我用「电脑操作」陪你下单（逐步请示）。",
      email: "草稿写好了 ✅\n\n- 语气与结构按你的语境调整\n- 已生成 **.eml 草稿文件**（文件页可下载，导入邮件客户端即可继续编辑发送）\n\n要改语气或补充内容，直接说。",
      schedule: "搞定 ✅ 我看了你的要求：\n\n- 已生成 **.ics 日历事件**（文件页可下载，双击即可导入系统日历）\n- 时间按你的偏好排定\n\n时间要挪动的话告诉我，我重新生成。",
      paint: "画好了 🎨\n\n这一幅用的是莫奈的睡莲色板：深水蓝打底，落日橙点光，粉紫的睡莲浮在水面上。它已经挂进**文件**页。\n\n每一幅都是一次性画成的，世界上不会有第二张一样的。想再来一幅不同时辰的（晨雾 / 正午 / 暮色）吗？",
      create: "写好了 ✅ 已存入**文件**页。\n\n结构上我做了三件事：\n- 先给结论，再给依据，方便快速扫读\n- 每节控制在 3–5 个要点\n- 收尾附上「下一步行动」清单\n\n要调整语气（更正式 / 更轻快）或补充某一部分，直接告诉我。",
      research: "调研完成 ✅ 要点如下：\n\n- 三个信息源相互印证，结论可信度较高\n- 关键差异点我已整理成对比清单\n- 有一处来源存疑，我标注了出来，未采信\n\n完整的调研笔记在**文件**页。要不要我基于结论帮你起草一份决策建议？",
      goal: "好目标 ✅ 我已经把它建进**目标**页，并拆成了可勾选的小步骤。\n\n我会这样跟进：每天在**动态**页给你一条轻量提示，每周汇总一次进展。你只管执行，记账的事交给我。",
      chat: "我在听。这件事如果你想让我**直接办了**（查资料、写东西、盯价格、排日程），直接说「帮我……」就行；如果只是想聊聊，我也很乐意。\n\n顺带一提：文件、目标、动态这几个页面，都是我替你打理的成果。",
      computer: "这次我在自己的虚拟计算机上干活了。执行报告：{qcu}\n\n说明：上网检索、阅读、存笔记都在 Lumi 的隔离虚拟计算机（LumenBox）里完成——**你的电脑原封未动**，所以浏览过程不需要逐步审批，但每一步都写进了审计日志。\n\n接下来可以：\n- 到「计算机」页看我的浏览历史、工作区文件与虚拟终端\n- 需要我动你本机的应用时，说「用我的电脑操作」（QCU 真机流，每步请示）\n- 接入模型后，我会自主规划多步浏览路线（检索→点开→交叉验证）",
      monitor: "监控任务{monstate}。\n\n它是**常驻任务**：由本地服务桥每 30 分钟真实检索一次（模型在线时还会智能判断是否命中），**就算关掉这个页面它也会继续跑**。命中的动静会出现在「目标」页的后台监控区和动态页，审计日志全程留痕。\n\n想调整节奏或停下，到「目标」页后台监控区操作即可。",
    };
    return (docs[intent] || docs.chat).replace(/\n/g, "\n\n");
  }

  // 从任务中提取长线目标（goal 意图或含长期信号）
  function extractGoal(text, intent) {
    if (intent !== "goal") return null;
    var title = (text || "").trim().slice(0, 24);
    if (!title) return null;
    return {
      title: title,
      steps: [
        "今天迈出第一步（15 分钟版本）",
        "完成第一周，让节奏稳定下来",
        "完成第一个月，回顾并调整强度",
      ],
      source: "conversation",
    };
  }

  function fileFor(intent, text) {
    var d = new Date();
    var dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    if (intent === "travel") return {
      kind: "doc", title: "行程方案对比 · " + dateStr,
      body: "# 行程方案对比\n\n## 推荐方案 A（综合最优）\n- 去程：周五 08:30 直飞 ¥1,240\n- 返程：周日 19:10 直飞 ¥1,120\n- 住宿：旧城民宿两晚 ¥860\n- **合计 ¥3,220** · 退改友好\n\n## 备选方案 B（最省钱）\n- 中转一次，单程多 3 小时\n- **合计 ¥2,680** · 时间换钱\n\n## 备选方案 C（最舒适）\n- 最佳时段 + 高分酒店\n- **合计 ¥4,150**\n\n> 数据为演示内容。接入真实模型后，Lumi 会基于实时检索生成。",
    };
    if (intent === "purchase") return {
      kind: "doc", title: "比价小结 · " + (text || "").slice(0, 16),
      body: "# 比价小结\n\n| 平台 | 价格 | 备注 |\n|---|---|--- |\n| A 店 | ¥349 | 叠券最低，自营 |\n| B 店 | ¥399 | 送配件 |\n| C 店 | ¥452 | 第三方发货，谨慎 |\n\n**结论**：A 店价格进入历史低位区间（¥330–380），可以入手。\n\n> 数据为演示内容。接入真实模型后，Lumi 会基于实时检索生成。",
    };
    if (intent === "email") return {
      kind: "doc", title: "邮件草稿 · " + dateStr,
      body: "# 邮件草稿\n\n**主题**：关于合作事项的跟进\n\n王老师您好：\n\n感谢上次的沟通，很有收获。按我们聊到的方向，我整理了一版初步方案，附在邮件中，烦请您抽空过目。\n\n如有任何需要调整之处，随时告诉我。期待您的回复。\n\n祝好\n\n（草稿为演示内容，接入真实模型后由模型基于上下文起草。）",
    };
    if (intent === "create") return {
      kind: "doc", title: (text || "文档").slice(0, 20),
      body: "# " + (text || "新文档").slice(0, 30) + "\n\n## 结论\n\n（要点先行……）\n\n## 依据\n\n- 要点一\n- 要点二\n- 要点三\n\n## 下一步行动\n\n- [ ] 行动一\n- [ ] 行动二\n\n> 演示文档。接入真实模型后，这里将是模型为你撰写的内容。",
    };
    if (intent === "research") return {
      kind: "doc", title: "调研笔记 · " + (text || "").slice(0, 16),
      body: "# 调研笔记\n\n## 核心结论\n\n三源交叉验证后的要点……\n\n## 对比清单\n\n- 维度一：A 优于 B\n- 维度二：B 更灵活\n- 维度三：成本接近\n\n## 存疑之处\n\n某来源数据与主流说法不一致，未采信。\n\n> 演示笔记。接入真实模型后，Lumi 会基于实时检索生成真实内容。",
    };
    return null;
  }

  // ———————————————————————————— 电脑操作流（QCU 真实执行）————————————————————————————
  // 观察 → 模型规划 → 批准 → 执行 → 复核 → 收会话。
  // 返回的 promise resolve 后，ctx.computerSummary 已填好供作答引用。

  function runComputerFlow(task, text, steps, actMsgId, ctx, hooks) {
    var obs = null;          // 最近一次观察原文
    var actionPlan = null;   // 模型规划出的动作 {action:{type,params}, 说明}
    var sessionOk = false, executed = false, verifyLines = 0;

    function phase(idx, fn) {
      return function () {
        if (task.aborted) return;
        steps[idx].status = "active";
        hooks.patchActivity(actMsgId, {});
        var r;
        try { r = fn(); } catch (e) { r = Promise.reject(e); }
        return Promise.resolve(r).then(function () {
          if (task.aborted) return;
          steps[idx].status = "done";
          hooks.patchActivity(actMsgId, {});
        });
      };
    }

    var chain = Promise.resolve();

    // 步骤 0：启动 QCU 会话
    chain = chain.then(phase(0, function () {
      return qcuExec(["session", "start", "--context", "desktop"], task).then(function (r) {
        if (!r.ok) {
          steps[0].label = "启动 QCU 会话 —— 失败：" + String(r.error || r.stderr || "").slice(0, 90);
          store.audit("QCU 会话启动失败", String(r.error || r.stderr || "").slice(0, 120), "info");
          return;
        }
        sessionOk = true;
        store.audit("QCU 会话启动", "context=desktop", "info");
      });
    }));

    // 步骤 1：观察当前界面
    chain = chain.then(phase(1, function () {
      if (!sessionOk) { steps[1].label = "观察当前界面 —— 跳过（会话未建立）"; return; }
      return qcuExec(["observe", "--compact"], task).then(function (r) {
        if (r.ok) {
          obs = String(r.stdout || r.stderr || "");
          var dg = digestObservation(obs);
          steps[1].label = "观察当前界面 —— 捕获 " + dg.lineCount + " 行：" + (dg.sample.slice(0, 110) || "（空）");
          store.audit("QCU 观察", dg.lineCount + " 行无障碍树", "info");
        } else {
          steps[1].label = "观察当前界面 —— 失败：" + String(r.error || r.stderr || "").slice(0, 80);
        }
      });
    }));

    // 步骤 2：规划动作（需已接入模型）
    chain = chain.then(phase(2, function () {
      if (!obs) { steps[2].label = "规划下一步操作 —— 跳过（无观察数据）"; return; }
      var cfg = window.LumenAI.current();
      if (!cfg) { steps[2].label = "规划下一步操作 —— 接入模型后才能基于观察规划真实动作"; return; }
      var prompt = [
        "你是电脑操作规划器。用户目标：" + text,
        "以下是 QCU 无障碍树观察输出（节选）：",
        "<<<",
        obs.slice(0, 3500),
        ">>>",
        "请只输出一个 JSON 对象（不要任何多余文字），格式：",
        '{"action":{"type":"click 或 fill 或 toggle","params":{"ref":"从观察输出原样复制的 ref","text":"fill 时的文本","verify":{"kind":"text","contains":"预期文字"}}},"说明":"一句话解释"}',
        '若观察中没有合适元素，输出 {"none":true,"说明":"原因"}',
      ].join("\n");
      return window.LumenAI.chatStream({
        provider: cfg,
        messages: [{ role: "user", content: prompt }],
        signal: task.controller.signal,
        onDelta: function () {},
      }).then(function (reply) {
        var m = String(reply || "").match(/\{[\s\S]*\}/);
        if (m) {
          try {
            var parsed = JSON.parse(m[0]);
            if (parsed && parsed.action && parsed.action.type) {
              actionPlan = parsed;
              steps[2].label = "规划下一步操作 —— " + (parsed["说明"] || parsed.action.type);
              store.audit("QCU 动作规划", parsed.action.type + " · " + (parsed["说明"] || ""), "info");
              return;
            }
          } catch (e) { /* 落到未找到分支 */ }
        }
        steps[2].label = "规划下一步操作 —— 未找到可执行动作";
      }).catch(function (e) {
        if (task.aborted) return;
        steps[2].label = "规划下一步操作 —— 规划失败：" + String(e && e.message || e).slice(0, 60);
      });
    }));

    // 步骤 3：审批闸门（操作用户电脑永远需要批准，除非「总是允许」/全自动）
    chain = chain.then(function () {
      if (task.aborted) return;
      if (!actionPlan) {
        steps[3].status = "done";
        steps[3].label = "等待你的批准 —— 无待执行动作";
        hooks.patchActivity(actMsgId, {});
        return;
      }
      var skip = null;
      if (store.state.alwaysAllow.computer) skip = "你曾选择「总是允许」";
      else if (store.state.settings.autonomy === "auto") skip = "全自动模式";
      if (skip) {
        store.audit("操作你的电脑 · 自动放行", skip, "auto");
        steps[3].status = "done";
        steps[3].label = "等待你的批准 —— 按授权策略自动通过（" + skip + "）";
        hooks.patchActivity(actMsgId, {});
        return sleep(400, task);
      }
      steps[3].status = "blocked";
      hooks.patchActivity(actMsgId, {});
      store.audit("请求批准 · 操作你的电脑", actionPlan["说明"] || actionPlan.action.type, "info");
      return hooks.requestApproval({
        messageId: actMsgId,
        intent: "computer",
        risk: "computer",
        title: "操作你的电脑",
        detail: "Lumi 计划执行：" + (actionPlan["说明"] || "") + "\n动作：" + JSON.stringify(actionPlan.action).slice(0, 300),
      }).then(function (decision) {
        if (decision === "deny") { task.abort(); throw new Error("DENIED"); }
        if (decision === "always") {
          store.state.alwaysAllow.computer = true;
          store.save();
        }
        store.audit("已批准 · 操作你的电脑", decision === "always" ? "并记住为「总是允许」" : "仅此一次", "approved");
        steps[3].status = "done";
        hooks.patchActivity(actMsgId, {});
        return sleep(500, task);
      });
    });

    // 步骤 4：执行
    chain = chain.then(phase(4, function () {
      if (!actionPlan) { steps[4].label = "执行操作 —— 跳过"; return; }
      return qcuExec(["act", JSON.stringify(actionPlan.action)], task).then(function (r) {
        executed = !!r.ok;
        var out = String(r.stdout || r.stderr || r.error || "");
        steps[4].label = "执行操作 —— " + (r.ok ? "已下发（" + actionPlan.action.type + "）" : "失败：" + out.slice(0, 80));
        store.audit(r.ok ? "QCU 执行动作" : "QCU 动作失败", actionPlan.action.type + " · " + out.slice(0, 100), r.ok ? "done" : "info");
      });
    }));

    // 步骤 5：复核
    chain = chain.then(phase(5, function () {
      if (!executed || !sessionOk) { steps[5].label = "复核操作结果 —— 跳过"; return; }
      return qcuExec(["observe", "--compact"], task).then(function (r) {
        verifyLines = r.ok ? digestObservation(String(r.stdout || "")).lineCount : 0;
        steps[5].label = "复核操作结果 —— " + (r.ok ? "已复核（当前 " + verifyLines + " 行）" : "复核失败");
      });
    }));

    // 步骤 6：关闭会话 + 汇总上下文
    chain = chain.then(phase(6, function () {
      if (!sessionOk) { steps[6].label = "关闭会话 —— 跳过"; return; }
      return qcuExec(["session", "end"], task).then(function (r) {
        steps[6].label = "关闭会话 —— " + (r.ok ? "已关闭" : "关闭失败（不影响结果）");
      });
    }));

    chain = chain.then(function () {
      ctx.computerSummary =
        "QCU 会话" + (sessionOk ? "已启动" : "启动失败（本地服务桥或 qcu CLI 未就绪）") +
        "；观察" + (obs ? "获得 " + digestObservation(obs).lineCount + " 行无障碍树" : "未获得") +
        "；动作" + (actionPlan ? "规划为 " + actionPlan.action.type + (executed ? "并已执行" : "但未执行") : "未规划") + "。";
    });

    return chain;
  }

  // ———————————————————————————— 虚拟计算机流（LumenBox 真实执行）————————————————————————————
  // 唤醒 → 模型规划浏览动作 → 虚拟浏览器执行（真实检索/打开/点链接）→ 读页取证 → 存笔记。
  // 全程在 Lumi 自己的电脑里：不碰用户本机；隔离环境内浏览无需逐步审批，但每步写审计日志。

  function runVmFlow(task, text, steps, actMsgId, ctx, hooks) {
    var browseStep = steps[2];
    var pages = [];          // 证据页 {title,url,text}
    var actionsDone = 0;
    var MAX_ACTIONS = 4;
    var vmOnline = false;

    function phase(idx, fn) {
      return function () {
        if (task.aborted) return;
        steps[idx].status = "active";
        hooks.patchActivity(actMsgId, {});
        var r;
        try { r = fn(); } catch (e) { r = Promise.reject(e); }
        return Promise.resolve(r).then(function () {
          if (task.aborted) return;
          steps[idx].status = "done";
          hooks.patchActivity(actMsgId, {});
        });
      };
    }

    // 模型规划下一个浏览动作（未接模型时由演示路线替代）
    function planNextAction(observation) {
      var cfg = window.LumenAI.current();
      if (!cfg) return Promise.resolve(null);
      var prompt = [
        "你是虚拟浏览器的操作规划器，运行在 Lumi 自己的虚拟计算机里（与用户本机完全隔离）。",
        "用户目标：" + text,
        "",
        "虚拟浏览器当前观察：",
        "<<<",
        observation,
        ">>>",
        "已执行动作数：" + actionsDone + "/" + MAX_ACTIONS,
        "",
        "请只输出一个 JSON 对象（不要任何多余文字），从下列里选一个：",
        '{"op":"search","arg":{"query":"搜索词"},"why":"一句话"} —— 检索',
        '{"op":"open","arg":{"url":"https://…"},"why":"一句话"} —— 直接打开网址',
        '{"op":"click","arg":{"n":1},"why":"一句话"} —— 点击当前页第 n 个链接',
        '{"op":"done","why":"信息已足够的原因"} —— 结束浏览',
      ].join("\n");
      return window.LumenAI.chatStream({
        provider: cfg,
        messages: [{ role: "user", content: prompt }],
        signal: task.controller.signal,
        onDelta: function () {},
      }).then(function (reply) {
        var m = String(reply || "").match(/\{[\s\S]*\}/);
        if (!m) return null;
        try {
          var j = JSON.parse(m[0]);
          if (j && j.op) return j;
        } catch (e) {}
        return null;
      }).catch(function () { return null; });
    }

    // 执行一个浏览动作；打开真实页面时顺手 read 全文作为证据
    function doAction(act) {
      actionsDone++;
      var op = act.op, arg = act.arg || {};
      var p;
      if (op === "search") p = vmExec("browser", "search", { query: String(arg.query || "").slice(0, 100) }, task);
      else if (op === "open") p = vmExec("browser", "open", { url: String(arg.url || "") }, task);
      else if (op === "click") p = vmExec("browser", "click", { n: parseInt(arg.n, 10) }, task);
      else return Promise.resolve({ ok: true, skipped: true });

      return p.then(function (r) {
        if (task.aborted) return null;
        if (!r || !r.ok) {
          browseStep.label = "虚拟浏览器 —— " + op + " 失败：" + String(r && r.error || "").slice(0, 60);
          hooks.patchActivity(actMsgId, {});
          return null;
        }
        var page = r.page || {};
        if (page.url) { browseStep.url = page.url.replace(/^https?:\/\//, "").slice(0, 60); }
        browseStep.label = "虚拟浏览器 —— " + op + "：" + String(page.title || "").slice(0, 44) +
          "（第 " + actionsDone + "/" + MAX_ACTIONS + " 步）";
        browseStep.vbTitle = page.title || "";
        hooks.patchActivity(actMsgId, {});
        store.audit("虚拟计算机 · " + op, String(act.why || page.title || "").slice(0, 80), "info");

        // 真实网页 → 立即读取全文入证据；搜索结果页 → 结果清单本身就是证据
        if (page.kind === "search") {
          pages.push({ title: page.title, url: page.url, text: page.excerpt || "" });
          return r;
        }
        return vmExec("browser", "read", {}, task).then(function (rr) {
          if (rr && rr.ok && rr.page) {
            pages.push({ title: rr.page.title, url: rr.page.url, text: String(rr.page.text || "").slice(0, 2200) });
          }
          return r;
        });
      });
    }

    // 浏览主循环：模型接了就让它逐步决策；演示模式走固定真实路线（检索→点开第一条）
    function loop(prevResult) {
      if (task.aborted) return Promise.resolve();
      var cfg = window.LumenAI.current();
      if (!cfg) {
        // 演示路线：search → click(1)，两步都是真实执行
        if (actionsDone === 0) return doAction({ op: "search", arg: { query: text.replace(/帮我|请|一下|打开|看看|查查/g, "").slice(0, 40) }, why: "演示模式首轮检索" }).then(loop);
        if (actionsDone === 1) return doAction({ op: "click", arg: { n: 1 }, why: "演示模式：打开第一条结果" }).then(loop);
        return Promise.resolve();
      }
      if (actionsDone >= MAX_ACTIONS) return Promise.resolve();
      return planNextAction(vmObservation(prevResult)).then(function (act) {
        if (task.aborted) return;
        if (!act || act.op === "done") {
          if (act && act.why) store.audit("虚拟计算机 · 结束浏览", String(act.why).slice(0, 80), "info");
          return;
        }
        return doAction(act).then(function (r) { return r && r.skipped ? null : loop(r); });
      });
    }

    var chain = Promise.resolve();

    // 步骤 0：唤醒虚拟计算机
    chain = chain.then(phase(0, function () {
      return vmExec("browser", "state", {}, task).then(function (r) {
        if (!r || !r.ok) {
          vmOnline = false;
          steps[0].label = "唤醒虚拟计算机 —— 失败（需本地服务桥在线：node server.js）";
          store.audit("虚拟计算机唤醒失败", "本地服务桥未就绪", "info");
          return;
        }
        vmOnline = true;
        var hist = (r.history || []).length;
        steps[0].label = "唤醒虚拟计算机 —— 就绪（历史 " + hist + " 页 · 工作区 vm-home/）";
        store.audit("虚拟计算机唤醒", "LumenBox 在线，浏览将在隔离环境进行", "info");
      });
    }));

    // 步骤 1：规划浏览路线（首动作）
    var firstAction = null;
    chain = chain.then(phase(1, function () {
      if (!vmOnline) { steps[1].label = "规划浏览路线 —— 跳过（虚拟计算机未就绪）"; return; }
      var cfg = window.LumenAI.current();
      if (!cfg) { steps[1].label = "规划浏览路线 —— 演示模式（真实检索首轮）"; return; }
      return planNextAction("（虚拟浏览器刚唤醒，还没有打开页面）").then(function (act) {
        firstAction = act;
        steps[1].label = "规划浏览路线 —— " + (act ? (act.op + "：" + String(act.arg && (act.arg.query || act.arg.url) || act.arg && act.arg.n || "").slice(0, 40)) : "模型未给出动作，走兜底检索");
        hooks.patchActivity(actMsgId, {});
      });
    }));

    // 步骤 2：浏览主循环
    chain = chain.then(phase(2, function () {
      if (!vmOnline) { steps[2].label = "虚拟浏览器 —— 跳过"; return; }
      var start;
      if (firstAction && firstAction.op !== "done") start = doAction(firstAction).then(function (r) { return r && r.skipped ? null : loop(r); });
      else if (!firstAction) start = loop(null); // 模型没接/没给动作 → 演示或兜底
      else start = Promise.resolve();
      return start.then(function () {
        if (task.aborted) return;
        if (!pages.length) steps[2].label = "虚拟浏览器 —— 未取得页面（引擎限流或目标不可达）";
      });
    }));

    // 步骤 3：证据汇总
    chain = chain.then(phase(3, function () {
      if (!pages.length) { steps[3].label = "阅读页面并提取证据 —— 无证据页"; return; }
      steps[3].label = "阅读页面并提取证据 —— " + pages.length + " 页";
      var seen = {};
      var uniq = pages.filter(function (p) { if (seen[p.url]) return false; seen[p.url] = true; return true; });
      ctx.evidence = ("【虚拟计算机浏览取证 · " + uniq.length + " 页】\n" + uniq.map(function (p, i) {
        return "— 第 " + (i + 1) + " 页：" + p.title + "（" + p.url + "）\n" + String(p.text || "").slice(0, 2000);
      }).join("\n\n")).slice(0, 9000);
      uniq.forEach(function (p) { store.audit("虚拟计算机 · 阅读", p.title.slice(0, 40), "info"); });
    }));

    // 步骤 4：笔记落盘到虚拟工作区
    chain = chain.then(phase(4, function () {
      if (!vmOnline || !ctx.evidence) { steps[4].label = "把笔记存进虚拟工作区 —— 跳过"; return; }
      var d = new Date();
      var dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      var fname = "notes/" + dateStr + "-" + (text || "浏览").replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 16) + ".md";
      var content = "# 虚拟计算机浏览笔记 · " + dateStr + "\n\n> 任务：" + text + "\n> 由 Lumi 在自己的虚拟计算机（LumenBox）上完成，未触碰用户本机。\n\n" + ctx.evidence;
      return vmExec("files", "write", { name: fname, content: content }, task).then(function (r) {
        if (r && r.ok) {
          steps[4].label = "把笔记存进虚拟工作区 —— " + fname;
          ctx.vmNoteFile = fname;
          store.audit("虚拟计算机 · 存档", fname, "done");
        } else {
          steps[4].label = "把笔记存进虚拟工作区 —— 失败：" + String(r && r.error || "").slice(0, 50);
        }
      });
    }));

    // 步骤 5：收工汇总
    chain = chain.then(phase(5, function () {
      var n = pages.length;
      ctx.computerSummary = vmOnline
        ? "本任务在 Lumi 自己的虚拟计算机（LumenBox）上完成：执行 " + actionsDone + " 次浏览动作，阅读 " + n + " 个页面" +
          (ctx.vmNoteFile ? "，笔记已存入工作区 " + ctx.vmNoteFile : "") + "。全程在隔离环境内，未操控用户本机（需要动真机应用时可说「用我的电脑操作」，走 QCU 并逐步请示）。"
        : "虚拟计算机未能唤醒（本地服务桥未启动），本次未执行浏览。";
      steps[5].label = vmOnline ? "收工 —— 全程在虚拟计算机内完成，你的电脑原封未动" : "收工 —— 虚拟计算机离线，任务未执行";
    }));

    return chain;
  }

  // ———————————————————————————— 桌面虚拟机流（LumenBox Desktop）————————————————————————————
  // 任务循环跑在服务桥（宿主）里，浏览器只是遥控器（应用只是遥控器）。
  // 每个动作先经宿主 Sentinel 审查：放行 / 阻止 / 交用户批准（审批卡复用聊天 UI）。
  // 关掉浏览器任务也继续，回聊天页能看到结果与审计。

  function desktopApi(pathname, method, body, task) {
    return fetch(bridgeBase() + pathname, {
      method: method || "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: task ? task.controller.signal : undefined,
    }).then(function (r) { return r.json(); })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  function runDesktopFlow(task, text, steps, actMsgId, ctx, hooks) {
    var browseStep = steps[2];
    var taskId = null;
    var surfacedApproval = null; // 当前已弹卡的审批 id
    var lastSeenStepCount = 0;

    function phase(idx, fn) {
      return function () {
        if (task.aborted) return;
        steps[idx].status = "active";
        hooks.patchActivity(actMsgId, {});
        var r;
        try { r = fn(); } catch (e) { r = Promise.reject(e); }
        return Promise.resolve(r).then(function () {
          if (task.aborted) return;
          steps[idx].status = "done";
          hooks.patchActivity(actMsgId, {});
        });
      };
    }

    // 轮询：把服务端任务的步骤映射进活动卡；审批经聊天审批卡回传
    function poll(resolve) {
      if (task.aborted) {
        if (taskId) desktopApi("/vm/desktop/tasks/" + taskId + "/stop", "POST", {}, null);
        return resolve();
      }
      desktopApi("/vm/desktop/tasks", "GET", null, task).then(function (d) {
        var t = null;
        if (d && d.tasks) {
          for (var i = 0; i < d.tasks.length; i++) if (d.tasks[i].id === taskId) { t = d.tasks[i]; break; }
        }
        if (task.aborted || !t) { resolve(); return; }

        // 步骤进度 → 活动卡
        var dt = t.steps || [];
        if (dt.length !== lastSeenStepCount) {
          lastSeenStepCount = dt.length;
          var last = dt[dt.length - 1] || {};
          browseStep.label = "虚拟机桌面 —— [" + dt.length + "] " + String(last.label || "").slice(0, 80);
          if (t.shot) browseStep.vbTitle = "桌面截图已存档（计算机页可看）";
          hooks.patchActivity(actMsgId, {});
          store.audit("桌面虚拟机 · 步骤", String(last.label || "").slice(0, 90), "info");
        }

        // Sentinel 审批 → 聊天审批卡（弹窗在客户端界面而非对话里）
        if (t.pendingApproval && (!surfacedApproval || surfacedApproval !== t.pendingApproval.id)) {
          surfacedApproval = t.pendingApproval.id;
          var ap = t.pendingApproval;
          store.audit("请求批准 · " + ap.title, ap.detail.slice(0, 100), "info");
          hooks.requestApproval({
            messageId: actMsgId,
            intent: "computer",
            risk: "computer",
            title: ap.title + "（Sentinel）",
            detail: ap.detail,
          }).then(function (decision) {
            surfacedApproval = null;
            return desktopApi("/vm/desktop/tasks/" + taskId + "/approve", "POST",
              { decision: decision === "deny" ? "deny" : "allow" }, null);
          }).catch(function () {});
        } else if (!t.pendingApproval) {
          surfacedApproval = null;
        }

        if (t.status === "done" || t.status === "failed" || t.status === "stopped") {
          resolve(t);
          return;
        }
        setTimeout(function () { poll(resolve); }, 1600);
      }).catch(function () {
        setTimeout(function () { poll(resolve); }, 2500);
      });
    }

    var chain = Promise.resolve();

    // 步骤 0+1：确认桌面虚拟机在线并登记任务
    chain = chain.then(phase(0, function () {
      return desktopApi("/vm/desktop/status", "GET", null, task).then(function (st) {
        if (!st || !st.daemon) {
          steps[0].label = "唤醒桌面虚拟机 —— Docker 未运行（请启动 Docker Desktop 后重试）";
          return "no-docker";
        }
        if (st.state === "running") {
          steps[0].label = "唤醒桌面虚拟机 —— 在线（Live 画面见「计算机」页）";
          return "ok";
        }
        steps[0].label = "唤醒桌面虚拟机 —— 正在启动容器（首次需构建镜像，耐心等待）";
        return desktopApi("/vm/desktop/start", "POST", {}, task).then(function (r) {
          return r && r.ok ? "ok" : "fail:" + String(r && r.error || "").slice(0, 90);
        });
      });
    }));

    chain = chain.then(phase(1, function () {
      // phase0 的结果经由 steps[0].label 判断（简化传参）
      if (/失败|Docker 未运行/.test(steps[0].label)) {
        steps[1].label = "向 Sentinel 登记任务 —— 跳过（虚拟机不可用）";
        steps[2].label = "虚拟机桌面 —— 未执行";
        return;
      }
      return desktopApi("/vm/desktop/tasks", "POST", { goal: text.slice(0, 280) }, task).then(function (t) {
        if (t && t.id) {
          taskId = t.id;
          steps[1].label = "向 Sentinel 登记任务 —— 已登记（任务号 " + t.id + " · 服务端执行，关页不中断）";
          store.audit("创建桌面任务", text.slice(0, 60) + " · " + t.id, "info");
        } else {
          steps[1].label = "向 Sentinel 登记任务 —— 失败：" + String(t && t.error || "").slice(0, 80);
        }
      });
    }));

    // 步骤 2-3：轮询执行（任务在服务端跑）
    chain = chain.then(phase(2, function () {
      if (!taskId) { steps[2].label = "虚拟机桌面 —— 未执行"; return; }
      return new Promise(function (resolve) { poll(resolve); }).then(function (t) {
        if (!t) return;
        if (t.status === "stopped" || task.aborted) {
          steps[2].label = "虚拟机桌面 —— 已停止";
          return;
        }
        steps[2].label = "虚拟机桌面 —— " + (t.status === "failed" ? "失败" : "执行完毕") +
          "（" + (t.steps || []).length + " 步 · 模型 " + (t.modelCalls || 0) + " 次）";
        hooks.patchActivity(actMsgId, {});
        // 证据
        var ev = (t.evidence || []).filter(function (e) { return e.text; });
        if (ev.length) {
          ctx.evidence = ("【桌面虚拟机取证 · " + ev.length + " 页（Sentinel 全程审查）】\n" +
            ev.map(function (e, i) {
              return "— 第 " + (i + 1) + " 页：" + e.title + "（" + e.url + "）\n" + String(e.text || "").slice(0, 1800);
            }).join("\n\n")).slice(0, 9000);
        }
        ctx.desktopSummary = t.summary || "";
        ctx.desktopNote = t.noteFile || "";
      });
    }));

    // 步骤 3：证据标注
    chain = chain.then(phase(3, function () {
      var n = (ctx.evidence ? String(ctx.evidence).split("— 第 ").length - 1 : 0);
      steps[3].label = "收集证据 —— " + n + " 页（每个动作都经 Sentinel：放行/阻止/请示）" ;
    }));

    // 步骤 4：笔记（服务端已写入工作区）
    chain = chain.then(phase(4, function () {
      if (ctx.desktopNote) steps[4].label = "笔记存入虚拟工作区 —— " + ctx.desktopNote;
      else steps[4].label = "笔记存入虚拟工作区 —— 无证据页，跳过";
    }));

    // 步骤 5：收工
    chain = chain.then(phase(5, function () {
      ctx.computerSummary = ctx.desktopSummary
        ? ("任务在桌面虚拟机上完成：" + ctx.desktopSummary +
          (ctx.desktopNote ? "；笔记已存入 " + ctx.desktopNote : "") +
          "。全程未触碰用户本机；敏感动作经 Sentinel 审查。")
        : "桌面虚拟机任务未完成（虚拟机不可用或被停止）。";
      steps[5].label = ctx.desktopSummary ? "收工 —— 你的电脑原封未动，全程可审计" : "收工 —— 任务未执行";
    }));

    return chain;
  }

  // ———————————————————————————— 任务执行 ————————————————————————————

  var running = 0;
  var activeTasks = []; // 支持并行任务（不必等上一件事做完）

  function sleep(ms, task) {
    return new Promise(function (resolve) {
      function cleanup() {
        var i = task.abortSignals.indexOf(wrap);
        if (i !== -1) task.abortSignals.splice(i, 1);
      }
      var timer = setTimeout(function () { cleanup(); resolve(); }, ms);
      function wrap() { clearTimeout(timer); cleanup(); resolve(); }
      task.abortSignals.push(wrap);
    });
  }

  function makeTask() {
    var task = { aborted: false, abortSignals: [], controller: new AbortController() };
    task.abort = function () {
      task.aborted = true;
      task.controller.abort();
      var sigs = task.abortSignals.slice();
      for (var i = 0; i < sigs.length; i++) sigs[i]();
    };
    activeTasks.push(task);
    return task;
  }

  function shouldAskApproval(intent) {
    var s = store.state.settings;
    var apType = (APPROVALS[intent] || APPROVALS.general).type;
    if (store.state.alwaysAllow[apType]) return { ask: false, mode: "always" };
    if (s.autonomy === "auto") return { ask: false, mode: "auto" };
    if (s.autonomy === "sensitive" && !CRITICAL[intent]) return { ask: false, mode: "auto" };
    return { ask: true, mode: "ask" };
  }

  /**
   * runTask —— 执行一次完整任务
   * hooks: {
   *   activity(actMsg)          创建活动卡（返回 DOM 绑定由 UI 负责）
   *   patchActivity(id, patch)  更新活动卡
   *   requestApproval(payload)  弹审批卡 → Promise<'once'|'always'|'deny'>
   *   streamStart(id) / streamDelta(id, text) / streamEnd(id)
   *   refresh(tab)              副作用后刷新其他 Tab
   *   toast(text)
   * }
   */
  function runTask(text, hooks) {
    var task = makeTask();
    // 任务绑定发起时的会话：运行期间用户切了新对话，本任务仍写回原会话
    var conv = store.activeConversation();
    var intent = classify(text);
    // 电脑操作三路分发：桌面虚拟机（GUI 任务·容器隔离）> 虚拟计算机（轻量检索）> QCU（真机·逐步请示）
    var env = "qcu";
    if (intent === "computer") {
      if (desktopPreferred(text)) env = "desktop";
      else if (preferVm(text)) env = "vm";
    }
    var steps = buildPlan(text, intent, env);
    // —— 应用连接拦截：飞书 / Google 邮件日历（真实 API 动作优先于演示流）——
    var conn = (intent !== "computer" && intent !== "monitor") ? matchConnector(text) : null;
    if (conn) {
      steps = [
        { name: "连接检查 —— " + connLabel(conn), status: "pending" },
        { name: "整理参数", status: "pending" },
        { name: "对外发送 · 批准", status: "pending" },
        { name: connLabel(conn) + " —— 真实调用", status: "pending" },
      ];
    }
    var actMsgId = null;

    running++;
    hooks.onRunningChange(running);

    var ctx = {}; // 意图专属上下文（电脑操作流会把 QCU/VM 结果摘要放进来）

    // —— 第 1 幕：活动小剧场（代理在虚拟计算机上一步步做事）——
    var act = store.addMessageTo(conv.id, { role: "activity", steps: steps, intent: intent, state: "running", env: env });
    actMsgId = act.id;
    hooks.activity(act);

    var chain;
    if (intent === "computer") {
      // 电脑操作：桌面虚拟机流 / 轻量虚拟计算机流 / QCU 真机流
      chain = env === "desktop" ? runDesktopFlow(task, text, steps, actMsgId, ctx, hooks)
           : env === "vm" ? runVmFlow(task, text, steps, actMsgId, ctx, hooks)
           : runComputerFlow(task, text, steps, actMsgId, ctx, hooks);
    } else if (conn) {
      // 应用连接：飞书 / Google 真实 API 动作（自带审批门）
      chain = runConnectorFlow(task, text, conn, steps, actMsgId, ctx, hooks);
    } else {
      chain = Promise.resolve();
    }
    if (intent !== "computer" && !conn) steps.forEach(function (step, idx) {
      chain = chain.then(function () {
        if (task.aborted) return;
        // —— 审批闸门 ——
        if (step.approval) {
          // 先查动作规则（对标 dots：允许/先问/转交本人）
          var rule = matchRule(step.approval.title + " " + step.approval.type + " " + intent);
          if (rule && rule.mode === "auto") {
            store.audit("规则放行 · " + step.approval.title, "规则「" + rule.keywords + "」：无需询问", "auto");
            step.status = "done";
            hooks.patchActivity(actMsgId, { autoNote: "「" + step.approval.title + "」按规则「" + rule.keywords + "」直接放行" });
            return sleep(400, task);
          }
          if (rule && rule.mode === "handoff") {
            store.audit("规则转交本人 · " + step.approval.title, "规则「" + rule.keywords + "」", "denied");
            step.status = "done";
            hooks.patchActivity(actMsgId, { autoNote: "「" + step.approval.title + "」按规则「" + rule.keywords + "」转交你本人执行" });
            var ho = store.addMessageTo(conv.id, { role: "agent", text: "按你设定的规则，「" + step.approval.title + "」我碰都不碰——这一步转交你本人执行。\n\n（到 设置 → 规则与审批 可调整这条规则）" });
            hooks.streamStart(ho);
            hooks.streamEnd(ho.id);
            return sleep(300, task);
          }
          var gate = shouldAskApproval(intent);
          if (gate.mode === "always" || gate.mode === "auto") {
            store.audit(step.approval.title, "自主策略：" + (gate.mode === "always" ? "你曾选择「总是允许」" : "全自动模式"), gate.mode === "always" ? "approved" : "auto");
            step.status = "done";
            hooks.patchActivity(actMsgId, { autoNote: "「" + step.approval.title + "」按你的授权策略自动通过" });
            return sleep(500, task);
          }
          step.status = "blocked";
          hooks.patchActivity(actMsgId, {});
          store.audit("请求批准 · " + step.approval.title, step.approval.detail, "info");
          return hooks.requestApproval({
            messageId: actMsgId,
            intent: intent,
            risk: step.approval.type,
            title: step.approval.title,
            detail: step.approval.detail,
          }).then(function (decision) {
            if (decision === "deny") {
              task.abort();
              throw new Error("DENIED");
            }
            if (decision === "always") {
              store.state.alwaysAllow[step.approval.type] = true;
              store.save();
            }
            store.audit("已批准 · " + step.approval.title, decision === "always" ? "并记住为「总是允许」" : "仅此一次", "approved");
            step.status = "done";
            hooks.patchActivity(actMsgId, {});
            return sleep(600, task);
          });
        }
        step.status = "active";
        hooks.patchActivity(actMsgId, { activeStep: idx });
        var dur = rd(900, 2000);
        return sleep(dur, task).then(function () {
          if (task.aborted) return;
          step.status = "done";
          hooks.patchActivity(actMsgId, {});
        });
      });
    });

    // —— 第 1.5 幕：真实联网取证（研究类意图 + 已接模型 + 服务桥在线）——
    chain = chain.then(function () {
      if (task.aborted) return;
      if (!RESEARCHY[intent]) return;
      if (!window.LumenAI.current()) return; // 演示模式不检索，走罐头
      if (!window.LumenSkills || !window.LumenSkills.online) return; // 服务桥不在线
      return gatherEvidence(task, text, intent, steps, actMsgId, ctx, hooks);
    });

    // —— 第 1.6 幕：常驻监控任务（后台常驻执行）——
    chain = chain.then(function () {
      if (task.aborted || intent !== "monitor") return;
      var base = window.LumenBridgeBase || BRIDGE;
      var monSteps = steps;
      monSteps[1].status = "active";
      hooks.patchActivity(actMsgId, {});
      return fetch(base + "/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text.slice(0, 100), condition: text.slice(0, 150), intervalMin: 30 }),
        signal: task.controller.signal,
      }).then(function (r) { return r.json(); }).then(function (t) {
        if (task.aborted) return;
        monSteps[1].status = "done";
        if (t && t.id) {
          monSteps[1].label = "在服务桥注册 7×24 后台任务 —— 已注册（每 " + t.intervalMin + " 分钟）";
          monSteps[2].label = "首轮基线检索 —— 5 秒后自动开始（结果可在目标页查看）";
          monSteps[3].label = "安排持续跟踪节奏 —— 常驻运行，关闭页面不中断";
          store.audit("创建后台监控", text.slice(0, 60) + " · 每 " + t.intervalMin + " 分钟", "done");
          ctx.monitorTask = t;
          hooks.refresh(["goals", "feed"]);
        } else {
          monSteps[1].label = "注册后台任务 —— 失败（需本地服务桥在线）：" + String(t && t.error || "").slice(0, 60);
        }
        hooks.patchActivity(actMsgId, {});
      }).catch(function (e) {
        if (task.aborted) return;
        monSteps[1].status = "done";
        monSteps[1].label = "注册后台任务 —— 失败（本地服务桥未启动）";
        hooks.patchActivity(actMsgId, {});
      });
    });

    // —— 第 1.7 幕：深度记忆召回（Hindsight 开启时，检索相关记忆注入作答）——
    chain = chain.then(function () {
      if (task.aborted) return;
      if (!window.LumenAI.current()) return; // 演示模式没有模型作答，无需检索
      return hsActive().then(function (on) {
        if (!on || task.aborted) return;
        return hsRecall(text, task).then(function (d) {
          if (task.aborted || !d || !d.ok) return;
          var mems = (d.results || []).filter(function (m) { return m && m.text; });
          if (!mems.length) return;
          ctx.hsMemories = mems.slice(0, 10);
          store.audit("Hindsight 记忆召回", "命中 " + ctx.hsMemories.length + " 条", "info");
        }).catch(function () { /* 记忆服务不在线不影响对话 */ });
      });
    });

    // —— 第 2 幕：作答（真实模型流式 / 演示引擎打字机）——
    chain = chain.then(function () {
      if (task.aborted) return;
      var reply = store.addMessageTo(conv.id, { role: "agent", text: "" });
      hooks.streamStart(reply);

      var cfg = window.LumenAI.current();
      var speak;
      if (ctx.connectorResult) {
        // 应用连接：结果由真实 API 返回，确定性汇报（不让模型自由发挥）
        var ctext = ctx.connectorResult.text || "";
        var cpos = 0;
        function connType() {
          if (task.aborted || cpos >= ctext.length) return Promise.resolve();
          var n = Math.min(2 + Math.floor(Math.random() * 3), ctext.length - cpos);
          hooks.streamDelta(reply.id, ctext.slice(cpos, cpos + n));
          cpos += n;
          return sleep(rd(15, 35), task).then(connType);
        }
        speak = connType().then(function () {
          store.updateMessageIn(conv.id, reply.id, { text: ctext });
          return ctext;
        });
      } else if (cfg) {
        // 真实模型：带上最近对话上下文（从任务所属会话读取，而非当前活跃会话）
        var history = conv.messages
          .filter(function (m) { return (m.role === "user" || m.role === "agent") && m.text && m.id !== reply.id; })
          .slice(-12)
          .map(function (m) {
            return { role: m.role === "agent" ? "assistant" : "user", content: m.text + (m.attachText || "") };
          });
        var messages = [{ role: "system", content: systemPrompt() }].concat(history);
        if (ctx.computerSummary) {
          messages.push({ role: "system", content: "（电脑操作执行摘要，作答时请参考）" + ctx.computerSummary });
        }
        if (ctx.evidence) {
          messages.push({ role: "system", content: "以下是刚刚联网检索到的真实资料（含来源链接）。作答必须以此为准，标注来源编号，检索未覆盖的信息要明说「未检索到」：" + ctx.evidence });
        }
        if (ctx.hsMemories) {
          messages.push({ role: "system", content: "以下是从长期记忆（Hindsight）检索到的与本次对话相关的记忆（自然运用，勿生硬复述；若与用户当前所说冲突，以用户为准）：\n" +
            ctx.hsMemories.map(function (m) { return "· [" + (m.type || "记忆") + "] " + m.text; }).join("\n") });
        }
        store.audit("调用模型", cfg.name + " · " + cfg.model, "info");
        var acc = "";
        speak = window.LumenAI.chatStream({
          provider: cfg,
          messages: messages,
          signal: task.controller.signal,
          onDelta: function (d) {
            acc += d;
            hooks.streamDelta(reply.id, d);
          },
        }).then(function () {
          store.updateMessageIn(conv.id, reply.id, { text: acc });
          ctx.modelAnswer = acc; // 真实回答 → 第 3 幕据此生成真实文档
          store.addUsage(messages.reduce(function (n, m) { return n + (m.content || "").length; }, 0), acc.length); // 用量计
          return acc;
        }).catch(function (err) {
          if (task.aborted) {
            // 中断：保留已经流出的部分，追加中断标记
            var partial = acc + "\n\n*（已中断）*";
            store.updateMessageIn(conv.id, reply.id, { text: partial });
            return partial;
          }
          var fallback = "⚠️ 模型调用失败：" + (err && err.message) + "\n\n以下由本地演示引擎接管：\n\n" + demoAnswer(text, intent);
          hooks.streamDelta(reply.id, fallback);
          store.updateMessageIn(conv.id, reply.id, { text: fallback });
          return fallback;
        });
      } else {
        // 演示引擎：打字机节奏吐字
        store.audit("演示引擎应答", "意图：" + intent + "（未接入模型）", "info");
        var full = demoAnswer(text, intent)
          .replace("{qcu}", ctx.computerSummary || "（未获得输出——请确认本地服务桥已启动、qcu CLI 可用）")
          .replace("{monstate}", ctx.monitorTask ? "已创建 ✅（任务号 " + ctx.monitorTask.id + "）" : "创建失败（本地服务桥未启动）");
        var acc = "";
        var i = 0;
        function typeChunk() {
          if (task.aborted) return Promise.resolve();
          var n = 2 + Math.floor(Math.random() * 3);
          var chunk = full.slice(i, i + n);
          i += n;
          acc += chunk;
          hooks.streamDelta(reply.id, chunk);
          if (i < full.length) return sleep(rd(18, 42), task).then(typeChunk);
          return Promise.resolve();
        }
        speak = typeChunk().then(function () {
          var finalText = acc || full;
          store.updateMessageIn(conv.id, reply.id, { text: finalText });
          return finalText;
        });
      }
      return speak.then(function () { hooks.streamEnd(reply.id); });
    });

    // —— 第 3 幕：副作用沉淀（目标 / 真实产物 / 审计）——
    chain = chain.then(function () {
      if (task.aborted) return;
      var changed = [];
      var goal = extractGoal(text, intent);
      if (goal) {
        store.addGoal(goal);
        store.audit("创建目标", goal.title, "done");
        changed.push("goals");
        hooks.toast("已把「" + goal.title + "」加入目标 🎯");
      }
      if (intent === "paint") {
        var url = window.MonetBG ? window.MonetBG.paintPicture(640, 400, 6) : "";
        store.addFile({ kind: "art", title: "睡莲 · 即兴之作", dataURL: url, body: "Lumi 用莫奈色板即兴点彩的一幅小画。每次落笔都不同，仅此一幅。" });
        store.audit("生成画作", "印象派点彩 · 640×400", "done");
        changed.push("files");
      } else if (ctx.modelAnswer && window.LumenAI.current()) {
        // —— 真实模式：文档 = 模型真实回答全文（含联网来源）——
        var ftitle = deriveTitle(text, ctx.modelAnswer);
        store.addFile({ kind: "doc", title: ftitle, body: ctx.modelAnswer, source: "model" });
        store.audit("生成文档 · 真实", ftitle + (ctx.evidence ? " · 含联网来源" : ""), "done");
        changed.push("files");

        // schedule → 真实 .ics 日历事件（可导入系统日历）
        if (intent === "schedule") {
          window.LumenAI.chatStream({
            provider: window.LumenAI.current(),
            messages: [{
              role: "user",
              content: "根据下面的任务与回答提取一个日历事件。只输出 JSON（不要任何多余文字），格式：" +
                '{"title":"日程标题","startISO":"2026-10-08T12:00","durationMin":60,"location":"没有则留空","notes":"没有则留空"}' +
                "\n\n任务：" + text + "\n\n回答：" + ctx.modelAnswer.slice(0, 1500),
            }],
            signal: task.controller.signal,
            onDelta: function () {},
          }).then(function (rep) {
            var m = String(rep || "").match(/\{[\s\S]*\}/);
            if (!m) return;
            try {
              var ev = JSON.parse(m[0]);
              var ics = buildIcs(ev);
              if (ics) {
                store.addFile({ kind: "event", title: ev.title || "日程", body: ics, source: "model" });
                store.audit("生成日历事件 · 真实", (ev.title || "") + " · " + ev.startISO, "done");
                hooks.toast("已生成日历事件 .ics，到文件页可下载导入日历 📅");
                hooks.refresh(["files", "feed"]);
              }
            } catch (e) { /* JSON 解析失败就静默跳过 */ }
          }).catch(function () {});
        }
        // email → 真实 .eml 邮件草稿（可导入邮件客户端继续编辑发送）
        if (intent === "email") {
          var subj = deriveTitle(text, ctx.modelAnswer);
          store.addFile({ kind: "mail", title: subj, body: buildEml(subj, ctx.modelAnswer), source: "model" });
          store.audit("生成邮件草稿 · 真实", subj, "done");
          changed.push("files");
          hooks.toast("已生成邮件草稿 .eml，到文件页下载后用邮件客户端打开 ✉️");
        }
      } else {
        // 演示模式：罐头文档（内含「演示内容」声明）
        var file = fileFor(intent, text);
        if (file) {
          store.addFile(file);
          store.audit("生成文档 · 演示", file.title, "info");
          changed.push("files");
        }
      }
      if (changed.length) hooks.refresh(changed);
    });

    // —— 第 4 幕：记忆沉淀（长期记忆：越用越懂你，可查看/遗忘）——
    chain = chain.then(function () {
      if (task.aborted) return;
      if (!ctx.modelAnswer || !window.LumenAI.current()) return;
      if (intent === "monitor" || intent === "computer") return; // 这两类任务不产用户记忆
      return window.LumenAI.chatStream({
        provider: window.LumenAI.current(),
        messages: [{
          role: "user",
          content: "从下面的对话中提取值得长期记住的用户信息（偏好、事实、关系、习惯）。只输出 JSON，没有值得记的就输出 " +
            '{"none":true}。格式：{"memories":[{"text":"简短一条","kind":"偏好|事实|关系|习惯"}]}' +
            "\n\n用户说：" + text + "\n\n你的回答（节选）：" + String(ctx.modelAnswer).slice(0, 800),
        }],
        signal: task.controller.signal,
        onDelta: function () {},
      }).then(function (rep) {
        var m = String(rep || "").match(/\{[\s\S]*\}/);
        if (!m) return;
        try {
          var j = JSON.parse(m[0]);
          var added = 0;
          (j.memories || []).slice(0, 3).forEach(function (mm) {
            if (mm && mm.text && store.addMemory(mm.text, mm.kind || "事实", "conversation")) added++;
          });
          if (added) {
            store.audit("沉淀 " + added + " 条长期记忆", "可在「记忆」页查看、编辑或遗忘", "done");
            hooks.refresh(["memory"]);
            hooks.toast("我记住了 " + added + " 条关于你的信息 🧠（记忆页可管理）");
          }
        } catch (e) { /* 解析失败静默 */ }
      }).catch(function () { /* 记忆提取失败不影响任务 */ });
    });

    // —— 第 4.5 幕：Hindsight 深度记忆沉淀（原始对话交给它抽取事实/经历/观察）——
    chain = chain.then(function () {
      if (task.aborted) return;
      if (!ctx.modelAnswer && !ctx.computerSummary && !ctx.connectorResult) return;
      return hsActive().then(function (on) {
        if (!on) return;
        var answer = String(ctx.modelAnswer || ctx.connectorResult && ctx.connectorResult.text || ctx.computerSummary || "");
        var content = "用户：" + text + "\n\nLumi：" + answer.slice(0, 2500);
        return hsRetain(content, "对话 · " + intent).then(function (d) {
          if (d && d.ok) store.audit("Hindsight 记忆沉淀", "本轮对话已入长期记忆库", "done");
        }).catch(function () { /* 沉淀失败不影响任务 */ });
      });
    });

    // —— 收尾 ——
    chain.then(function () {
      // 用户主动中断时链是正常 resolve 的（各环节被 aborted 检查跳过），
      // 必须在这里区分，否则中断会被错误显示为「完成」
      if (task.aborted) {
        store.audit("任务中断", "用户中断", "info");
        finish("aborted");
      } else {
        finish("done");
      }
    }).catch(function (err) {
      if (err && err.message === "DENIED") {
        store.updateMessageIn(conv.id, actMsgId, { state: "denied" });
        store.audit("任务终止", "你拒绝了关键动作的授权", "denied");
        var dm = store.addMessageTo(conv.id, { role: "agent", text: "好的，这一步我停下了 ✋\n\n没有你的批准，花钱和对外发送的事我不会做。你可以换个方式让我继续——比如「只查不下单」「先生成草稿不发」。" });
        hooks.streamStart(dm);
        hooks.streamEnd(dm.id);
        finish("denied");
      } else {
        store.updateMessageIn(conv.id, actMsgId, { state: "aborted" });
        store.audit("任务中断", err && err.message ? String(err.message) : "用户中断", "info");
        finish("aborted");
      }
    });

    function finish(endState) {
      store.updateMessageIn(conv.id, actMsgId, { state: endState });
      if (endState === "done") notifyUser("✅ Lumi 任务完成", (text || "").slice(0, 60));
      running = Math.max(0, running - 1);
      hooks.onRunningChange(running);
      activeTasks = activeTasks.filter(function (t) { return t !== task; });
      hooks.patchActivity(actMsgId, {});
      hooks.refresh(["goals", "files", "feed"]);
    }

    return task;
  }

  function interruptAll() {
    activeTasks.slice().forEach(function (t) { t.abort(); });
  }

  window.LumenAgent = {
    classify: classify,
    buildPlan: buildPlan,
    runTask: runTask,
    interruptAll: interruptAll,
    get running() { return running; },
  };
})();
