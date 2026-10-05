"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createModel } = require("../lib/model");
async function fixture(t, handler, type = "anthropic") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-model-retry-")), requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = JSON.parse(raw); requests.push(body);
    handler(body, res, requests.length);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const model = createModel(dir);
  model.configure({ type, baseUrl: "http://127.0.0.1:" + server.address().port, apiKey: "fixture-secret", model: "fixture" });
  return { model, requests, dir };
}
test("网络断连只重试生成一次，重试不重新调用工具", async t => {
  const events = [];
  const { model, requests } = await fixture(t, (b, res, n) => {
    if (n === 1) res.destroy();
    else res.end(JSON.stringify({ content: [{ type: "text", text: "recovered" }] }));
  });
  assert.equal(await model.call("system", [{ role: "user", content: "saved result" }], undefined, e => events.push(e)), "recovered");
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.equal(events[0].reason, "network");
});

test("推理耗尽额度后只重试生成，增加预算且不把推理或截断正文作为动作", async t => {
  for (const type of ["anthropic", "openai", "gemini"]) await t.test(type, async t => {
    const retryEvents = [], messages = [{ role: "user", content: "tool result already saved" }];
    const { model, requests } = await fixture(t, (body, res, n) => {
      const limited = n === 1;
      res.end(JSON.stringify(type === "anthropic"
        ? { stop_reason: limited ? "max_tokens" : "end_turn", content: limited ? [{ type: "thinking", thinking: "private reasoning" }] : [{ type: "text", text: "complete" }] }
        : type === "openai"
          ? { choices: [{ finish_reason: limited ? "length" : "stop", message: { reasoning_content: "private reasoning", content: limited ? "partial" : "complete" } }] }
          : { candidates: [{ finishReason: limited ? "MAX_TOKENS" : "STOP", content: { parts: [{ thought: true, text: "private reasoning" }, ...(limited ? [] : [{ text: "complete" }])] } }] }));
    }, type);
    assert.equal(await model.call("system", messages, undefined, e => retryEvents.push(e)), "complete");
    assert.deepEqual(retryEvents, [{ reason: "length", maxTokens: 8192 }]);
    assert.equal(requests.length, 2);
    const budgets = requests.map(b => type === "gemini" ? b.generationConfig.maxOutputTokens : b.max_tokens);
    assert.deepEqual(budgets, [4096, 8192]);
    const context = requests.map(b => type === "gemini" ? b.contents : b.messages);
    assert.deepEqual(context[0], context[1]);
  });
});

