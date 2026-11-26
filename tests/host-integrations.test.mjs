import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {WindowsDpapiTokenStore} from "../src/windows-credential-store.mjs";
import {startLoopbackOAuthCallback} from "../src/loopback-oauth-callback.mjs";
import {createGmailApiNotifier} from "../src/gmail-api-notifier.mjs";
import {createOAuthTokenProvider} from "../src/oauth-token-provider.mjs";

test("Windows token store encrypts through injected DPAPI, isolates profile paths and serializes cross-process callers",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"generic-token-store-")),calls=[];
  const dpapi={async protect(value){return `cipher:${Buffer.from(value).toString("base64")}`;},async unprotect(value){return Buffer.from(value.slice(7),"base64").toString();},async secureDirectory(path){calls.push(path);await mkdir(path,{recursive:true});}};
  const first=new WindowsDpapiTokenStore({root:join(dir,"project-a"),dpapi,lockTimeoutMs:500,pollMs:2});
  const second=new WindowsDpapiTokenStore({root:join(dir,"project-a"),dpapi,lockTimeoutMs:500,pollMs:2});
  const other=new WindowsDpapiTokenStore({root:join(dir,"project-b"),dpapi});
  try{
    await first.save({access_token:"access-a",refresh_token:"refresh-a",expires_at:123});
    assert.deepEqual(await first.load(),{access_token:"access-a",refresh_token:"refresh-a",expires_at:123});
    assert.equal(await other.load(),null);
    let active=0,maximum=0;
    await Promise.all([first,second].map(store=>store.withLock(async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,25));active--;})));
    assert.equal(maximum,1);assert.ok(calls.includes(first.root));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Windows token store file lock blocks a separate Node process until the lease owner releases it",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"token-process-lock-")),root=join(dir,"profile"),marker=join(dir,"child-acquired"),
    dpapi={async protect(v){return v;},async unprotect(v){return v;},async secureDirectory(p){await mkdir(p,{recursive:true});}},
    owner=new WindowsDpapiTokenStore({root,dpapi}),moduleUrl=new URL("../src/windows-credential-store.mjs",import.meta.url).href;
  let child,stderr="";
  try{
    await owner.withLock(async()=>{
      const program=`import {WindowsDpapiTokenStore} from ${JSON.stringify(moduleUrl)}; import {writeFile} from 'node:fs/promises'; const store=new WindowsDpapiTokenStore({root:${JSON.stringify(root)},dpapi:{async protect(v){return v},async unprotect(v){return v},async secureDirectory(){}}}); await store.withLock(async()=>writeFile(${JSON.stringify(marker)},'acquired'));`;
      child=spawn(process.execPath,["--input-type=module","-e",program],{windowsHide:true,stdio:["ignore","ignore","pipe"]});child.stderr.on("data",chunk=>stderr+=chunk);
      await new Promise(resolvePromise=>setTimeout(resolvePromise,150));assert.equal(existsSync(marker),false);
    });
    const exitCode=await new Promise((resolvePromise,rejectPromise)=>{child.once("error",rejectPromise);child.once("exit",code=>resolvePromise(code));});assert.equal(exitCode,0,stderr);assert.equal(existsSync(marker),true);
  }finally{if(child&&!child.killed){try{child.kill();}catch{}}await rm(dir,{recursive:true,force:true});}
});

test("OAuth loopback callback rejects wrong state and accepts one code exactly once",async()=>{
  const {EventEmitter}=await import("node:events");let requestHandler;
  class FakeServer extends EventEmitter{on(name,fn){if(name==="request")requestHandler=fn;return super.on(name,fn);}listen(_port,_host,done){done();}address(){return{address:"127.0.0.1",family:"IPv4",port:18765};}close(done){done?.();}}
  const session=await startLoopbackOAuthCallback({redirectUri:"http://127.0.0.1:18765/callback",port:18765,path:"/callback",timeoutMs:2000,serverFactory:()=>new FakeServer(),
    random:()=>Buffer.from("a".repeat(32)),authorizationUrlForState:({state})=>`https://identity.example.invalid/authorize?state=${state}`});
  try{
    const response=()=>({status:null,body:"",writeHead(status){this.status=status;return this;},end(body=""){this.body=body;}});
    const bad=response();requestHandler({socket:{remoteAddress:"127.0.0.1"},method:"GET",url:"/callback?state=wrong&code=must-not-leak"},bad);assert.equal(bad.status,400);
    const good=response();requestHandler({socket:{remoteAddress:"127.0.0.1"},method:"GET",url:`/callback?state=${session.state}&code=one-time-code`},good);assert.equal(good.status,200);
    const result=await session.wait();assert.equal(result.code,"one-time-code");assert.match(result.received_at,/Z$/);
    const second=response();requestHandler({socket:{remoteAddress:"127.0.0.1"},method:"GET",url:`/callback?state=${session.state}&code=second-code`},second);assert.equal(second.status,409);
  }finally{await session.close().catch(()=>{});}
});

