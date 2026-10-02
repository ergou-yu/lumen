"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), {spawn} = require("node:child_process"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const server = http.createServer(); await new Promise(r => server.listen(0,"127.0.0.1",r)); const p = server.address().port; await new Promise(r => server.close(r)); return p; }
test("官方授权跳转、PKCE、单次跨站回调、账户回执和服务端凭据隔离", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"lumi-oauth-")), p = await port(), base = "http://127.0.0.1:"+p;
  const expected = path.join(dir,"expected.json"), hook = path.join(dir,"mock-fetch.cjs");
  fs.writeFileSync(hook, `const fs=require("node:fs"),crypto=require("node:crypto"),real=global.fetch;
global.fetch=async(input,init={})=>{
 const url=String(input),reply=data=>new Response(JSON.stringify(data));
 if(url==="https://oauth2.googleapis.com/token"||url==="https://login.microsoftonline.com/consumers/oauth2/v2.0/token") {
  const provider=url.includes("googleapis")?"google":"microsoft",b=new URLSearchParams(init.body),e=JSON.parse(fs.readFileSync(process.env.OAUTH_FIXTURE_EXPECTED,"utf8"));
  if(provider!==e.provider||b.get("client_id")!==provider+"-fixture"||(b.get("client_secret")||"")!==e.secret||b.get("code")!=="fixture-code"||b.get("grant_type")!=="authorization_code"||b.get("redirect_uri")!==e.redirect||crypto.createHash("sha256").update(b.get("code_verifier")||"").digest("base64url")!==e.challenge) return reply({error:"invalid_request",error_description:"fixture validation failed"});
  if(fs.existsSync(process.env.OAUTH_FIXTURE_EXPECTED+".hold")) {fs.writeFileSync(process.env.OAUTH_FIXTURE_EXPECTED+".waiting","");while(fs.existsSync(process.env.OAUTH_FIXTURE_EXPECTED+".hold"))await new Promise(r=>setTimeout(r,10));}
  return reply({access_token:provider+"-access-private",refresh_token:provider+"-refresh-private",expires_in:3600});
 }
 if(url==="https://www.googleapis.com/oauth2/v2/userinfo") return reply({email:"<img src=x onerror=alert(1)>@fixture.example"});
 if(url==="https://graph.microsoft.com/v1.0/me") return reply({mail:"ms@fixture.example"});
 return real(input,init);
};`);
  let child;
  const headers = {Authorization:"Bearer fixture-auth","Content-Type":"application/json"};
  const status = async () => (await fetch(base+"/connectors",{headers})).json();
  const post = async body => (await fetch(base+"/connectors/save",{method:"POST",headers,body:JSON.stringify(body)})).json();
  async function start(msId="microsoft-fixture", msSecret="microsoft-private") {
    child = spawn(process.execPath,["--require",hook,path.join(__dirname,"../server.js")], {env:{...process.env,PORT:String(p),LUMEN_NO_OPEN:"1",LUMEN_DATA_DIR:dir,LUMEN_ACCESS_TOKEN:"fixture-auth",LUMEN_MODEL_API_KEY:"",LUMEN_MODEL_BASE:"",LUMEN_HINDSIGHT_URL:"",LUMEN_PUBLIC_URL:"",LUMEN_GOOGLE_CLIENT_ID:"google-fixture",LUMEN_GOOGLE_CLIENT_SECRET:"google-private",LUMEN_MICROSOFT_CLIENT_ID:msId,LUMEN_MICROSOFT_CLIENT_SECRET:msSecret,OAUTH_FIXTURE_EXPECTED:expected},stdio:"ignore"});
    for(let i=0;i<80;i++){try{await fetch(base);return;}catch(_){await delay(50);}} throw new Error("server unavailable");
  }
  async function stop(){child.kill("SIGKILL");await new Promise(r=>child.once("exit",r));}
  t.after(()=>{child?.kill("SIGKILL");fs.rmSync(dir,{recursive:true,force:true});});
  await start();
  assert.equal((await status()).connectors.google.configured,true);
  assert.equal((await status()).connectors.microsoft.managed,true);
  assert.equal((await status()).microsoftRedirectUri,"http://localhost:"+p+"/connectors/microsoft/callback");
  assert.equal((await post({id:"google",patch:{clientId:"browser-app"}})).ok,false);
  assert.equal((await fetch(base+"/connectors/microsoft/auth",{redirect:"manual"})).status,401);
  async function begin(provider,secret=provider+"-private"){
    const r = await fetch(base+"/connectors/"+provider+"/auth",{headers,redirect:"manual"});assert.equal(r.status,302);
    const url = new URL(r.headers.get("location"));assert.equal(url.searchParams.get("response_type"),"code");assert.equal(url.searchParams.get("state").length,64);assert.equal(url.searchParams.get("code_challenge_method"),"S256");assert.equal(url.searchParams.has("client_secret"),false);
    assert.equal(url.hostname,provider==="google"?"accounts.google.com":"login.microsoftonline.com");
    fs.writeFileSync(expected,JSON.stringify({provider,secret,redirect:url.searchParams.get("redirect_uri"),challenge:url.searchParams.get("code_challenge")}));
    return url.searchParams.get("state");
  }
  const googleState = await begin("google");
  assert.equal((await fetch(base+"/connectors/microsoft/callback?state="+googleState+"&code=fixture-code")).status,401);
  const page = await fetch(base+"/connectors/google/callback?state="+googleState+"&code=fixture-code",{headers:{"Sec-Fetch-Site":"cross-site"}});assert.equal(page.status,200);assert.equal(page.headers.get("cache-control"),"no-store");assert.match(await page.text(),/&lt;img/);
  assert.equal((await fetch(base+"/connectors/google/callback?state="+googleState+"&code=fixture-code")).status,401);
  const msState = await begin("microsoft");
  assert.match(await(await fetch(base+"/connectors/microsoft/callback?state="+msState+"&code=fixture-code")).text(),/ms@fixture.example/);
  let result = await status();assert.equal(result.connectors.google.authorized,true);assert.equal(result.connectors.microsoft.authorized,true);assert.equal(result.connectors.microsoft.authResult.ok,true);
  assert.equal(JSON.stringify(result).includes("-private"),false);
  let stored = JSON.parse(fs.readFileSync(path.join(dir,"lumen-connectors.json"),"utf8"));assert.equal(stored.google.clientSecret,undefined);assert.equal(stored.microsoft.clientSecret,undefined);assert.equal(stored.microsoft._oauthClientId,"microsoft-fixture");assert.equal(fs.statSync(path.join(dir,"lumen-connectors.json")).mode&0o777,0o600);
  const cancel = await begin("microsoft");await fetch(base+"/connectors/microsoft/callback?state="+cancel+"&error=access_denied");result=await status();assert.equal(result.connectors.microsoft.authorized,true);assert.equal(result.connectors.microsoft.authResult.ok,false);
  assert.equal((await fetch(base+"/connectors/microsoft/callback?state="+cancel)).status,401);
  // 断开连接使在途授权失效，即使换令牌请求已经开始也不能重新附上旧账户。
  const race = await begin("microsoft");fs.writeFileSync(expected+".hold","");
  const callback = fetch(base+"/connectors/microsoft/callback?state="+race+"&code=fixture-code");
  for(let i=0;i<100&&!fs.existsSync(expected+".waiting");i++)await delay(10);
  assert.equal(fs.existsSync(expected+".waiting"),true);await post({id:"microsoft",patch:{clearAuth:true}});fs.rmSync(expected+".hold");await callback;
  assert.equal((await status()).connectors.microsoft.authorized,false);
  const pending = await begin("microsoft");await post({id:"microsoft",patch:{clearAuth:true}});assert.equal((await fetch(base+"/connectors/microsoft/callback?state="+pending+"&code=fixture-code")).status,401);
  const connected = await begin("microsoft");await fetch(base+"/connectors/microsoft/callback?state="+connected+"&code=fixture-code");await stop();await start();assert.equal((await status()).connectors.microsoft.authorized,true);
  await stop();await start("microsoft-fixture","");const nativeState=await begin("microsoft","");await fetch(base+"/connectors/microsoft/callback?state="+nativeState+"&code=fixture-code");assert.equal((await status()).connectors.microsoft.authorized,true);
  await stop();await start("different-app");assert.equal((await status()).connectors.microsoft.authorized,false);
});
