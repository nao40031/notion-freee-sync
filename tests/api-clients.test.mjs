import test from "node:test";
import assert from "node:assert/strict";
import {createFreeeReadClient,createNotionClient,safeGet} from "../src/api-clients.mjs";

test("freee client performs only an identity-scoped GET",async()=>{
 const calls=[];
 const client=createFreeeReadClient({tokenProvider:async()=>"synthetic-token",fetchImpl:async(url,options)=>{
   calls.push({url,method:options.method});return {ok:true,status:200,json:async()=>({id:"42"})};
 }});
 const doc=await client.getDocument("quotation","12345","42");
 assert.equal(doc.id,"42");assert.equal(calls[0].method,"GET");assert.match(calls[0].url,/company_id=12345/);
 await assert.rejects(client.getDocument("unknown","12345","42"));
});

test("Notion update requires an explicit operation and page scope",async()=>{
 let calls=0;
 const client=createNotionClient({tokenProvider:async()=>"synthetic-token",writeScope:{enabled:true,operations:["update_page"],pageIds:["page-1"],dataSourceIds:["source-1"],properties:["Title"]},fetchImpl:async()=>{
   calls++;return {ok:true,status:200,json:async()=>({id:"page-1"})};
 }});
 await assert.rejects(client.updatePage("page-2",{},"source-1"),e=>e.code==="notion_page_out_of_scope");
 assert.equal(calls,0);
 await assert.rejects(client.updatePage("page-1",{properties:{"Other Property":{}}},"source-1"),e=>e.code==="notion_property_out_of_scope");
 await client.updatePage("page-1",{properties:{Title:{title:[]}}},"source-1");assert.equal(calls,1);
 await assert.rejects(client.createPage("source-1",{}),e=>e.code==="notion_write_not_authorized");
});

test("Notion mutations require an allowed data source and creates must target that source",async()=>{
 let calls=0;
 const client=createNotionClient({tokenProvider:async()=>"synthetic-token",writeScope:{enabled:true,operations:["create_page","update_page","archive_page"],
   pageIds:["page-1"],dataSourceIds:["source-1"],properties:["Title"],allowCreate:true},fetchImpl:async()=>{
   calls++;return {ok:true,status:200,json:async()=>({id:"new-page"})};
 }});
 await assert.rejects(client.updatePage("page-1",{properties:{Title:{title:[]}}}),e=>e.code==="notion_data_source_out_of_scope");
 await assert.rejects(client.createPage("source-2",{parent:{data_source_id:"source-2"},properties:{}}),e=>e.code==="notion_data_source_out_of_scope");
 await assert.rejects(client.createPage("source-1",{parent:{data_source_id:"source-2"},properties:{}}),e=>e.code==="notion_create_parent_mismatch");
 assert.equal(calls,0);
 await client.createPage("source-1",{parent:{data_source_id:"source-1"},properties:{Title:{title:[]}}});
 assert.equal(calls,1);
});

test("safeGet retries a bounded transient response",async()=>{
 const seen=[];const sleeps=[];
 const response={status:200,ok:true};
 const result=await safeGet(async(_url,opts)=>{seen.push(opts.method);return seen.length===1?{status:503}:response;},"https://example.invalid",{sleep:async ms=>sleeps.push(ms)});
 assert.equal(result,response);assert.deepEqual(seen,["GET","GET"]);assert.equal(sleeps.length,1);
});

test("Notion source query is read-only discovery",async()=>{
 const methods=[];
 const client=createNotionClient({tokenProvider:async()=>"synthetic-token",fetchImpl:async(url,options)=>{
  methods.push(options.method);return {ok:true,status:200,json:async()=>({results:[]})};
 }});
 await client.queryDataSource("source-1",{page_size:10});
 assert.deepEqual(methods,["POST"]);
});
