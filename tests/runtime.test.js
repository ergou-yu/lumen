"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createRuntime, validateSchedule, nextRun } = require("../lib/runtime");
const wait = () => new Promise(r => setTimeout(r, 15));
function fixture(t, model, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-runtime-")); const workspace = path.join(dir,"work"); fs.mkdirSync(workspace);
  const opts = { dir, workspace, manual: true, model, modelStatus: () => ({ready:true}), search: async () => ({ results: [{title:"A",url:"https://example.com"}] }), fetchPage: async () => ({text:"source"}), listFiles: () => [], connector: async () => ({sent:true}), desktop: () => ({queued:true}), ...extra };
  const r = createRuntime(opts); t.after(() => { r.close(); fs.rmSync(dir,{recursive:true,force:true}); }); return { r,dir,workspace,opts };
}
const action = (op,args) => JSON.stringify({op,args});
test("个性化建议只保存不执行，计划可修改且坏时间不破坏原计划",async t=>{
  let writes=0;const plans=[action("idea",{title:"阅读",prompt:"安排阅读",reason:"用户目标"}),action("done",{text:"suggested"})];
  const {r}=fixture(t,async()=>plans.shift(),{connector:async()=>{writes++;}});
  r.create({prompt:"suggest",readOnly:true});r.tick();await wait();assert.equal(r.snapshot().ideas.length,1);assert.equal(writes,0);
  const s=r.addSchedule({prompt:"old",timing:{kind:"interval",intervalMin:10}});
  assert.throws(()=>r.schedule(s.id,{op:"update",prompt:"bad",timing:{kind:"daily",timezone:"bad"}}));assert.equal(r.snapshot().schedules[0].prompt,"old");
  r.schedule(s.id,{op:"update",prompt:"new",notify:"all",timing:{kind:"interval",intervalMin:20}});assert.equal(r.snapshot().schedules[0].timing.intervalMin,20);
  assert.equal(r.profile({accessory:"flower",shape:"leaf"}).accessory,"flower");
});
test("任务断页后执行、成果与记忆落盘，重开读取且不返回模型上下文", async t => {
  const plans = [action("remember",{text:"用户偏好中文"}), action("fileWrite",{name:"notes/a.md",content:"report"}), action("done",{text:"已完成"})];
  const {r,dir,workspace,opts} = fixture(t,async () => plans.shift()); const j=r.create({prompt:"write"}); r.tick(); await wait();
  assert.equal(r.getJob(j.id).status,"done"); assert.equal(fs.readFileSync(path.join(workspace,"notes/a.md"),"utf8"),"report");
  assert.equal(r.snapshot().jobs[0].messages,undefined); assert.equal(r.snapshot().memories.length,1);
  r.close(); const re=createRuntime(opts); assert.equal(re.snapshot().jobs[0].result,"已完成"); re.close(); assert.equal(fs.statSync(path.join(dir,"lumen-agent-state.json")).mode & 0o777,0o600);
});
test("写动作由服务器挂起；失效审批不能执行，只执行批准的参数", async t => {
  let sends=0; const {r}=fixture(t,async () => action("connector",{id:"mail",action:"send",args:{to:"a@example.com",body:"draft"}}),{connector:async a=>{sends++;assert.equal(a.args.body,"draft");return {sent:true};}});
  const j=r.create({prompt:"email"}); r.tick(); await wait(); assert.equal(sends,0); assert.equal(r.getJob(j.id).status,"waiting_approval");
  assert.throws(()=>r.command(j.id,{op:"approve",allow:true,approvalId:"stale"}));
  const apr=r.snapshot().jobs[0].pending; apr.action.args.args.body="tampered";
  r.command(j.id,{op:"approve",allow:true,approvalId:apr.id}); r.tick(); await wait(); assert.equal(sends,1);
});
test("写入超时标记不确定，重启与继续不会重发", async t => {
  let sends=0; const {r,opts}=fixture(t,async()=>action("connector",{id:"mail",action:"send",args:{}}),{connector:async()=>{sends++;throw new Error("lost ack");}});
  const j=r.create({prompt:"send"}); r.tick(); await wait(); r.command(j.id,{op:"approve",allow:true,approvalId:r.getJob(j.id).pending.id}); r.tick(); await wait();
  assert.equal(r.getJob(j.id).status,"uncertain"); assert.throws(()=>r.command(j.id,{op:"resume"})); r.close(); const re=createRuntime(opts); re.tick(); await wait();assert.equal(sends,1);re.close();
});
test("暂停期间不应用晚到模型结果，补充指令使旧计划作废", async t => {
  let release; const {r}=fixture(t,()=>new Promise(resolve=>{release=resolve;})); const j=r.create({prompt:"start"}); r.tick();
  r.command(j.id,{op:"pause"}); release(action("done",{text:"stale"})); await wait();assert.equal(r.getJob(j.id).status,"paused");assert.equal(r.getJob(j.id).result,"");
});
test("只读研究不能写文件；软链接与路径穿越不可逃逸", async t => {
  const plans=[action("fileWrite",{name:"../escape",content:"bad"}),action("fileWrite",{name:"link/escape",content:"bad"}),action("done",{text:"blocked"})];
  const {r,workspace,dir}=fixture(t,async()=>plans.shift());fs.symlinkSync(dir,path.join(workspace,"link"));const j=r.create({prompt:"test"});r.tick();await wait();assert.equal(fs.existsSync(path.join(dir,"escape")),false);assert.equal(r.getJob(j.id).status,"done");
  const k=r.create({prompt:"readonly",readOnly:true}); plans.push(action("fileWrite",{name:"readonly.md",content:"bad"}),action("done",{text:"blocked"}));r.tick();await wait();assert.equal(fs.existsSync(path.join(workspace,"readonly.md")),false);assert.equal(r.getJob(k.id).status,"done");
});
test("时区、工作日、结束日期和DST不会使用宿主时区",()=>{
  const s=validateSchedule({kind:"weekdays",time:"09:00",timezone:"Asia/Shanghai"});assert.equal(nextRun(s,Date.parse("2026-10-02T09:01:00+08:00")),Date.parse("2026-10-05T09:00:00+08:00"));
  const spring=validateSchedule({kind:"daily",time:"02:30",timezone:"America/New_York"});assert.equal(nextRun(spring,Date.parse("2026-03-08T00:00:00-05:00")),Date.parse("2026-03-09T02:30:00-04:00"));
  assert.equal(nextRun({...s,endAt:"2026-10-03T00:00:00+08:00"},Date.parse("2026-10-02T09:01:00+08:00")),null);
  assert.throws(()=>validateSchedule({kind:"daily",timezone:"invalid"}));assert.throws(()=>validateSchedule({kind:"interval",intervalMin:0}));assert.throws(()=>validateSchedule({kind:"once",at:"2026-10-03T09:00:00"}));
});
test("计划错过多轮只合并一项，暂停计划不停止在途任务",async t=>{
  let resolve;const {r}=fixture(t,()=>new Promise(r=>{resolve=r;}));const s=r.addSchedule({prompt:"check",timing:{kind:"interval",intervalMin:10}});r.tick(s.nextRun+600000);r.tick(s.nextRun+1200000);assert.equal(r.snapshot().jobs.length,1);r.schedule(s.id,{op:"toggle"});assert.equal(r.snapshot().jobs[0].status,"running");resolve(action("done",{text:"done"}));await wait();
});
test("来源不变时抑制通知",async t=>{
  let notifications=0;const {r}=fixture(t,async(sys,msgs)=>msgs.some(m=>m.role==="assistant")?action("done",{text:Math.random()+""}):action("search",{query:"same"}),{notify:()=>{notifications++;}});
  const s=r.addSchedule({prompt:"check",timing:{kind:"interval",intervalMin:10}});r.tick(s.nextRun);await wait();const next=r.snapshot().schedules[0].nextRun;r.tick(next);await wait();assert.equal(notifications,1);
});

test("父任务等待独立子任务，停止父任务不误停子任务",async t=>{
  let first=true;const {r}=fixture(t,async(sys,msgs)=>{
    if(sys.includes("原始任务：parent") && first){first=false;return action("delegate",{prompt:"child",title:"child"});}
    return action("done",{text:"result"});
  });const j=r.create({prompt:"parent"});r.tick();await wait();assert.equal(r.getJob(j.id).status,"waiting_children");assert.equal(r.snapshot().jobs.length,2);r.command(j.id,{op:"stop"});r.tick();await wait();assert.equal(r.snapshot().jobs.find(x=>x.parentId===j.id).status,"done");assert.equal(r.getJob(j.id).status,"stopped");
});
