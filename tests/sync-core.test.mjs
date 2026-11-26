import test from "node:test";
import assert from "node:assert/strict";
import {planDocumentSync,runBatch,SyncError} from "../src/sync-core.mjs";
import {createMonitor} from "../src/monitor.mjs";

const propertyMap={documentType:"Type",freeeId:"Freee ID",companyId:"Company",documentNumber:"Number",title:"Title",status:"Status",branch:"Branch",
  amountExcludingTax:"Net",amountTax:"Tax",amountIncludingTax:"Gross",freeeLineId:"Freee Line ID",lineParentRelation:"Parent",quantity:"Quantity",unitPrice:"Unit Price",
  taxRate:"Tax Rate",unit:"Unit",lineNumber:"Line Number",syncState:"Sync State",sourceHash:"Source Hash",syncedAt:"Synced At"};
const policy={companyId:"12345",documentTypes:["quotation","invoice"],maxDocumentsPerRun:100,allowArchiveRemovedLines:true,lineReissueKeyFields:["description","unit"]};
function sample({lineId="l1",description="Design",headerTitle="Q-1",syncState="synced",sourceHash="a".repeat(64),syncedAt="yesterday"}={}) {
 const document={documentType:"quotation",freeeId:"q1",companyId:"12345",documentNumber:"Q-1",registered:true,notionHeaderId:"head1"};
 const header={pageId:"head1",freeeId:"q1",companyId:"12345",documentType:"quotation",documentNumber:"Q-1",title:headerTitle,status:"draft",branch:null,
  amountExcludingTax:100,amountTax:10,amountIncludingTax:110,syncState,sourceHash,syncedAt};
 const line={id:lineId,description,quantity:1,unitPrice:100,taxRate:10,amountExcludingTax:100,unit:"hour"};
 const notionLines=[{pageId:"linepage1",freeeLineId:"old-line",identity:{description:"Design",unit:"hour"},title:"Design",quantity:1,unitPrice:100,taxRate:10,amountExcludingTax:100,unit:"hour",lineNumber:1,relations:{Parent:["head1"]}}];
 const freeeDocument={id:"q1",companyId:"12345",documentNumber:"Q-1",title:"Q-1",status:"draft",amountExcludingTax:100,amountTax:10,amountIncludingTax:110,sourceHash:"b".repeat(64),lines:[line]};
 return {document,header,notionLines,freeeDocument};
}

test("plans id reissue as update to existing page and preserves parent relation",()=>{
 const s=sample(); const p=planDocumentSync({...s,propertyMap,policy});
 assert.equal(p.operations.some(x=>x.action==="create_line"),false);
 assert.equal(p.operations.find(x=>x.action==="update_line")?.pageId,"linepage1");
 assert.equal(p.operations.find(x=>x.action==="update_line")?.properties["Freee Line ID"],"l1");
});

test("ambiguous duplicate line keys fail closed",()=>{
 const s=sample(); s.notionLines.push({...s.notionLines[0],pageId:"linepage2",freeeLineId:"old-line-2"});
 assert.throws(()=>planDocumentSync({...s,propertyMap,policy}),e=>e instanceof SyncError&&e.code==="line_reissue_mapping_ambiguous");
});

test("tax total mismatch stops before writer",()=>{
 const s=sample(); s.freeeDocument.amountIncludingTax=111;
 assert.throws(()=>planDocumentSync({...s,propertyMap,policy}),e=>e.code==="freee_totals_inconsistent");
});

test("source-identical data and metadata is no-op",()=>{
 const s=sample(); s.header.sourceHash=s.freeeDocument.sourceHash; s.notionLines[0].freeeLineId="l1";
 const p=planDocumentSync({...s,propertyMap,policy});
 assert.equal(p.noOp,true); assert.equal(p.writeCount,0);
});

test("batch no-op guard plans all records before any apply",async()=>{
 const docs=[sample().document,sample().document]; docs[1]={...docs[1],freeeId:"q2",notionHeaderId:"head2"};
 const events=[]; let applied=0;
 const noOpPlan={noOp:true,writeCount:0};
 const out=await runBatch({documents:docs,policy:{...policy,requireNoOp:true},loadSnapshot:async()=>({}),plan:()=>noOpPlan,apply:async()=>{applied++;},emit:async e=>events.push(e)});
 assert.equal(applied,0); assert.equal(out.plannedOperations,0); assert.equal(events[0].event,"batch_started");
});

test("no-op guard rejects entire batch before apply",async()=>{
 let applied=0;
 await assert.rejects(runBatch({documents:[sample().document],policy:{...policy,requireNoOp:true},loadSnapshot:async()=>({}),
   plan:()=>({noOp:false,writeCount:1}),apply:async()=>{applied++;}}),e=>e.code==="noop_guard_failed");
 assert.equal(applied,0);
});

test("monitor logs failure and deduplicates notifications",async()=>{
 const logged=[],notified=[];const monitor=createMonitor({append:async x=>logged.push(x),notify:async x=>notified.push(x)});
 await monitor.emit({event:"sync_failed",runId:"r1",documentType:"invoice",documentId:"i1",status:"failed",reason:"api_error"});
 await monitor.emit({event:"sync_failed",runId:"r2",documentType:"invoice",documentId:"i1",status:"failed",reason:"api_error"});
 assert.equal(logged.length,2);assert.equal(notified.length,1);
});
