import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createGateLedger,runScopedSyncRequestId} from "../src/formal-sync.mjs";
import {bootstrapExistingLedger} from "./existing-ledger-bootstrap.mjs";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const gate=join(root,"src","formal-sqlite-gate.py");
const fixture=join(root,"tests","fixtures","legacy-writer-schema-v1.sql");
function fakeUuid(seed){const h=createHash("sha256").update(seed).digest("hex");return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
const config={freee:{companyId:"6312345"},notion:{documentSources:{quotation:fakeUuid("quote-header"),quotationLine:fakeUuid("quote-line"),quotationRelation:"Quote",invoice:fakeUuid("invoice-header"),invoiceLine:fakeUuid("invoice-line"),invoiceRelation:"Invoice"}},policy:{policyId:"fixture-policy",direction:"freee-to-notion",documentTypes:["quotation","invoice"],maxDocumentsPerRun:20,allowedActions:["update","create","archive"],allowedProperties:{header:["Title","Sync state"],line:["Freee line id","Invoice","Quote"]},allowHeaderCreate:false,allowHardDelete:false}};
const run=(...args)=>spawnSync("python",["-X","utf8",gate,...args],{encoding:"utf8",windowsHide:true,timeout:30000});

test("existing writer schema and durable records survive initialization and lease lifecycle",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nfs-legacy-ledger-")),db=join(dir,"ledger.sqlite"),cfg=join(dir,"project.json");
  try{
    await writeFile(cfg,JSON.stringify(config),"utf8");
    const ddl=await readFile(fixture,"utf8");
    const seed=`import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.executescript(open(sys.argv[2],encoding='utf-8').read());d.execute("INSERT INTO writer_audit(seq,event,token,detail,at) VALUES(7,'legacy_unknown_record',NULL,'preserve-me','fixture-time-one')");d.execute("INSERT INTO external_ops(op_key,request_id,method,target,payload_hash,status,error,approval_id,doc_key) VALUES('phase8:legacy:0:abc','legacy-request','notion.update','source','abc','unknown','outcome_unknown','legacy-approval','quote:42')");d.execute("INSERT INTO approval_requests VALUES('approval-legacy','scope-json','payload-hash','fixture-time-two','consumed')");d.execute("INSERT INTO exceptional_post_retries(original_op_key,retry_op_key,request_id,payload_hash,approval_id,preflight_sha256,status,freee_id,sync_status) VALUES('orig','retry','request','payload','approval','preflight','unknown',NULL,'not_started')");d.execute("INSERT INTO corrected_post_retries(root_op_key,prior_retry_op_key,retry_op_key,request_id,payload_hash,approval_id,preflight_sha256,status) VALUES('root','prior','retry2','request2','payload2','approval2','preflight2','started')");d.execute("INSERT INTO invoice_post_retries(original_op_key,retry_op_key,request_id,payload_hash,approval_id,preflight_sha256,status) VALUES('inv-orig','inv-retry','inv-request','inv-payload','inv-approval','inv-preflight','unknown')");d.execute("INSERT INTO notion_test_approvals VALUES('test-approval','generation','header-db','line-db','scope','plan',3,'fixture','fixture-time-one','consumed',NULL,CURRENT_TIMESTAMP)");d.execute("INSERT INTO notion_host_approvals VALUES('host-approval','generation2','header-db','line-db','scope2','plan2',3,'user','Fixture User','context','fixture-time-one','fixture-time-two','consumed',NULL,CURRENT_TIMESTAMP)");d.commit();d.close()`;
    const seeded=spawnSync("python",["-X","utf8","-c",seed,db,fixture],{encoding:"utf8",windowsHide:true});assert.equal(seeded.status,0,seeded.stderr);
    const status=run("status","--db",db,"--config",cfg);assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).ok,true);
    const acquired=run("acquire","--db",db,"--config",cfg,"--owner-pid",String(process.pid));assert.equal(acquired.status,0,acquired.stderr);const lease=JSON.parse(acquired.stdout).token;assert.ok(lease);
    const released=run("release","--db",db,"--config",cfg,"--token",lease);assert.equal(released.status,0,released.stderr);
    const inspect=`import sqlite3,json,sys;d=sqlite3.connect(sys.argv[1]);names={x[0] for x in d.execute("SELECT name FROM sqlite_master WHERE type='table'")};print(json.dumps({'tables':sorted(names),'audit':d.execute("SELECT seq,event,detail FROM writer_audit WHERE seq=7").fetchone(),'ops':d.execute("SELECT op_key,status,approval_id,doc_key FROM external_ops").fetchall(),'approvals':d.execute("SELECT request_id,status FROM approval_requests").fetchall(),'exceptional':d.execute("SELECT original_op_key,status FROM exceptional_post_retries").fetchall(),'corrected':d.execute("SELECT root_op_key,status FROM corrected_post_retries").fetchall(),'invoice':d.execute("SELECT original_op_key,status FROM invoice_post_retries").fetchall(),'testApproval':d.execute("SELECT approval_id,state FROM notion_test_approvals").fetchall(),'hostApproval':d.execute("SELECT approval_id,state FROM notion_host_approvals").fetchall(),'lease':d.execute("SELECT token FROM writer_lease").fetchone()}))`;
    const inspected=spawnSync("python",["-X","utf8","-c",inspect,db],{encoding:"utf8",windowsHide:true});assert.equal(inspected.status,0,inspected.stderr);const state=JSON.parse(inspected.stdout);
    for(const name of ["approval_requests","exceptional_post_retries","corrected_post_retries","invoice_post_retries","notion_test_approvals","notion_host_approvals"])assert.ok(state.tables.includes(name),`preserved ${name}`);
    assert.deepEqual(state.audit,[7,"legacy_unknown_record","preserve-me"]);assert.deepEqual(state.ops,[["phase8:legacy:0:abc","unknown","legacy-approval","quote:42"]]);assert.deepEqual(state.approvals,[["approval-legacy","consumed"]]);assert.deepEqual(state.exceptional,[["orig","unknown"]]);assert.deepEqual(state.corrected,[["root","started"]]);assert.deepEqual(state.invoice,[["inv-orig","unknown"]]);assert.deepEqual(state.testApproval,[["test-approval","consumed"]]);assert.deepEqual(state.hostApproval,[["host-approval","consumed"]]);assert.equal(state.lease,null);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("run-scoped sync request IDs bind run, type, and registered document ID",()=>{
  assert.equal(runScopedSyncRequestId({runId:"run-1",documentType:"quotation",freeeId:"42"}),"continuous:run-1:quotation:42");
  assert.notEqual(runScopedSyncRequestId({runId:"run-1",documentType:"invoice",freeeId:"43"}),runScopedSyncRequestId({runId:"run-2",documentType:"invoice",freeeId:"43"}));
  assert.throws(()=>runScopedSyncRequestId({runId:"r",documentType:"unknown",freeeId:"1"}),/formal_sync_request_identity_invalid/);
});

test("first-registration gate recognizes legacy document-number keys across request identities",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nfs-cross-ledger-")),db=join(dir,"ledger.sqlite"),cfg=join(dir,"project.json");
  try{
    await writeFile(cfg,JSON.stringify(config),"utf8");
    const ddl=await readFile(fixture,"utf8"),seed=`import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.executescript(open(sys.argv[2],encoding='utf-8').read());d.execute("INSERT INTO external_ops(op_key,request_id,method,target,payload_hash,status,doc_key) VALUES('legacy-success','old-request','POST','/quotations',?,'succeeded','Q-100')",('a'*64,));d.execute("INSERT INTO external_ops(op_key,request_id,method,target,payload_hash,status,doc_key) VALUES('legacy-unknown','old-request-2','POST','/quotations',?,'unknown','Q-200')",('b'*64,));d.execute("INSERT INTO external_ops(op_key,request_id,method,target,payload_hash,status,doc_key) VALUES('legacy-started','old-request-3','POST','/invoices',?,'started','I-300')",('c'*64,));d.commit()`;
    const seeded=spawnSync("python",["-X","utf8","-c",seed,db,fixture],{encoding:"utf8",windowsHide:true});assert.equal(seeded.status,0,seeded.stderr);
    const request=(documentNumber,documentType="quotation",requestId=`public-${documentNumber}`)=>({request_id:requestId,company_id:"6312345",partner_id:"42",document_type:documentType,document_number:documentNumber,notion_header_id:`header-${requestId}`,notion_line_ids:[],notion_freee_id_property:"freee_id",notion_document_number_property:"document_number",notion_line_freee_id_property:"freee_line_id",body:{company_id:6312345,partner_id:42,[documentType==="quotation"?"quotation_number":"invoice_number"]:documentNumber,lines:[]},notion_registration:{header:{datasource:config.notion.documentSources[documentType],properties:{freee_id:"",document_number:documentNumber}},lines:[]}});
    const approvalFor=r=>async preview=>({approved:true,origin:"host_interactive_approval",approval_id:`approval-${r.request_id}`,issued_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),request_id:r.request_id,company_id:Number(r.company_id),document_type:r.document_type,document_number:r.document_number,freee_payload_sha256:preview.freee_payload_sha256,notion_header_id:r.notion_header_id,notion_line_ids:[],notion_header_datasource:r.notion_registration.header.datasource,notion_line_datasources:[],notion_header_properties:Object.keys(r.notion_registration.header.properties).sort(),notion_line_properties:[]});
    const evidence=r=>{const payloadHash=createHash("sha256").update(JSON.stringify(r.body)).digest("hex"),docKey=`${r.company_id}|${r.document_type}|${r.document_number}`,method=`freee.${r.document_type}.create`,target=`freee:/${r.document_type==="quotation"?"quotations":"invoices"}`,approvalId=`approval-${r.request_id}`,expiresAt=new Date(Date.now()+60000).toISOString();return{request_id:r.request_id,operation_key:`freee:${r.document_type}:create:${r.request_id}`,method,target,payload_hash:payloadHash,approval_id:approvalId,doc_key:docKey,approval_scope:{approved:true,approval_id:approvalId,request_id:r.request_id,operation:method,target,payload_sha256:payloadHash,doc_key:docKey,expires_at:expiresAt}};};
    const scope=structuredClone(config);scope.policy.allowedActions=["create","update"];
    const scopePath=join(dir,"project.json");await writeFile(scopePath,JSON.stringify(scope),"utf8");
    const ledgerModule=await import("../src/formal-sync.mjs"),ledger=ledgerModule.createGateLedger({dbPath:db,configPath:scopePath}),lease=await ledger.acquire();
    try{
      for(const r of [request("Q-100"),request("Q-200"),request("I-300","invoice")])await assert.rejects(ledger.externalIntent({lease,evidence:evidence(r)}),/external_document_operation_already_recorded/);
      const independent=request("Q-400"),fresh=evidence(independent);await ledger.externalIntent({lease,evidence:fresh});await ledger.externalFinish({lease,evidence:{...fresh,result_id:"freee-new-id"}});
      const check=`import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(d.execute("SELECT status FROM external_ops WHERE op_key='freee:quotation:create:public-Q-400'").fetchone()[0]);print(d.execute("SELECT status FROM external_ops WHERE op_key='legacy-unknown'").fetchone()[0]);print(d.execute("SELECT status FROM external_ops WHERE op_key='legacy-started'").fetchone()[0])`;
      const verified=spawnSync("python",["-X","utf8","-c",check,db],{encoding:"utf8",windowsHide:true});assert.equal(verified.status,0,verified.stderr);assert.match(verified.stdout,/succeeded\r?\nunknown\r?\nstarted/);
    }finally{await ledger.release(lease);}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("cross-writer ledger E2E uses an externally supplied compatible writer schema",{skip:!process.env.NFS_EXISTING_LEDGER_BOOTSTRAP},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nfs-cross-writer-")),db=join(dir,"ledger.sqlite"),cfg=join(dir,"project.json");
  try{
    await writeFile(cfg,JSON.stringify(config),"utf8");bootstrapExistingLedger(db);
    const seed=`import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute("INSERT INTO writer_audit(event,token,detail) VALUES('legacy_audit',NULL,'preserve')");d.execute("INSERT INTO approval_requests(request_id,scope,payload_hash,expires_at,status) VALUES('legacy-approval','scope','hash','never','consumed')");d.execute("INSERT INTO exceptional_post_retries(original_op_key,retry_op_key,request_id,payload_hash,approval_id,preflight_sha256,status) VALUES('legacy-root','legacy-retry','old-request','old-hash','old-approval','old-preflight','unknown')");d.executemany("INSERT INTO external_ops(op_key,request_id,method,target,payload_hash,status,doc_key) VALUES(?,?,?,?,?,?,?)",[('legacy-success','old-success','POST','/quotations','a'*64,'succeeded','Q-100'),('legacy-unknown','old-unknown','POST','/quotations','b'*64,'unknown','Q-200'),('legacy-started','old-started','POST','/invoices','c'*64,'started','I-300')]);d.commit();d.close()`;
    const seeded=spawnSync("python",["-X","utf8","-c",seed,db],{encoding:"utf8",windowsHide:true});assert.equal(seeded.status,0,seeded.stderr);
    const evidence=(number,type="quotation",requestId=`current-${number}`)=>{const method=`freee.${type}.create`,path=type==="quotation"?"/quotations":"/invoices",target=`freee:${path}`,payloadHash="d".repeat(64),docKey=`6312345|${type}|${number}`,approvalId=`approval-${requestId}`,expiresAt=new Date(Date.now()+60000).toISOString();return{request_id:requestId,operation_key:`freee:${type}:create:${requestId}`,method,target,payload_hash:payloadHash,approval_id:approvalId,doc_key:docKey,approval_scope:{approved:true,approval_id:approvalId,request_id:requestId,operation:method,target,payload_sha256:payloadHash,doc_key:docKey,expires_at:expiresAt}};};
    const ledger=createGateLedger({dbPath:db,configPath:cfg}),lease=await ledger.acquire();
    try{
      for(const row of [evidence("Q-100"),evidence("Q-200"),evidence("I-300","invoice")])await assert.rejects(ledger.externalIntent({lease,evidence:row}),/external_document_operation_already_recorded/);
      const independent=evidence("Q-400");await ledger.externalIntent({lease,evidence:independent});await ledger.externalFinish({lease,evidence:{...independent,result_id:"fictional-result"}});
    }finally{await ledger.release(lease);}
    // Re-open the same temporary database through the originating writer after
    // candidate operations to prove the rollback reader still accepts it.
    bootstrapExistingLedger(db);
    const inspect=`import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(d.execute("SELECT op_key,status FROM external_ops ORDER BY op_key").fetchall());print(d.execute("SELECT token FROM writer_lease").fetchone());print(d.execute("SELECT detail FROM writer_audit WHERE event='legacy_audit'").fetchone());print(d.execute("SELECT status FROM approval_requests WHERE request_id='legacy-approval'").fetchone());print(d.execute("SELECT status FROM exceptional_post_retries WHERE original_op_key='legacy-root'").fetchone())`;
    const read=spawnSync("python",["-X","utf8","-c",inspect,db],{encoding:"utf8",windowsHide:true});assert.equal(read.status,0,read.stderr);assert.match(read.stdout,/legacy-success', 'succeeded'/);assert.match(read.stdout,/legacy-unknown', 'unknown'/);assert.match(read.stdout,/legacy-started', 'started'/);assert.match(read.stdout,/current-Q-400/);assert.match(read.stdout,/None/);assert.match(read.stdout,/preserve/);assert.match(read.stdout,/consumed/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("legacy three-table ledger gains only the missing evidence columns",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nfs-old-ledger-")),db=join(dir,"old.sqlite"),cfg=join(dir,"project.json");
  try{
    await writeFile(cfg,JSON.stringify(config),"utf8");
    const create=`import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.executescript("CREATE TABLE writer_lease(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,host TEXT NOT NULL,pid INTEGER NOT NULL,started_at TEXT NOT NULL);CREATE TABLE writer_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,token TEXT,detail TEXT NOT NULL,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);CREATE TABLE external_ops(op_key TEXT PRIMARY KEY,request_id TEXT NOT NULL,method TEXT NOT NULL,target TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,result_id TEXT,error TEXT,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,approval_id TEXT);INSERT INTO external_ops VALUES('legacy-op','legacy-r','POST','/quotations','hash','unknown',NULL,'unknown',CURRENT_TIMESTAMP,NULL);");d.commit();d.close()`;
    const seeded=spawnSync("python",["-X","utf8","-c",create,db],{encoding:"utf8",windowsHide:true});assert.equal(seeded.status,0,seeded.stderr);
    const status=run("status","--db",db,"--config",cfg);assert.equal(status.status,0,status.stderr);
    const inspect=`import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(d.execute("PRAGMA table_info(external_ops)").fetchall());print(d.execute("SELECT op_key,status FROM external_ops").fetchall())`;
    const result=spawnSync("python",["-X","utf8","-c",inspect,db],{encoding:"utf8",windowsHide:true});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/approval_id/);assert.match(result.stdout,/doc_key/);assert.match(result.stdout,/\('legacy-op', 'unknown'\)/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