test("isolated host E2E connects loopback authorization, token exchange and encrypted-store port",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"oauth-host-e2e-"));let requestHandler,posts=0;
  const {EventEmitter}=await import("node:events");
  class FakeServer extends EventEmitter{on(name,fn){if(name==="request")requestHandler=fn;return super.on(name,fn);}listen(_port,_host,done){done();}address(){return{address:"127.0.0.1",family:"IPv4",port:18766};}close(done){done?.();}}
  const store=new WindowsDpapiTokenStore({root:join(dir,"profile-a"),dpapi:{async protect(v){return `cipher:${Buffer.from(v).toString("base64")}`;},async unprotect(v){return Buffer.from(v.slice(7),"base64").toString();},async secureDirectory(p){await mkdir(p,{recursive:true});}}});
  const provider=createOAuthTokenProvider({tokenUrl:"https://oauth.example.invalid/token",clientId:"fictional-client",clientSecret:"fictional-secret",store,
    fetchImpl:async(_url,init)=>{posts++;assert.equal(init.method,"POST");assert.equal(new URLSearchParams(init.body).get("grant_type"),"authorization_code");return{ok:true,json:async()=>({access_token:"access-a",refresh_token:"refresh-a",expires_in:3600})};}});
  const session=await startLoopbackOAuthCallback({redirectUri:"http://127.0.0.1:18766/callback",port:18766,path:"/callback",timeoutMs:2000,serverFactory:()=>new FakeServer(),
    random:()=>Buffer.from("b".repeat(32)),authorizationUrlForState:({state})=>`https://identity.example.invalid/authorize?state=${state}`});
  try{
    const res={writeHead(status){this.status=status;return this;},end(){}};
    requestHandler({socket:{remoteAddress:"127.0.0.1"},method:"GET",url:`/callback?state=${session.state}&code=fixture-code`},res);
    const {code}=await session.wait();await provider.exchangeCode({code,redirectUri:session.redirectUri});
    assert.equal(posts,1);assert.equal(await provider.getAccessToken(),"access-a");assert.equal((await store.load()).refresh_token,"refresh-a");
  }finally{await session.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("Gmail API notifier sends only sanitized failure summaries using the host OAuth port",async()=>{
  const fakeAddress="ops"+"@"+"example.invalid";let captured;const notifier=createGmailApiNotifier({tokenProvider:{async getAccessToken(){return "bearer-a";}},from:fakeAddress,to:fakeAddress,
    fetchImpl:async(url,options)=>{captured={url,options};return{ok:true,json:async()=>({id:"fake-message-id"})};}});
  const result=await notifier({type:"sync_unknown",document_type:"quotation",freee_id:"12345",reason:"sync_unknown",summary:"token=secret\r\nleak",log_reference:"local-log"});
  assert.equal(result.sent,true);assert.equal(result.message_id,"fake-message-id");assert.equal(captured.options.method,"POST");
  assert.equal(captured.options.headers.authorization,"Bearer bearer-a");
  const message=Buffer.from(JSON.parse(captured.options.body).raw.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString();
  assert.match(message,/Sync outcome unknown/);assert.match(message,/no automatic resend/);assert.doesNotMatch(message,/token=secret/);assert.doesNotMatch(captured.options.body,/bearer-a/);
  await assert.rejects(()=>notifier({type:"sync_run_completed"}),/gmail_notification_event_invalid/);
});

test("Windows task setup plan is reproducible and does not register or enable a task",async()=>{
  if(process.platform!=="win32")return;
  const dir=await mkdtemp(join(tmpdir(),"task-plan-")),host=join(dir,"host.mjs");
  try{await writeFile(host,"export async function createSyncHost(){ return {}; }\n");
    const script=resolve("scripts/manage-windows-sync-task.ps1"),root=resolve("."),ps=spawnSync("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,"-Mode","plan","-TaskName","fictional-project-sync","-ProjectRoot",root,"-HostModule",host,"-At","09:15"],{encoding:"utf8",windowsHide:true,timeout:15000});
    assert.equal(ps.status,0,ps.stderr);const plan=JSON.parse(ps.stdout.trim());assert.equal(plan.schedule,"weekdays");assert.equal(plan.at,"09:15");assert.equal(plan.register_enabled,false);assert.equal(plan.no_task_will_be_created,true);assert.match(plan.user,/\\/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
