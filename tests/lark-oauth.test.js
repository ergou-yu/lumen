"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("飞书 OAuth v3：账户身份、凭据隔离、单次续期与断开连接竞态", async t => {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-lark-"));
  const fixture = path.join(dir, "fixture.json"), hook = path.join(dir, "mock-fetch.cjs");
  const configFile = path.join(dir, "lumen-connectors.json"), base = "http://127.0.0.1:" + port;
  fs.writeFileSync(fixture, JSON.stringify({ counter:0, refreshCalls:0, used:[], actions:[] }));
  fs.writeFileSync(hook, `
const fs=require("node:fs"),crypto=require("node:crypto"),real=global.fetch,file=process.env.LARK_FIXTURE;
const read=()=>JSON.parse(fs.readFileSync(file,"utf8")),save=x=>fs.writeFileSync(file,JSON.stringify(x));
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status});
global.fetch=async(input,init={})=>{
 const url=String(input);
 if(url==="https://accounts.feishu.cn/oauth/v3/token") {
  const body=new URLSearchParams(init.body),x=read();
  if(init.headers["Content-Type"]!=="application/x-www-form-urlencoded"||body.get("client_id")!=="cli_lumi_fixture"||body.get("client_secret")!=="lark-secret-private") return reply({code:20002,error:"invalid_client"},400);
  const refreshing=body.get("grant_type")==="refresh_token";
  if(refreshing) {
   if(x.used.includes(body.get("refresh_token"))) return reply({code:20073,error:"invalid_grant"},400);
   if(x.revoked) return reply({code:20064,error:"invalid_grant"},400);
   x.used.push(body.get("refresh_token"));x.refreshCalls++;save(x);
  } else if(body.get("grant_type")!=="authorization_code"||body.get("code")!=="fixture-code"||body.get("redirect_uri")!==x.redirect||crypto.createHash("sha256").update(body.get("code_verifier")||"").digest("base64url")!==x.challenge) return reply({code:20049,error:"invalid_request"},400);
  if(fs.existsSync(file+".hold")) {
   fs.writeFileSync(file+".waiting","");
   while(fs.existsSync(file+".hold"))await new Promise(r=>setTimeout(r,10));
  } else if(refreshing) await new Promise(r=>setTimeout(r,80));
  const next=read();next.counter++;save(next);
  return reply({code:0,access_token:"lark-access-private-"+next.counter,refresh_token:next.noRefresh?undefined:"lark-refresh-private-"+next.counter,expires_in:next.expireSoon?30:7200,refresh_token_expires_in:604800,scope:next.scopes});
 }
 if(url==="https://open.feishu.cn/open-apis/authen/v1/user_info") {
  if(read().failProfile)return reply({code:20005});
  return reply({code:0,data:{name:"<img src=x onerror=alert(1)> Lumi 用户",open_id:"ou_fixture",email:"not-requested@fixture.example"}});
 }
 if(url.startsWith("https://open.feishu.cn/open-apis/docx/v1/")||url.startsWith("https://open.feishu.cn/open-apis/im/v1/")||url.startsWith("https://open.feishu.cn/open-apis/calendar/v4/")) {
  if(!/^Bearer lark-access-private-\\d+$/.test(init.headers.Authorization||""))return reply({code:20005});
  const x=read();x.actions.push({url,method:init.method,body:init.body?JSON.parse(init.body):null,authorization:init.headers.Authorization});save(x);
  if(url.endsWith("/calendars/primary")) {
   if(init.method!=="POST")return reply({code:190002});
   return reply({code:0,data:{calendars:[{calendar:{calendar_id:"readonly_calendar",type:"primary",role:"reader"}},{calendar:{calendar_id:"user_primary",type:"primary",role:"owner"}}]}});
  }
  if(url.endsWith("/events"))return url.includes("/user_primary/")?reply({code:0,data:{event:{event_id:"event_fixture"}}}):reply({code:191004});
  if(url.endsWith("/documents"))return reply({code:0,data:{document:{document_id:"doc_fixture"}}});
  if(url.includes("/messages?"))return reply({code:0,data:{message_id:"message_fixture"}});
  return reply({code:0,data:{}});
 }
 if(url.startsWith("http://127.0.0.1:"))return real(input,init);
 throw new Error("Unexpected external request in fixture");
};`);
  let child;
  const headers = { Authorization:"Bearer fixture-auth", "Content-Type":"application/json" };
  const status = async () => (await fetch(base + "/connectors", {headers})).json();
  const post = async (route, body) => (await fetch(base + route, {method:"POST", headers, body:JSON.stringify(body)})).json();
  const patch = body => post("/connectors/save", {id:"lark", patch:body});
  const readFixture = () => JSON.parse(fs.readFileSync(fixture, "utf8"));
  function updateFixture(fields) { fs.writeFileSync(fixture, JSON.stringify({...readFixture(), ...fields})); }
  const model = http.createServer(async (req,res) => {
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw), result=body.messages.find(message=>message.role==="user"&&message.content.startsWith("获批工具结果"));
    const request=JSON.parse(body.messages.find(message=>message.role==="user").content);
    const action=result?{op:"done",args:{text:result.content}}:{op:"connector",args:{id:"lark",...request},why:"fixture"};
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(action)}}]}));
  });
  await new Promise(resolve=>model.listen(0,"127.0.0.1",resolve));
  async function start(appId="cli_lumi_fixture", region="feishu") {
    child = spawn(process.execPath, ["--require", hook, path.join(__dirname, "../server.js")], {
      env:{...process.env, PORT:String(port), LUMEN_NO_OPEN:"1", LUMEN_DATA_DIR:dir, LUMEN_ACCESS_TOKEN:"fixture-auth",
        LUMEN_MODEL_API_KEY:"", LUMEN_MODEL_BASE:"", LUMEN_HINDSIGHT_URL:"", LUMEN_PUBLIC_URL:"",
        LUMEN_GOOGLE_CLIENT_ID:"", LUMEN_GOOGLE_CLIENT_SECRET:"", LUMEN_MICROSOFT_CLIENT_ID:"", LUMEN_MICROSOFT_CLIENT_SECRET:"",
        LUMEN_LARK_APP_ID:appId, LUMEN_LARK_APP_SECRET:appId ? "lark-secret-private" : "", LUMEN_LARK_REGION:region, LUMEN_LARK_SCOPES:"", LARK_FIXTURE:fixture},
      stdio:"ignore",
    });
    for (let i=0;i<100;i++) { try { await status(); return; } catch (_) { await delay(30); } }
    throw new Error("fixture server unavailable");
  }
  async function stop() { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit",resolve)); }
  t.after(async () => { child?.kill("SIGKILL"); await new Promise(resolve=>model.close(resolve)); fs.rmSync(dir,{recursive:true,force:true}); });
  async function approvedAction(action,args) {
    const actionsBefore = readFixture().actions.length;
    await post("/agent/model",{type:"openai",model:"fixture",baseUrl:"http://127.0.0.1:"+model.address().port,apiKey:"fixture-key"});
    const created=await post("/agent/jobs",{prompt:JSON.stringify({action,args})});
    let job;
    async function waitFor(state) {
      for(let i=0;i<200;i++) {
        const data=await(await fetch(base+"/agent/state",{headers})).json();job=data.jobs.find(item=>item.id===created.job.id);
        if(job.status===state)return;
        if(["failed","stopped"].includes(job.status))throw new Error(job.error);
        await delay(50);
      }
      throw new Error("fixture job did not reach "+state+": "+job.status);
    }
    await waitFor("waiting_approval");assert.equal(readFixture().actions.length,actionsBefore);
    await post("/agent/jobs/"+job.id,{op:"approve",allow:true,approvalId:job.pending.id});await waitFor("done");
    return job.result;
  }
  async function begin() {
    const response = await fetch(base + "/connectors/lark/auth", {headers, redirect:"manual"});
    assert.equal(response.status,302);
    const url = new URL(response.headers.get("location"));
    assert.equal(url.origin,"https://accounts.feishu.cn");
    assert.equal(url.pathname,"/open-apis/authen/v1/authorize");
    assert.equal(url.searchParams.get("client_id"),"cli_lumi_fixture");
    assert.equal(url.searchParams.get("response_type"),"code");
    assert.equal(url.searchParams.get("code_challenge_method"),"S256");
    assert.match(url.searchParams.get("state"),/^[a-f0-9]{64}$/);
    assert.equal(url.searchParams.has("client_secret"),false);
    const scopes = url.searchParams.get("scope");
    for (const scope of ["offline_access","im:message","im:message.send_as_user","docx:document","calendar:calendar","calendar:calendar:read"]) assert.ok(scopes.split(" ").includes(scope));
    updateFixture({redirect:url.searchParams.get("redirect_uri"),challenge:url.searchParams.get("code_challenge"),scopes});
    return url.searchParams.get("state");
  }
  const callback = state => fetch(base + "/connectors/lark/callback?state=" + state + "&code=fixture-code", {headers:{"Sec-Fetch-Site":"cross-site"}});
  async function connect() { const response = await callback(await begin()); assert.match(await response.text(),/账户已连接/); }
  async function waitHeld() { for(let i=0;i<100&&!fs.existsSync(fixture+".waiting");i++)await delay(10); assert.ok(fs.existsSync(fixture+".waiting")); }
  function hold() { fs.rmSync(fixture+".waiting",{force:true}); fs.writeFileSync(fixture+".hold",""); }
  function release() { fs.rmSync(fixture+".hold"); }
  await start();
  await t.test("官方跳转、跨站回调、身份回执及 Secret 隔离", async () => {
    const before = await status();
    assert.equal(before.connectors.lark.oauthConfigured,true);
    assert.equal(before.connectors.lark.managed,true);
    assert.equal(before.larkRedirectUri,"http://localhost:"+port+"/connectors/lark/callback");
    assert.equal((await patch({appId:"other-app"})).ok,false);
    assert.equal((await fetch(base+"/connectors/lark/auth",{redirect:"manual"})).status,401);
    const state=await begin();
    assert.equal((await fetch(base+"/connectors/google/callback?state="+state+"&code=fixture-code")).status,401);
    const response=await callback(state);
    assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
    assert.match(await response.text(),/&lt;img/);
    assert.equal((await callback(state)).status,401);
    const after=await status();assert.equal(after.connectors.lark.authorized,true);assert.equal(after.connectors.lark.mode,"oauth");
    assert.equal(after.connectors.lark.authResult.ok,true);
    assert.equal(JSON.stringify(after).includes("-private"),false);
    assert.equal(JSON.stringify(after).includes("not-requested@"),false);
    const stored=JSON.parse(fs.readFileSync(configFile,"utf8"));
    assert.equal(stored.lark.appSecret,undefined);assert.equal(stored.lark.appId,undefined);
    assert.equal(stored.lark._oauthClientId,"cli_lumi_fixture");assert.equal(fs.statSync(configFile).mode&0o777,0o600);
  });
  await t.test("取消重连保留账户；操作受本地权限控制且使用用户令牌", async () => {
    const state=await begin();await fetch(base+"/connectors/lark/callback?state="+state+"&error=access_denied");
    assert.equal((await status()).connectors.lark.authorized,true);
    assert.equal((await status()).connectors.lark.authResult.ok,false);
    assert.equal((await post("/connectors/action",{id:"lark",action:"doc",args:{title:"fixture"}})).ok,false);
    await post("/connectors/permissions",{id:"lark",on:true,read:true,write:true});
    assert.match((await post("/connectors/action",{id:"lark",action:"doc",args:{title:"fixture",text:"正文"}})).error,/对外写入请使用后台任务/);
    assert.match(await approvedAction("doc",{title:"fixture",text:"正文"}),/doc_fixture/);
    assert.match(await approvedAction("send",{chatId:"oc_fixture",text:"测试"}),/message_fixture/);
    assert.match(await approvedAction("event",{summary:"fixture",startISO:"2026-10-03T09:00:00+08:00",endISO:"2026-10-03T10:00:00+08:00"}),/event_fixture/);
    const actions=readFixture().actions;assert.equal(actions.length,5);
    assert.ok(actions[3].url.endsWith("/calendars/primary"));
    assert.ok(actions[4].url.endsWith("/calendars/user_primary/events"));
    assert.equal(actions[4].body.start.timestamp,String(Date.parse("2026-10-03T09:00:00+08:00")/1000));
  });
  await t.test("一次性 refresh token 并发续期只请求一次并保存替换令牌", async () => {
    const stored=JSON.parse(fs.readFileSync(configFile,"utf8"));stored.lark._tokenExp=0;fs.writeFileSync(configFile,JSON.stringify(stored));
    const old=stored.lark.refreshToken, before=readFixture().refreshCalls;
    const results=await Promise.all([post("/connectors/test",{id:"lark"}),post("/connectors/test",{id:"lark"})]);
    assert.ok(results.every(result=>result.ok));assert.equal(readFixture().refreshCalls,before+1);
    assert.notEqual(JSON.parse(fs.readFileSync(configFile,"utf8")).lark.refreshToken,old);
  });
  await t.test("在途续期及在途换令牌不能覆盖断开连接", async () => {
    const stored=JSON.parse(fs.readFileSync(configFile,"utf8"));stored.lark._tokenExp=0;fs.writeFileSync(configFile,JSON.stringify(stored));
    hold();const renewal=post("/connectors/test",{id:"lark"});await waitHeld();await patch({clearAuth:true});release();
    assert.equal((await renewal).ok,false);assert.equal((await status()).connectors.lark.authorized,false);
    const state=await begin();hold();const pending=callback(state);await waitHeld();await patch({clearAuth:true});release();await pending;
    assert.equal((await status()).connectors.lark.authorized,false);
  });
  await t.test("缺少持久授权或无法确认用户身份不会连接成功", async () => {
    updateFixture({noRefresh:true});const missing=await callback(await begin());assert.match(await missing.text(),/未返回完整持久授权/);
    assert.equal((await status()).connectors.lark.authorized,false);
    updateFixture({noRefresh:false,failProfile:true});assert.match(await(await callback(await begin())).text(),/未能确认飞书账户身份/);
    assert.equal((await status()).connectors.lark.authorized,false);updateFixture({failProfile:false});
  });
  await t.test("被撤销的令牌清除授权；重启保留账户；更换应用或区域失效", async () => {
    await connect();const stored=JSON.parse(fs.readFileSync(configFile,"utf8"));stored.lark._tokenExp=0;fs.writeFileSync(configFile,JSON.stringify(stored));
    updateFixture({revoked:true});assert.equal((await post("/connectors/test",{id:"lark"})).ok,false);
    assert.equal((await status()).connectors.lark.authorized,false);updateFixture({revoked:false});
    await connect();await stop();await start();assert.equal((await status()).connectors.lark.authorized,true);
    await stop();await start("different-app");assert.equal((await status()).connectors.lark.authorized,false);
    await stop();await start();await connect();await stop();await start("cli_lumi_fixture","larksuite");
    assert.equal((await status()).connectors.lark.authorized,false);assert.equal((await status()).connectors.lark.oauthConfigured,false);
    const page=await fetch(base+"/connectors/lark/auth",{headers,redirect:"manual"});assert.equal(page.status,200);assert.match(await page.text(),/目前支持飞书国内版/);
  });
  await t.test("自托管配置保留空 Secret；修改区域、模式或范围使未完成授权失效", async () => {
    await stop();await start("");
    assert.equal((await patch({appId:"cli_lumi_fixture",appSecret:"lark-secret-private",mode:"oauth",region:"feishu"})).ok,true);
    await patch({appSecret:"",defaultChatId:"oc_fixture"});assert.equal((await status()).connectors.lark.oauthConfigured,true);
    for(const change of [{region:"larksuite"},{mode:"app"},{oauthScopes:"docx:document"}]) {
      await patch({mode:"oauth",region:"feishu",oauthScopes:""});const state=await begin();await patch(change);
      assert.equal((await fetch(base+"/connectors/lark/callback?state="+state+"&code=fixture-code",{headers})).status,403);
    }
  });
});
