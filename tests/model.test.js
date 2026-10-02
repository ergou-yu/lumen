"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createModel } = require("../lib/model");
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