test("空回执最多重试一次，持续失败提供停止原因且不泄露推理或密钥", async t => {
  const { model, requests } = await fixture(t, (body, res) => res.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private reasoning" }], usage: { output_tokens: 99 } })));
  await assert.rejects(model.call("system", [{ role: "user", content: "hello" }]), err => {
    assert.match(err.message, /连续两次未返回正文.*end_turn.*99/);
    assert.doesNotMatch(err.message, /private reasoning|fixture-secret/);
    return true;
  });
  assert.equal(requests.length, 2); assert.equal(requests[1].max_tokens, 4096);
});

test("额度重试有上限，拒绝和HTTP错误不重试", async t => {
  for (const kind of ["length", "refusal", "http"]) await t.test(kind, async t => {
    const { model, requests } = await fixture(t, (body, res) => {
      if (kind === "http") res.writeHead(401);
      res.end(JSON.stringify(kind === "http" ? { error: { message: "fixture-secret" } } : { stop_reason: kind === "length" ? "max_tokens" : "refusal", content: [] }));
    });
    await assert.rejects(model.call("system", [{ role: "user", content: "hello" }]), kind === "length" ? /额度不足.*max_tokens/ : kind === "refusal" ? /拒绝/ : /HTTP 401/);
    assert.equal(requests.length, kind === "length" ? 2 : 1);
  });
});

test("重试前中断立即停止，不再发出第二次模型请求", async t => {
  const ctrl = new AbortController();
  const { model, requests } = await fixture(t, (body, res) => res.end(JSON.stringify({ stop_reason: "max_tokens", content: [] })));
  await assert.rejects(model.call("system", [{ role: "user", content: "hello" }], ctrl.signal, () => ctrl.abort()), /abort/i);
  assert.equal(requests.length, 1);
});
test("GLM-5.3 拒绝图像输入，单步规划使用官方轻量推理参数", async t => {
  const { model, requests, dir } = await fixture(t, (b, res) => res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] })));
  const config = JSON.parse(fs.readFileSync(path.join(dir, "lumen-agent-model.json"), "utf8"));
  model.configure({ ...config, model: "GLM-5.3" }); assert.equal(model.status().vision, false);
  assert.equal(model.status().desktopModel, "GLM-5.3-Flash"); assert.equal(model.status().desktopVision, true);
  await assert.rejects(model.call("system", [{ role: "user", content: [{ type: "image" }] }]), /只支持文字/);
  assert.equal(requests.length, 0);
  assert.equal(await model.call("system", [{ role: "user", content: "controls" }], undefined, undefined, { reasoningEffort: "low" }), "ok");
  assert.equal(requests[0].reasoning_effort, "low");
  await model.call("system", [{ role: "user", content: "complex research" }]);
  assert.equal(requests[1].reasoning_effort, undefined);
});
test("桌面单次调用自动用 Flash 看图，聊天模型和已保存选择不变", async t => {
  const { model, requests, dir } = await fixture(t, (b, res) => res.end(JSON.stringify({ content: [{ type: "text", text: "seen" }] })));
  const file = path.join(dir, "lumen-agent-model.json"), cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  model.configure({ ...cfg, model: "GLM-5.3" });
  assert.equal(await model.call("system", [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }] }], undefined, undefined, { model: model.status().desktopModel, reasoningEffort: "low" }), "seen");
  assert.equal(requests[0].model, "GLM-5.3-Flash"); assert.equal(model.status().model, "GLM-5.3");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, "GLM-5.3");
  await assert.rejects(model.call("system", [], undefined, undefined, { model: "unconfigured-model" }), /不在.*选项/);
});
test("GLM-5.3-Flash 在两种兼容协议中发送截图与轻量推理参数", async t => {
  for (const type of ["anthropic", "openai"]) await t.test(type, async t => {
    const { model, requests, dir } = await fixture(t, (b, res) => res.end(JSON.stringify(type === "anthropic"
      ? { content: [{ type: "text", text: "observed" }] }
      : { choices: [{ message: { content: "observed" } }] })), type);
    const config = JSON.parse(fs.readFileSync(path.join(dir, "lumen-agent-model.json"), "utf8"));
    model.configure({ ...config, model: "glm-5.3-flash" });
    assert.equal(model.status().vision, true);
    const messages = [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }, { type: "text", text: "observe" }] }];
    assert.equal(await model.call("system", messages, undefined, undefined, { reasoningEffort: "low" }), "observed");
    assert.equal(requests[0].model, "glm-5.3-flash"); assert.equal(requests[0].reasoning_effort, "low");
    if (type === "anthropic") assert.deepEqual(requests[0].messages, messages);
    else assert.equal(requests[0].messages[1].content[0].image_url.url, "data:image/png;base64,fixture");
  });
});
test("后台模型选择保留连接、密钥与生图设置；选择结果重启后生效", async t => {
  const { model, dir } = await fixture(t, (b, res) => res.end("{}"));
  const file = path.join(dir, "lumen-agent-model.json"), original = JSON.parse(fs.readFileSync(file, "utf8"));
  model.configure({ ...original, model: "GLM-5.3", imageModel: "saved-image-model" });
  assert.deepEqual(model.status().models, [{ model: "GLM-5.3", vision: false }, { model: "GLM-5.3-Flash", vision: true }]);
  assert.throws(() => model.select("unknown-model"), /不在.*选项/);
  const selected = model.select("GLM-5.3-Flash"); assert.equal(selected.vision, true);
  assert.doesNotMatch(JSON.stringify(selected), /fixture-secret|127\.0\.0\.1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ...original, model: "GLM-5.3-Flash", imageModel: "saved-image-model" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(createModel(dir).status().model, "GLM-5.3-Flash");
  assert.equal(model.select("GLM-5.3").vision, false);
});
test("环境变量连接可以切换到 Flash，无需向浏览器传出密钥", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-env-model-"));
  const fields = ["LUMEN_MODEL_API_KEY", "LUMEN_MODEL_BASE", "LUMEN_MODEL_NAME", "LUMEN_MODEL_TYPE"], saved = Object.fromEntries(fields.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of fields) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } fs.rmSync(dir, { recursive: true, force: true }); });
  Object.assign(process.env, { LUMEN_MODEL_API_KEY: "env-fixture-secret", LUMEN_MODEL_BASE: "https://fixture.example/v1", LUMEN_MODEL_NAME: "glm-5.3", LUMEN_MODEL_TYPE: "anthropic" });
  const model = createModel(dir); assert.equal(model.select("glm-5.3-flash").model, "glm-5.3-flash");
  assert.equal(createModel(dir).status().vision, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "lumen-agent-model.json"), "utf8")).apiKey, "env-fixture-secret");
  assert.doesNotMatch(JSON.stringify(model.status()), /env-fixture-secret|fixture\.example/);
});
test("后台三种协议支持图像观察、正确鉴权与文本回执；生图保留真实PNG", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"lumi-model-")); let handler;
  const server = http.createServer(async(req,res)=>{ let raw=""; for await(const c of req) raw+=c; try { handler(req,JSON.parse(raw),res); } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); } });
  await new Promise(r=>server.listen(0,"127.0.0.1",r)); t.after(async()=>{ await new Promise(r=>server.close(r)); fs.rmSync(dir,{recursive:true,force:true}); });
  const model=createModel(dir), base="http://127.0.0.1:"+server.address().port;
  const messages=[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/png",data:"fixture"}},{type:"text",text:"observe"}]}];
  for(const type of ["openai","anthropic","gemini"]) {
    model.configure({type,baseUrl:base,apiKey:"fixture-secret",model:type === "openai" ? "gpt-6-fixture":"fixture"});
    handler=(req,b,res)=>{
      if(type === "openai") { assert.equal(req.url,"/chat/completions"); assert.equal(req.headers.authorization,"Bearer fixture-secret"); assert.equal(b.max_completion_tokens,4096); assert.equal(b.messages[1].content[0].image_url.url,"data:image/png;base64,fixture"); res.end(JSON.stringify({choices:[{message:{content:"ok"}}]})); }
      if(type === "anthropic") { assert.equal(req.url,"/v1/messages"); assert.equal(req.headers["x-api-key"],"fixture-secret"); assert.equal(b.messages[0].content[0].source.data,"fixture"); res.end(JSON.stringify({content:[{type:"text",text:"ok"}]})); }
      if(type === "gemini") { assert.equal(req.headers["x-goog-api-key"],"fixture-secret"); assert.equal(b.contents[0].parts[0].inlineData.data,"fixture"); res.end(JSON.stringify({candidates:[{content:{parts:[{text:"ok"}]}}]})); }
    };
    assert.equal(await model.call("system",messages),"ok"); assert.equal(JSON.stringify(model.status()).includes("fixture-secret"),false);
  }
  model.configure({type:"openai",baseUrl:base,apiKey:"fixture-secret",model:"text",imageModel:"fixture-image"});
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC+YAAAAASUVORK5CYII=","base64");
  handler=(req,b,res)=>{ assert.equal(req.url,"/images/generations"); assert.equal(b.model,"fixture-image"); res.end(JSON.stringify({data:[{b64_json:png.toString("base64")}]})); };
  assert.deepEqual(await model.image("draw"),png);
  handler=(req,b,res)=>res.end(JSON.stringify({data:[{b64_json:Buffer.from("fake").toString("base64")}]}));
  await assert.rejects(model.image("draw"),/PNG/);
  const ctrl=new AbortController(); ctrl.abort(); await assert.rejects(model.image("draw",ctrl.signal),/abort/i);
  assert.equal(fs.statSync(path.join(dir,"lumen-agent-model.json")).mode & 0o777,0o600);
});
