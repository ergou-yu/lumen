"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http"),{spawn}=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,"127.0.0.1",r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test("HTTP访问鉴权、同源、后台模型保密、关页完成和重启回执",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"lumen-http-")),p=await port();let child;
  const model=http.createServer(async(req,res)=>{let raw="";for await(const c of req)raw+=c;const b=JSON.parse(raw);assert.equal(req.headers.authorization,"Bearer fixture-key");assert.equal(b.model,"fixture");res.setHeader("Content-Type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({op:"done",args:{text:"mock verified"}})}}]}));});
  await new Promise(r=>model.listen(0,"127.0.0.1",r));const base="http://127.0.0.1:"+p;
  t.after(async()=>{child?.kill("SIGKILL");await new Promise(r=>model.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  async function start(){child=spawn(process.execPath,[path.join(__dirname,"../server.js")],{env:{...process.env,PORT:String(p),LUMEN_NO_OPEN:"1",LUMEN_DATA_DIR:dir,LUMEN_ACCESS_TOKEN:"test-access",LUMEN_MODEL_API_KEY:"",LUMEN_MODEL_BASE:"",LUMEN_HINDSIGHT_URL:""},stdio:"ignore"});for(let i=0;i<80;i++){try{await fetch(base);return;}catch(_){await delay(50);}}throw new Error("server unavailable");}
  await start();assert.equal((await fetch(base+"/agent/state")).status,401);
  const auth={Authorization:"Bearer test-access","Content-Type":"application/json"};
  const setup=await(await fetch(base+"/connectors",{headers:auth})).json();
  assert.equal(setup.googleRedirectUri,"http://localhost:"+p+"/connectors/google/callback");
  // 编码斜杠不能把允许的js目录变成整个仓库的下载入口；畸形URI不崩溃。
  assert.equal((await fetch(base+"/js/..%2fpackage.json",{headers:auth})).status,404);
  assert.equal((await fetch(base+"/js/%ZZ",{headers:auth})).status,404);
  const external=path.join(dir,"private.txt");fs.writeFileSync(external,"fixture private");fs.symlinkSync(external,path.join(dir,"vm-home","linked.txt"));
  assert.equal((await fetch(base+"/vm/file/linked.txt",{headers:auth})).status,400);
  fs.symlinkSync(external,path.join(dir,"vm-home",".shots","linked.png"));assert.equal((await fetch(base+"/vm/desktop/shot?f=linked.png",{headers:auth})).status,400);
  assert.equal((await fetch(base+"/agent/jobs",{method:"POST",headers:{...auth,Origin:"https://evil.example"},body:JSON.stringify({prompt:"test"})})).status,403);
  assert.equal((await fetch(base+"/connectors",{headers:{...auth,Origin:"https://evil.example"}})).status,403);
  const cc=await fetch(base+"/connectors/save",{method:"POST",headers:auth,body:JSON.stringify({id:"google",patch:{clientId:"fixture-client",clientSecret:"fixture-oauth-secret"}})});assert.equal(cc.status,200);
  let blocked=await(await fetch(base+"/connectors/action",{method:"POST",headers:auth,body:JSON.stringify({id:"google",action:"read"})})).json();assert.match(blocked.error,/权限未开放/);
  await fetch(base+"/connectors/permissions",{method:"POST",headers:auth,body:JSON.stringify({id:"google",on:true,read:true,write:true})});
  blocked=await(await fetch(base+"/connectors/action",{method:"POST",headers:auth,body:JSON.stringify({id:"google",action:"send",args:{to:"fixture@example.com"}})})).json();assert.match(blocked.error,/对外写入请使用后台任务/);
  const authStart=await fetch(base+"/connectors/google/auth",{headers:auth,redirect:"manual"});assert.equal(authStart.status,302);
  const oauthURL=new URL(authStart.headers.get("location"));assert.equal(oauthURL.searchParams.get("state").length,64);
  const oauthState=oauthURL.searchParams.get("state");
  // 有效state可返回到localhost（不同于登录cookie的127.0.0.1），取消也消费一次；不向Google换token。
  assert.equal((await fetch(base+"/connectors/google/callback?state="+oauthState)).status,200);
  assert.equal((await fetch(base+"/connectors/google/callback?state="+oauthState)).status,401);
  const cfg=await fetch(base+"/agent/model",{method:"POST",headers:auth,body:JSON.stringify({type:"openai",model:"fixture",baseUrl:"http://127.0.0.1:"+model.address().port,apiKey:"fixture-key"})});assert.equal(cfg.status,200);
  const selectModel=(name,headers=auth)=>fetch(base+"/agent/model/select",{method:"POST",headers,body:JSON.stringify({model:name})});
  assert.equal((await selectModel("fixture",{"Content-Type":"application/json"})).status,401);
  assert.equal((await selectModel("fixture",{...auth,Origin:"https://evil.example"})).status,403);
  assert.equal((await selectModel("not-configured")).status,400);
  const selected=await(await selectModel("fixture")).json();assert.equal(selected.model,"fixture");assert.equal(JSON.stringify(selected).includes("fixture-key"),false);
  const state=await (await fetch(base+"/agent/state",{headers:auth})).json();assert.equal(JSON.stringify(state).includes("fixture-key"),false);
  const job=await (await fetch(base+"/agent/jobs",{method:"POST",headers:auth,body:JSON.stringify({prompt:"test",channel:"slack",channelTarget:"forged"})})).json();assert.equal(job.job.channel,"web");assert.equal(job.job.channelTarget,"");
  // 等待真实回执，避免机器忙碌时固定 1.4 秒把正常后台任务误判为失败。
  let result;
  for(let i=0;i<200;i++){result=await(await fetch(base+"/agent/state",{headers:auth})).json();if(result.jobs[0].status!=="running"&&result.jobs[0].status!=="queued")break;await delay(100);}
  assert.equal(result.jobs[0].status,"done");assert.equal(result.jobs[0].result,"mock verified");
  child.kill("SIGKILL");await new Promise(r=>child.once("exit",r));await start();result=await(await fetch(base+"/agent/state",{headers:auth})).json();assert.equal(result.jobs[0].status,"done");
  const login=await fetch(base+"/session",{method:"POST",headers:{"Content-Type":"application/json",Origin:base},body:JSON.stringify({token:"test-access"})});assert.equal(login.status,200);assert.match(login.headers.get("set-cookie"),/HttpOnly/);const cookie=login.headers.get("set-cookie").split(";")[0];assert.equal((await fetch(base+"/agent/state",{headers:{Cookie:cookie}})).status,200);
});

test("Microsoft设备码授权发送标准grant_type并取得模拟账号回执",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"lumen-ms-auth-")),p=await port(),base="http://127.0.0.1:"+p;
  const hook=path.join(dir,"mock-fetch.cjs");
  fs.writeFileSync(hook,`const real=global.fetch;
global.fetch=async(input,init={})=>{
 const url=String(input),b=new URLSearchParams(init.body);
 const reply=data=>new Response(JSON.stringify(data),{headers:{"Content-Type":"application/json"}});
 if(url==="https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode"){
  if(b.get("client_id")!=="fixture-client"||!b.get("scope").includes("Mail.Read"))return reply({error:"invalid_request"});
  return reply({device_code:"fixture-device",user_code:"FIXTURE",verification_uri:"https://microsoft.com/devicelogin",expires_in:900,interval:5});
 }
 if(url==="https://login.microsoftonline.com/consumers/oauth2/v2.0/token"){
  if(b.get("grant_type")!=="urn:ietf:params:oauth:grant-type:device_code"||b.get("device_code")!=="fixture-device")return reply({error:"unsupported_grant_type"});
  return reply({access_token:"fixture-access",refresh_token:"fixture-refresh",expires_in:3600});
 }
 if(url==="https://graph.microsoft.com/v1.0/me")return reply({mail:"fixture@example.com"});
 return real(input,init);
};`);
  const child=spawn(process.execPath,["--require",hook,path.join(__dirname,"../server.js")],{env:{...process.env,PORT:String(p),LUMEN_NO_OPEN:"1",LUMEN_DATA_DIR:dir,LUMEN_ACCESS_TOKEN:"fixture-auth",LUMEN_MODEL_API_KEY:"",LUMEN_MODEL_BASE:"",LUMEN_HINDSIGHT_URL:""},stdio:"ignore"});
  t.after(()=>{child.kill("SIGKILL");fs.rmSync(dir,{recursive:true,force:true});});
  let online=false;for(let i=0;i<80;i++){try{await fetch(base);online=true;break;}catch(_){await delay(50);}}assert.equal(online,true);
  const headers={Authorization:"Bearer fixture-auth","Content-Type":"application/json"};
  const post=async(route,body={})=>(await fetch(base+route,{method:"POST",headers,body:JSON.stringify(body)})).json();
  assert.equal((await post("/connectors/save",{id:"microsoft",patch:{clientId:"fixture-client"}})).ok,true);
  assert.equal((await post("/connectors/microsoft/start")).userCode,"FIXTURE");
  assert.equal((await post("/connectors/microsoft/poll")).email,"fixture@example.com");
  const result=await(await fetch(base+"/connectors",{headers})).json();
  assert.equal(result.connectors.microsoft.authorized,true);
  assert.equal(JSON.stringify(result).includes("fixture-refresh"),false);
});
