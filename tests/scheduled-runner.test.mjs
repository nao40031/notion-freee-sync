import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {runScheduledSync} from "../src/scheduled-runner.mjs";

test("scheduled one-shot runner emits completion and does not turn notification errors into retries",async()=>{
  let runs=0;const events=[],result=await runScheduledSync({service:{async run(){runs++;return{documents_processed:2,documents_unchanged:2,documents_failed:0};}},emit:async event=>{events.push(event);if(event.type==="sync_run_started")throw Error("notification sink offline");},now:(()=>{let n=0;return()=>new Date(1000*(++n));})()});
  assert.equal(result.status,"succeeded");assert.equal(result.documents_processed,2);assert.equal(result.event_sink_errors,1);assert.equal(runs,1);assert.deepEqual(events.map(x=>x.type),["sync_run_started","sync_run_completed"]);
});

test("scheduled runner sanitizes failures and reports them without exposing error text",async()=>{
  const events=[];await assert.rejects(()=>runScheduledSync({service:{async run(){throw Error("access_token=fictional-secret");}},emit:async event=>events.push(event)}),error=>{
    assert.equal(error.runSummary.status,"failed");assert.equal(error.runSummary.error_type,"sync_run_failed");assert.ok(!JSON.stringify(error.runSummary).includes("fictional-secret"));return true;
  });assert.equal(events.at(-1).type,"sync_run_failed");
});

test("configured scheduled entry loads an external host module and runs once",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"scheduled-host-")),host=join(dir,"host.mjs"),script=resolve("scripts/run-configured-sync.mjs");
  try{await writeFile(host,'export async function createSyncHost(){return {service:{async run(){return {documents_processed:1,documents_unchanged:1,documents_failed:0}}}}}\n');
    const result=spawnSync(process.execPath,[script,"--host-module",host],{encoding:"utf8",windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);const summary=JSON.parse(result.stdout.trim());assert.equal(summary.status,"succeeded");assert.equal(summary.documents_processed,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
