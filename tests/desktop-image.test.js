"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { REVISION_LABEL, IMAGE_FILES, desktopRevision, belongsToWorkspace, ensureDesktop } = require("../lib/desktop-image");

function fixture(options = {}) {
  const name = "lumen-box", downloads = "/workspace/vm-home", revision = "new-revision";
  const original = { State:{Running:true}, Config:{Labels:{[REVISION_LABEL]:options.current ? revision : "old"}},
    HostConfig:{Binds:[downloads + ":/home/node/Downloads"]}, privateFile:"kept in old writable layer" };
  const containers = new Map(options.fresh ? [] : [[name,original]]), commands = [];
  let imageRevision = options.current ? revision : "old";
  const ok = out => ({ok:true,out:out || "",err:""});
  const run = async (cmd,args) => {
    assert.equal(cmd,"docker"); commands.push(args);
    if(args[0]==="inspect") return containers.has(args[3]) ? ok(JSON.stringify(containers.get(args[3]))) : {ok:false,out:"",err:"not found"};
    if(args[0]==="image") return ok(imageRevision);
    if(args[0]==="stop") {containers.get(args[1]).State.Running=false;return ok();}
    if(args[0]==="start") {containers.get(args[1]).State.Running=true;return ok();}
    if(args[0]==="rename") {containers.set(args[2],containers.get(args[1]));containers.delete(args[1]);return ok();}
    if(args[0]==="rm") {containers.delete(args[2]);return ok();}
    if(args[0]==="run") {
      containers.set(name,{State:{Running:true},Config:{Labels:{[REVISION_LABEL]:imageRevision}},HostConfig:{Binds:original.HostConfig.Binds}});
      return options.failRun ? {ok:false,out:"",err:"fixture run failure"} : ok();
    }
    throw new Error("unexpected docker command: " + args[0]);
  };
  const build = async()=>{commands.push(["build"]);if(options.failBuild)return {ok:false,err:"fixture build failure"};imageRevision=revision;return {ok:true};};
  const ready = async()=>{commands.push(["health"]);return options.failHealth ? {ok:false,error:"fixture health failure"} : {ok:true};};
  const args = ["-v","lumen-box-home:/home/node","-v",downloads+":/home/node/Downloads"];
  return {containers,commands,original, options:{run,build,ready,image:"lumen-box",name,downloads,revision,args}};
}

test("桌面内容版本包含壁纸和头像，图片改变会使旧镜像需要升级", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"lumen-image-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const file of IMAGE_FILES){const target=path.join(dir,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file);}
  const before=desktopRevision(dir);assert.match(before,/^[0-9a-f]{64}$/);assert.equal(desktopRevision(dir),before);
  fs.appendFileSync(path.join(dir,"assets/lumi-oat-rose-wallpaper.png"),"changed artwork");
  assert.notEqual(desktopRevision(dir),before);
});
test("Docker Desktop 改写后的 Mac 和 Windows 挂载路径仍能识别同一工作区",()=>{
  assert.equal(belongsToWorkspace({binds:["/host_mnt/Users/user/Lumen/vm-home:/home/node/Downloads"]},"/Users/user/Lumen/vm-home"),true);
  assert.equal(belongsToWorkspace({binds:["/host_mnt/c/Users/user/Lumen/vm-home:/home/node/Downloads:rw"]},"C:\\Users\\user\\Lumen\\vm-home"),true);
  assert.equal(belongsToWorkspace({binds:["/host_mnt/Users/user/other/vm-home:/home/node/Downloads"]},"/Users/user/Lumen/vm-home"),false);
});
test("旧镜像先构建再替换，复用 home 卷并保留旧容器的可写文件", async()=>{
  const f=fixture();assert.equal((await ensureDesktop(f.options)).ok,true);
  assert.ok(f.commands.findIndex(a=>a[0]==="build")<f.commands.findIndex(a=>a[0]==="stop"));
  assert.equal(f.containers.get("lumen-box").Config.Labels[REVISION_LABEL],f.options.revision);
  const previous=[...f.containers.entries()].find(([name])=>name.startsWith("lumen-box-previous-"));
  assert.equal(previous[1],f.original);assert.equal(previous[1].privateFile,"kept in old writable layer");
  assert.ok(f.commands.find(a=>a[0]==="run").includes("lumen-box-home:/home/node"));
  assert.equal(f.commands.some(a=>a[0]==="rm"),false);
});
test("构建失败继续保留运行中的旧桌面，不停止或删除用户环境",async()=>{
  const f=fixture({failBuild:true});assert.equal((await ensureDesktop(f.options)).ok,false);
  assert.equal(f.containers.get("lumen-box"),f.original);assert.equal(f.original.State.Running,true);
  assert.equal(f.commands.some(a=>["stop","rename","rm","run"].includes(a[0])),false);
});
test("新桌面运行或健康检查失败时恢复旧容器，且不删除任何卷",async()=>{
  for(const options of [{failRun:true},{failHealth:true}]) {
    const f=fixture(options),result=await ensureDesktop(f.options);
    assert.equal(result.ok,false);assert.match(result.error,/已恢复原桌面/);
    assert.equal(f.containers.get("lumen-box"),f.original);assert.equal(f.original.State.Running,true);
    assert.equal(f.commands.some(a=>a.includes("-v")&&a[0]==="rm"),false);
  }
});
test("当前镜像可直接重新启动；其他工作区的容器不会被升级替换",async()=>{
  const current=fixture({current:true});current.original.State.Running=false;
  assert.equal((await ensureDesktop(current.options)).ok,true);assert.equal(current.original.State.Running,true);
  assert.equal(current.commands.some(a=>["build","rm","rename","run"].includes(a[0])),false);
  const other=fixture();other.original.HostConfig.Binds=["/different/vm-home:/home/node/Downloads"];
  assert.match((await ensureDesktop(other.options)).error,/其他工作区/);
  assert.equal(other.commands.length,1);assert.equal(other.original.State.Running,true);
});
