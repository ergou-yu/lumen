/* ============================================================
   providers.js —— 多模型接入层
   统一的 chatStream()：不管接哪家，上层（agent.js）只管传消息收增量。
   · openai 型：/chat/completions + SSE（OpenAI / DeepSeek / Kimi / 通义 / 智谱 / 自定义兼容端点）
   · anthropic 型：/messages + SSE（需带浏览器直连专用头）
   · gemini 型：:streamGenerateContent?alt=sse
   全部从浏览器直连，不经任何服务器——密钥只存在你的 localStorage。
   ============================================================ */
(function () {
  "use strict";

  // —— 预置服务商（baseUrl / 默认模型均可改）——
  var PRESETS = {
    openai: {
      name: "OpenAI",
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5", "gpt-5.3-chat-latest"],
    },
    anthropic: {
      name: "Anthropic Claude",
      type: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5", "claude-opus-4-6"],
    },
    gemini: {
      name: "Google Gemini",
      type: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      models: ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.8-flash"],
    },
    zai: {
      name: "Z.ai 智谱 GLM",
      type: "openai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      models: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5", "glm-4.7-flash"],
    },
    localgw: {
      name: "本地网关（server.js）",
      type: "anthropic",
      // 适用场景：你选的模型端点不支持浏览器 CORS 时，经本目录 server.js 转发
      //（需在启动服务桥时用环境变量提供你自己的密钥：LUMEN_MODEL_API_KEY / LUMEN_MODEL_BASE）
      // baseUrl 留空 = 自动跟随当前页面源（同源服务桥，换端口也不用改配置）
      // Anthropic 协议约定：baseUrl 含 /v1，客户端只拼 /messages
      baseUrl: "",
      // 密钥由服务端环境变量注入，这里随便填一个非空值即可
      models: [],
    },
    deepseek: {
      name: "DeepSeek",
      type: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      models: ["deepseek-v4-pro", "deepseek-flash"],
    },
    moonshot: {
      name: "Moonshot Kimi",
      type: "openai",
      baseUrl: "https://api.moonshot.cn/v1",
      models: ["kimi-k3", "kimi-k2.6"],
    },
    qwen: {
      name: "阿里通义千问",
      type: "openai",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: ["qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash"],
    },
    custom: {
      name: "自定义（OpenAI 兼容）",
      type: "openai",
      baseUrl: "",
      models: [],
    },
  };

  function store() { return window.LumenStore.state; }

  // 读取某服务商的当前配置（预置 + 用户覆写合并）
  function providerConfig(id) {
    var preset = PRESETS[id] || PRESETS.custom;
    var user = (store().settings.providers || {})[id] || {};
    var base = (user.baseUrl !== undefined && user.baseUrl !== "") ? user.baseUrl : preset.baseUrl;
    if (!base && id === "localgw") {
      base = (location.protocol === "http:" || location.protocol === "https:")
        ? location.origin + "/v1"
        : "http://127.0.0.1:8787/v1";
    }
    return {
      id: id,
      name: preset.name,
      type: preset.type,
      baseUrl: base,
      models: preset.models,
      apiKey: user.apiKey || "",
      model: user.model || (preset.models[0] || ""),
    };
  }

  function isReady(id) {
    var c = providerConfig(id);
    return !!(c.apiKey && c.baseUrl && c.model);
  }

  // 当前生效的模型（null = 演示模式）
  // 旧版本预设名迁移（zcodeproxy → localgw）：老用户设置原样生效，无需重新配置
  (function migrate() {
    var st = store();
    var provs = st.settings.providers || {};
    if (provs.zcodeproxy && !provs.localgw) {
      provs.localgw = { apiKey: provs.zcodeproxy.apiKey || "", model: provs.zcodeproxy.model || "" };
      // 旧版绝对地址（127.0.0.1:8787）不迁移：新版自动跟随页面源，换端口零配置
    }
    if (st.settings.activeProvider === "zcodeproxy") st.settings.activeProvider = "localgw";
    delete provs.zcodeproxy;
    window.LumenStore.save();
  })();

  function current() {
    var s = store().settings;
    if (!s.activeProvider || !isReady(s.activeProvider)) return null;
    var c = providerConfig(s.activeProvider);
    if (s.activeModel) c.model = s.activeModel;
    return c;
  }

  // —— SSE 读取器：把 fetch 的 body 流拆成 data: 行 ——
  function readSSE(response, onEvent) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    function handleLines(lines) {
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf("data:") === 0) {
          var payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") {
            try { onEvent(JSON.parse(payload)); } catch (e) { /* 忽略半截 JSON */ }
          }
        }
      }
    }
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          // 流结束：冲刷残留缓冲（个别网关最后一行不带结尾换行）
          buffer += decoder.decode();
          handleLines(buffer.split("\n"));
          buffer = "";
          return;
        }
        buffer += decoder.decode(r.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop(); // 最后一段可能不完整，留在缓冲
        handleLines(lines);
        return pump();
      });
    }
    return pump();
  }

  function httpError(resp, bodyText) {
    var msg = "";
    try {
      var j = JSON.parse(bodyText);
      msg = (j.error && (j.error.message || j.error.msg)) || j.message || "";
    } catch (e) { msg = bodyText && bodyText.slice(0, 200); }
    return new Error("HTTP " + resp.status + (msg ? " · " + msg : ""));
  }

  // —— 三种协议的流式实现 ——
  function streamOpenAI(cfg, messages, signal, onDelta) {
    var url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    return fetch(url, {
      method: "POST",
      signal: signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify({ model: cfg.model, messages: messages, stream: true }),
    }).then(function (resp) {
      if (!resp.ok) return resp.text().then(function (t) { throw httpError(resp, t); });
      return readSSE(resp, function (ev) {
        var d = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (d && d.content) onDelta(d.content);
      });
    });
  }

  function streamAnthropic(cfg, messages, signal, onDelta) {
    // Anthropic：system 单独传；messages 里不许出现 system 角色
    var system = [];
    var rest = [];
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === "system") system.push(messages[i].content);
      else rest.push({ role: messages[i].role, content: messages[i].content });
    }
    var url = cfg.baseUrl.replace(/\/+$/, "") + "/messages";
    return fetch(url, {
      method: "POST",
      signal: signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        // 浏览器直连官方 API 必须显式开启（密钥在本机，本应用不设后端）
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: cfg.model,
        // 8192 而非 2048：GLM-5.3 等思考型模型的推理也计入输出配额，
        // 2048 会让长回答被思考挤占截断；8192 对 Claude 系模型同样安全
        max_tokens: 8192,
        system: system.join("\n\n") || undefined,
        messages: rest,
        stream: true,
      }),
    }).then(function (resp) {
      if (!resp.ok) return resp.text().then(function (t) { throw httpError(resp, t); });
      return readSSE(resp, function (ev) {
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.text) {
          onDelta(ev.delta.text);
        }
      });
    });
  }

  function streamGemini(cfg, messages, signal, onDelta) {
    var system = [];
    var rest = [];
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === "system") system.push(messages[i].content);
      else rest.push({
        role: messages[i].role === "assistant" ? "model" : "user",
        parts: [{ text: messages[i].content }],
      });
    }
    var url = cfg.baseUrl.replace(/\/+$/, "") +
      "/models/" + encodeURIComponent(cfg.model) +
      ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(cfg.apiKey);
    return fetch(url, {
      method: "POST",
      signal: signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: rest,
        systemInstruction: system.length ? { parts: [{ text: system.join("\n\n") }] } : undefined,
      }),
    }).then(function (resp) {
      if (!resp.ok) return resp.text().then(function (t) { throw httpError(resp, t); });
      return readSSE(resp, function (ev) {
        var parts = ev.candidates && ev.candidates[0] &&
          ev.candidates[0].content && ev.candidates[0].content.parts;
        if (parts) {
          // 一个 chunk 可能携带多个 parts，全部累加避免丢文本
          var text = "";
          for (var k = 0; k < parts.length; k++) {
            if (parts[k] && parts[k].text) text += parts[k].text;
          }
          if (text) onDelta(text);
        }
      });
    });
  }

  // —— 对外主入口：流式对话，返回完整文本 ——
  function chatStream(opts) {
    var cfg = opts.provider || current();
    if (!cfg) return Promise.reject(new Error("Lumen 未连接任何模型（演示模式请走本地引擎）"));
    var fn = cfg.type === "anthropic" ? streamAnthropic
           : cfg.type === "gemini" ? streamGemini
           : streamOpenAI;
    return fn(cfg, opts.messages, opts.signal, opts.onDelta || function () {});
  }

  // —— 连通性测试（设置面板用）——
  function testProvider(id) {
    var cfg = providerConfig(id);
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
      return Promise.resolve({ ok: false, msg: "请先填写 API Key、接口地址与模型名" });
    }
    return chatStream({
      provider: cfg,
      messages: [{ role: "user", content: "回复「ok」两个字母即可，不要任何其他内容。" }],
    }).then(function () {
      return { ok: true, msg: "连接成功 · 模型已应答" };
    }).catch(function (err) {
      var msg = String(err && err.message || err);
      var hint = /Failed to fetch|NetworkError|load failed/i.test(msg)
        ? "（网络不通或该服务商不允许浏览器直连 CORS，可尝试用本地静态服务器打开本页）" : "";
      return { ok: false, msg: msg + hint };
    });
  }

  window.LumenAI = {
    PRESETS: PRESETS,
    providerConfig: providerConfig,
    isReady: isReady,
    current: current,
    chatStream: chatStream,
    testProvider: testProvider,
  };
})();
