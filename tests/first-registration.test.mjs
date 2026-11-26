import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createGateLedger} from "../src/formal-sync.mjs";
import {runFirstRegistration,reconcileFirstRegistration} from "../src/first-registration.mjs";
import {createOAuthTokenProvider} from "../src/oauth-token-provider.mjs";
import {generateInvoiceDraft} from "../src/invoice-draft.mjs";
import {createLedgerBackedInvoiceDraftRuntime} from "../src/invoice-draft-runtime.mjs";
import {createFormalRegistrationService} from "../src/formal-registration.mjs";
import {bootstrapExistingLedger} from "./existing-ledger-bootstrap.mjs";

function fakeUuid(char){return `${char.repeat(8)}-${char.repeat(4)}-4${char.repeat(3)}-8${char.repeat(3)}-${char.repeat(12)}`;}
const cfg={freee:{companyId:"100"},notion:{documentSources:{quotation:fakeUuid("1"),quotationLine:fakeUuid("2"),quotationRelation:"Quotation",invoice:fakeUuid("3"),invoiceLine:fakeUuid("4"),invoiceRelation:"Invoice"}},policy:{policyId:"fictional-project-policy",direction:"freee-to-notion",documentTypes:["quotation","invoice"],allowedProperties:{header:["freee-id","number","title"],line:["freee-line-id","description","Quotation"]},allowedActions:["update","create","archive"],allowHeaderCreate:false,allowHardDelete:false}};
function textProp(value){return{type:"rich_text",rich_text:value==null?[]:[{plain_text:String(value)}]};}
function page(id,datasource,properties){return{id,archived:false,parent:{data_source_id:datasource},properties:Object.fromEntries(Object.entries(properties).map(([k,v])=>[k,textProp(v)]))};}
function makeRequest(){return{request_id:"fictional-quote-request-01",document_type:"quotation",company_id:"100",partner_id:"200",document_number:"Q-DEMO-001",notion_header_id:fakeUuid("a"),notion_line_ids:[fakeUuid("b")],notion_header_datasource:cfg.notion.documentSources.quotation,
  notion_freee_id_property:"freee-id",notion_document_number_property:"number",notion_line_freee_id_property:"freee-line-id",
  body:{company_id:100,partner_id:200,quotation_number:"Q-DEMO-001",subject:"Example",lines:[{description:"Service",quantity:1,unit_price:100,tax_rate:10,unit:"unit"}]},
  notion_registration:{header:{datasource:cfg.notion.documentSources.quotation,properties:{"freee-id":null,number:"Q-DEMO-001",title:"Example"}},lines:[{line_index:0,page_id:fakeUuid("b"),datasource:cfg.notion.documentSources.quotationLine,properties:{"freee-line-id":null,description:"Service",Quotation:[fakeUuid("a")]}}]}};}
function authorization(request){const reg=request.notion_registration,now=Date.now();return{approved:true,origin:"host_interactive_approval",approval_id:`fixture-approval-${request.request_id}`,issued_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60000).toISOString(),request_id:request.request_id,company_id:Number(request.company_id),document_type:request.document_type,document_number:request.document_number,freee_payload_sha256:undefined,notion_header_id:request.notion_header_id,notion_line_ids:request.notion_line_ids,notion_header_datasource:reg.header.datasource,notion_line_datasources:reg.lines.map(x=>x.datasource),notion_header_properties:Object.keys(reg.header.properties).sort(),notion_line_properties:reg.lines.map(x=>Object.keys(x.properties).sort())};}
function tokenStore(initial){let saved=structuredClone(initial),tail=Promise.resolve();return{lockCalls:0,async load(){return structuredClone(saved);},async save(v){saved=structuredClone(v);},async withLock(fn){this.lockCalls++;const prior=tail;let release;tail=new Promise(resolve=>release=resolve);await prior;try{return await fn();}finally{release();}},snapshot(){return structuredClone(saved);}};}
function registerTestWorld(dir,request){const dbPath=join(dir,"shared.mock-test.sqlite"),configPath=join(dir,"config.json"),kind=request.document_type,sources={...cfg.notion.documentSources,[kind]:request.notion_registration.header.datasource,[kind+"Line"]:request.notion_registration.lines[0].datasource};
  const docConfig={...cfg,freee:{companyId:request.company_id},notion:{...cfg.notion,documentSources:sources},policy:{...cfg.policy,policyId:`fictional-${request.company_id}-policy`,allowedProperties:{header:Object.keys(request.notion_registration.header.properties),line:Object.keys(request.notion_registration.lines[0].properties)}}};return {dbPath,configPath,async init(){bootstrapExistingLedger(dbPath);await writeFile(configPath,JSON.stringify(docConfig));},pages:new Map([[request.notion_header_id,page(request.notion_header_id,request.notion_registration.header.datasource,request.notion_registration.header.properties)],[request.notion_line_ids[0],page(request.notion_line_ids[0],request.notion_registration.lines[0].datasource,request.notion_registration.lines[0].properties)]]),freeeDocs:new Map(),mutations:0,posts:0};}
function documentFor(request){const numberKey=request.document_type==="quotation"?"quotation_number":"invoice_number";return{id:"5001",company_id:request.company_id,partner_id:request.partner_id,[numberKey]:request.document_number,amount_excluding_tax:100,amount_tax:10,amount_including_tax:110,lines:[{id:"6001",description:"Service",quantity:1,unit_price:100,tax_rate:10,unit:"unit",amount_excluding_tax:100}]};}
function typedPageMatches(world,request,pageId,ds,patch){const p=world.pages.get(pageId);for(const [name,value] of Object.entries(patch)){if(Array.isArray(value)){p.properties[name]={type:"relation",relation:value.map(id=>({id})),has_more:false};}else p.properties[name]=textProp(value);}return p;}
function notionPort(world){return{async getPage(id){return structuredClone(world.pages.get(id));},async updatePage({pageId,datasource,properties,approvalProvider}){await approvalProvider.assertApproved({action:"update",page_id:pageId,datasource,properties});const p=world.pages.get(pageId);if(p.parent.data_source_id!==datasource)throw Error("fake_datasource_mismatch");typedPageMatches(world,null,pageId,datasource,properties);world.mutations++;return{id:pageId};}};}
function requestPorts(world,request,{unknownPost=false}={}){const token=async()=>"fixture";const ledger=createGateLedger({dbPath:world.dbPath,configPath:world.configPath});let preflights=0;return{ledger,
  approvalProvider:async preview=>({...authorization(request),freee_payload_sha256:preview.freee_payload_sha256}),
  preflight:async()=>{preflights++;return{status:"clear",duplicate_count:0,notion_registered:false,identity:request.document_number};},
  freeePost:async()=>{world.posts++;world.freeeDocs.set("5001",documentFor(request));if(unknownPost)throw Error("response_lost_after_commit");return{[request.document_type]:{id:"5001"}};},
  freeeGet:async({documentId})=>({[request.document_type]:structuredClone(world.freeeDocs.get(documentId))}),
  notion:notionPort(world),get preflights(){return preflights;}};}

test("first registration uses the shared SQLite gate, read-back, and no duplicate POST on resume",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"first-registration-")),request=makeRequest(),world=registerTestWorld(dir,request);await world.init();
  try{const ports=requestPorts(world,request),first=await runFirstRegistration({request,...ports});assert.equal(first.status,"complete");assert.equal(first.freee_id,"5001");assert.equal(first.updated_pages,2);assert.equal(world.posts,1);assert.equal(world.mutations,2);
    const again=await runFirstRegistration({request,...ports});assert.equal(again.status,"complete");assert.equal(again.updated_pages,0);assert.equal(world.posts,1);assert.equal(world.mutations,2);const status=await ports.ledger.status();assert.equal(status.lease,null);assert.equal(status.ops.filter(x=>x[5]==="succeeded").length,3);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("formal registration composition connects the shared API clients and SQLite gate end to end",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"formal-registration-e2e-")),request=makeRequest(),world=registerTestWorld(dir,request);await world.init();
  const config=JSON.parse(await (await import("node:fs/promises")).readFile(world.configPath,"utf8"));
  config.notion.propertyMap={freeeId:"freee-id",documentNumber:"number",title:"title",lineFreeeId:"freee-line-id",lineTitle:"description",lineParentRelation:"Quotation"};
  config.notion.propertyTypes={freeeId:"rich_text",documentNumber:"rich_text",title:"title",lineFreeeId:"rich_text",lineTitle:"rich_text",lineParentRelation:"relation"};
  await writeFile(world.configPath,JSON.stringify(config));let freeeDoc=null;const methods=[];
  const notionFetch=async(url,init)=>{const u=new URL(url),id=decodeURIComponent(u.pathname.split("/").at(-1));methods.push(`${init.method} ${u.pathname}`);
    if(init.method==="GET"&&u.pathname.startsWith("/v1/pages/"))return{ok:true,status:200,json:async()=>structuredClone(world.pages.get(id))};
    if(init.method==="PATCH"&&u.pathname.startsWith("/v1/pages/")){const body=JSON.parse(init.body),properties={};for(const [name,value] of Object.entries(body.properties)){const kind=Object.keys(value)[0],raw=value[kind];properties[name]=kind==="rich_text"||kind==="title"?{type:kind,[kind]:raw.map(x=>({plain_text:x.text.content}))}:kind==="relation"?{type:kind,relation:raw,has_more:false}: {type:kind,[kind]:raw};}const p=world.pages.get(id);p.properties={...p.properties,...properties};world.mutations++;return{ok:true,status:200,json:async()=>structuredClone(p)};}
    return{ok:false,status:404,json:async()=>({})};};
  const freeeFetch=async(url,init)=>{const u=new URL(url);methods.push(`${init.method} ${u.pathname}`);if(init.method==="POST"){world.posts++;freeeDoc=documentFor(request);return{ok:true,status:201,json:async()=>({quotation:{id:"5001"}})};}if(init.method==="GET")return{ok:Boolean(freeeDoc),status:freeeDoc?200:404,json:async()=>({quotation:structuredClone(freeeDoc)})};return{ok:false,status:405,json:async()=>({})};};
  const service=createFormalRegistrationService({config,configPath:world.configPath,dbPath:world.dbPath,notionTokenProvider:async()=>"fixture-token",freeeTokenProvider:async()=>"fixture-token",notionFetch,freeeFetch,
    approvalProvider:async preview=>({...authorization(request),freee_payload_sha256:preview.freee_payload_sha256}),preflight:async()=>({status:"clear",duplicate_count:0,notion_registered:false,identity:request.document_number})});
  try{const outside=structuredClone(request);outside.notion_registration.header.datasource=fakeUuid("f");await assert.rejects(()=>service.run(outside),/formal_registration_project_scope_mismatch/);assert.equal(methods.length,0);
    const result=await service.run(request);assert.equal(result.status,"complete");assert.equal(world.posts,1);assert.equal(world.mutations,2);assert.ok(methods.some(x=>x==="POST /api/1/quotations"));assert.equal(methods.filter(x=>x.startsWith("PATCH /v1/pages/")).length,2);assert.equal((await service.ledger.status()).lease,null);}
  finally{await rm(dir,{recursive:true,force:true});}
});

test("first registration accepts a second fictional project's database and property mapping",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"first-registration-alt-")),request=makeRequest();
  request.request_id="fictional-project-b-request";request.company_id="300";request.partner_id="400";request.document_number="ALT-Q-2026-01";
  request.notion_header_id=fakeUuid("c");request.notion_line_ids=[fakeUuid("d")];
  request.notion_header_datasource=fakeUuid("5");request.notion_freee_id_property="External Ref";request.notion_document_number_property="Doc No";request.notion_line_freee_id_property="External Row";
  request.body.company_id=300;request.body.partner_id=400;request.body.quotation_number=request.document_number;
  request.notion_registration={header:{datasource:request.notion_header_datasource,properties:{"External Ref":null,"Doc No":request.document_number,Subject:"Example"}},lines:[{line_index:0,page_id:request.notion_line_ids[0],datasource:fakeUuid("6"),properties:{"External Row":null,Item:"Service","Quote Header":[request.notion_header_id]}}]};
  const world=registerTestWorld(dir,request);await world.init();
  try{const ports=requestPorts(world,request),result=await runFirstRegistration({request,...ports});assert.equal(result.status,"complete");assert.equal(world.posts,1);assert.equal(world.mutations,2);assert.equal((await ports.ledger.status()).lease,null);}
  finally{await rm(dir,{recursive:true,force:true});}
});

test("first registration handles invoices through the same SQLite gate and existing-page update flow",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"first-invoice-registration-")),request=makeRequest();request.request_id="fictional-invoice-request";request.document_type="invoice";request.document_number="I-DEMO-001";
  request.body.invoice_number=request.document_number;delete request.body.quotation_number;request.notion_registration.header.datasource=cfg.notion.documentSources.invoice;request.notion_registration.header.properties.number=request.document_number;
  request.notion_registration.lines[0].datasource=cfg.notion.documentSources.invoiceLine;request.notion_registration.lines[0].properties.Invoice=[request.notion_header_id];
  const world=registerTestWorld(dir,request);await world.init();
  try{const ports=requestPorts(world,request),result=await runFirstRegistration({request,...ports});assert.equal(result.status,"complete");assert.equal(result.freee_id,"5001");assert.equal(world.posts,1);assert.equal(world.mutations,2);assert.equal((await ports.ledger.status()).lease,null);}
  finally{await rm(dir,{recursive:true,force:true});}
});

test("first registration rejects approval for a different request before any external write",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"first-registration-scope-")),request=makeRequest(),world=registerTestWorld(dir,request);await world.init();
  try{const ports=requestPorts(world,request);ports.approvalProvider=async preview=>({...authorization(request),request_id:"other-request",freee_payload_sha256:preview.freee_payload_sha256});
    await assert.rejects(()=>runFirstRegistration({request,...ports}),/registration_approval_scope_invalid/);assert.equal(world.posts,0);assert.equal(world.mutations,0);assert.equal((await ports.ledger.status()).lease,null);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("lost freee POST response becomes unknown, reconciles by unique GET evidence, and never reposts",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"first-registration-unknown-")),request=makeRequest(),world=registerTestWorld(dir,request);await world.init();
  try{const ports=requestPorts(world,request,{unknownPost:true}),first=await runFirstRegistration({request,...ports});assert.equal(first.status,"unknown");assert.equal(world.posts,1);
    const op=`freee:quotation:create:${request.request_id}`,recovered=await reconcileFirstRegistration({request,operationKey:op,ledger:ports.ledger,findFreeeByNumber:async()=>[documentFor(request)],verifyCandidate:async()=>true});assert.equal(recovered.status,"reconciled");
    ports.freeePost=async()=>{world.posts++;throw Error("must_not_post_again");};const resumed=await runFirstRegistration({request,...ports});assert.equal(resumed.status,"complete");assert.equal(world.posts,1);assert.equal(world.mutations,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("freee post read-back failure is durable unknown and prevents duplicate registration",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"first-registration-readback-")),request=makeRequest(),world=registerTestWorld(dir,request);await world.init();
  try{const ports=requestPorts(world,request);ports.freeeGet=async()=>{throw Error("temporary_get_failure");};const first=await runFirstRegistration({request,...ports});assert.equal(first.status,"unknown");assert.equal(first.reason,"freee_post_readback_failed");assert.equal(world.posts,1);
    const recovered=await reconcileFirstRegistration({request,operationKey:`freee:quotation:create:${request.request_id}`,ledger:ports.ledger,findFreeeByNumber:async()=>[documentFor(request)],verifyCandidate:async candidate=>candidate.id==="5001"});assert.equal(recovered.status,"reconciled");
    ports.freeePost=async()=>{world.posts++;throw Error("must_not_post_again");};ports.freeeGet=async({documentId})=>({quotation:structuredClone(world.freeeDocs.get(documentId))});const resumed=await runFirstRegistration({request,...ports});assert.equal(resumed.status,"complete");assert.equal(world.posts,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("OAuth token refresh is single-flight, rotates the refresh token, and does not expose credentials in errors",async()=>{
  let calls=0;const requests=[],store=tokenStore({access_token:"expired",refresh_token:"refresh-1",expires_at:0});
  const options={tokenUrl:"https://oauth.invalid/token",clientId:"client-demo",clientSecret:"secret-demo",store,now:()=>100000,fetchImpl:async(_url,init)=>{calls++;requests.push(new URLSearchParams(init.body));assert.equal(init.method,"POST");await new Promise(resolve=>setTimeout(resolve,5));return{ok:true,status:200,json:async()=>({access_token:"access-2",refresh_token:"refresh-2",expires_in:3600})};}},manager=createOAuthTokenProvider(options),secondProcess=createOAuthTokenProvider(options);
  const tokens=await Promise.all([manager.getAccessToken(),manager.getAccessToken(),secondProcess.getAccessToken()]);assert.deepEqual(tokens,["access-2","access-2","access-2"]);assert.equal(calls,1);assert.equal(store.snapshot().refresh_token,"refresh-2");assert.equal(store.snapshot().access_token,"access-2");
  const locksBeforeExchange=store.lockCalls||0;await manager.exchangeCode({code:"fictional-one-time-code",redirectUri:"https://host.invalid/callback"});assert.equal(calls,2);assert.equal(requests[1].get("grant_type"),"authorization_code");assert.equal(requests[1].get("redirect_uri"),"https://host.invalid/callback");assert.ok((store.lockCalls||0)>locksBeforeExchange);
  const failed=createOAuthTokenProvider({tokenUrl:"https://oauth.invalid/token",clientId:"client-demo",clientSecret:"secret-demo",store:tokenStore({refresh_token:"r",expires_at:0}),fetchImpl:async()=>({ok:false,status:401})});await assert.rejects(()=>failed.getAccessToken(),/oauth_client_auth_failed/);
});

test("copied quote-to-invoice draft flow verifies totals, relations and request idempotency",async()=>{
  const state=new Map(),headers=new Map(),lines=new Map();let headerCreates=0,lineCreates=0;
  const writer={
    async findByRequest(id){return state.get(id)||null;},
    async createHeader(spec){headerCreates++;const value={id:"invoice-header-1",...spec,generation_input_hash:spec.generation_input_hash,lines:[]};headers.set(value.id,value);return{id:value.id};},
    async saveRequest(record){state.set(record.request_id,structuredClone(record));},
    async getPlannedLines(id){return state.get(id)?.planned_lines||null;},
    async findLineByRequest(id,stable){return [...lines.values()].filter(x=>x.generation_request_id===id&&x.stable_id===stable);},
    async createLine({header_id,stable_id,properties}){lineCreates++;const id=`line-${stable_id}`;lines.set(id,{id,header_id,stable_id,...structuredClone(properties)});return id;},
    async getLine(id){return structuredClone(lines.get(id));},
    async getDraft(id){const h=headers.get(id);return h?{...structuredClone(h),lines:[...lines.values()].filter(x=>x.header_id===id).map(x=>structuredClone(x))}:null;}
  };
  const quote={document_type:"quotation",freee_id:"7001",company_id:"100",amount_excluding_tax:"1450",amount_tax:"145",amount_including_tax:"1595",lines:[
    {line_id:"7101",description:"Part A",quantity:"1",unit_price:"1000",amount_excluding_tax:"1000",tax_rate:10,unit:"piece"},
    {line_id:"7102",description:"Part B",quantity:"1",unit_price:"450",amount_excluding_tax:"450",tax_rate:10,unit:"piece"}
  ]};
  const input={quote:{freee_id:"7001",company_id:"100",notion_id:"quote-header",line_notion_ids:{"7101":"quote-line-1","7102":"quote-line-2"}}};
  const first=await generateInvoiceDraft({requestId:"invoice-draft-request-01",input,freeeGet:{async getDetail(){return structuredClone(quote);}},notionWriter:writer});
  assert.equal(first.status,"verified");assert.equal(headerCreates,1);assert.equal(lineCreates,2);assert.equal(first.source_quote_freee_id,"7001");
  assert.equal(lines.get("line-invoice-draft-request-01:L001").copied_from_quote_line_relation[0],"quote-line-1");
  assert.equal(lines.get("line-invoice-draft-request-01:L002").copied_from_quote_line_relation[0],"quote-line-2");
  const repeat=await generateInvoiceDraft({requestId:"invoice-draft-request-01",input,freeeGet:{async getDetail(){return structuredClone(quote);}},notionWriter:writer});
  assert.equal(repeat.status,"verified");assert.equal(headerCreates,1);assert.equal(lineCreates,2);
});

test("invoice draft runtime persists request state and uses the same SQLite external-op ledger",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"invoice-draft-ledger-")),dbPath=join(dir,"shared.mock-test.sqlite"),configPath=join(dir,"config.json");
  const names={generationRequestId:"Generation Request",generationInputHash:"Generation Hash",documentType:"Document Type",sourceQuoteFreeeId:"Source Quote Freee ID",sourceQuoteNotionId:"Source Quote",amountExcludingTax:"Net",amountTax:"Tax",amountIncludingTax:"Gross",status:"Status",description:"Description",quantity:"Quantity",unitPrice:"Unit Price",unit:"Unit",taxRate:"Tax Rate",reducedTaxRate:"Reduced Tax",withholding:"Withholding",lineAmountExcludingTax:"Line Net",copiedFromFreeeLineId:"Copied Freee Line",sourceQuoteLineId:"Source Quote Line",lineRequestKey:"Line Request Key"};
  const config={...cfg,notion:{...cfg.notion,apiVersion:"2022-06-28",propertyMap:names,propertyTypes:Object.fromEntries(Object.keys(names).map(k=>[k,k.toLowerCase().includes("amount")||k==="quantity"||k==="unitPrice"||k==="taxRate"?"number":k==="reducedTaxRate"||k==="withholding"?"checkbox":"rich_text"])),invoiceDraft:{dataSources:{header:cfg.notion.documentSources.invoice,line:cfg.notion.documentSources.invoiceLine},propertyMap:{header:{request_id:"generationRequestId",input_hash:"generationInputHash",generation_request_id:"generationRequestId",generation_input_hash:"generationInputHash",document_type:"documentType",source_quote_freee_id:"sourceQuoteFreeeId",source_quote_notion_id:"sourceQuoteNotionId",amount_excluding_tax:"amountExcludingTax",amount_tax:"amountTax",amount_including_tax:"amountIncludingTax",status:"status"},line:{description:"description",quantity:"quantity",unit_price:"unitPrice",unit:"unit",tax_rate:"taxRate",reduced_tax_rate:"reducedTaxRate",withholding:"withholding",amount_excluding_tax:"lineAmountExcludingTax",generation_request_id:"generationRequestId",generation_input_hash:"generationInputHash",copied_from_freee_line_id:"copiedFromFreeeLineId",line_request_key:"lineRequestKey"}},relations:{invoiceParent:"Invoice",sourceQuote:"Source Quote",sourceQuoteLine:"Source Quote Line"}}}};
  bootstrapExistingLedger(dbPath);await writeFile(configPath,JSON.stringify(config));const pages=new Map(),ledger=createGateLedger({dbPath,configPath});let writes=0,dropHeaderResponse=true,dropLineResponse=true;
  const encode=(values,relations={})=>({properties:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,typeof v==="number"?{type:"number",number:v}:typeof v==="boolean"?{type:"checkbox",checkbox:v}:{type:"rich_text",rich_text:v==null?[]:[{plain_text:String(v)}]}]).concat(Object.entries(relations).map(([k,v])=>[k,{type:"relation",relation:v.map(id=>({id})),has_more:false}])))});
  const notion={async queryDataSource(ds,{filter}={}){const results=[...pages.values()].filter(p=>p.parent.data_source_id===ds&&matches(p,filter));return{results,has_more:false};},async getPage(id){return structuredClone(pages.get(id));},async createPage({datasource,properties,relations,approvalProvider}){await approvalProvider.assertApproved({action:"create",datasource,properties,relations});writes++;const id=`page-${writes}`,p={id,archived:false,parent:{data_source_id:datasource},...encode(properties,relations)};pages.set(id,p);if(datasource===config.notion.invoiceDraft.dataSources.header&&dropHeaderResponse){dropHeaderResponse=false;throw Error("response_lost_after_header_commit");}if(datasource===config.notion.invoiceDraft.dataSources.line&&dropLineResponse){dropLineResponse=false;throw Error("response_lost_after_line_commit");}return{id};}};
  function value(page,name){const p=page.properties?.[name];if(!p)return undefined;if(p.type==="rich_text")return(p.rich_text||[]).map(x=>x.plain_text).join("");if(p.type==="relation")return(p.relation||[]).map(x=>x.id);return p[p.type];}
  function matches(page,filter){if(!filter)return true;if(filter.and)return filter.and.every(x=>matches(page,x));if(filter.relation)return value(page,filter.property).includes(filter.relation.contains);const cond=filter.rich_text||filter.title;return value(page,filter.property)===cond?.equals;}
  const approvalProvider=async preview=>({approved:true,origin:"host_interactive_approval",approval_id:`approval-${preview.request_id}-${writes}`,request_id:preview.request_id,operation:preview.operation,target:preview.target,payload_sha256:preview.payload_sha256,expires_at:new Date(Date.now()+60000).toISOString()});
  const runtime=createLedgerBackedInvoiceDraftRuntime({config,notion,ledger,approvalProvider,freeeGet:{async getDetail(){return{document_type:"quotation",freee_id:"7001",company_id:"100",amount_excluding_tax:"1450",amount_tax:"145",amount_including_tax:"1595",lines:[{line_id:"7101",description:"Part A",quantity:"1",unit_price:"1000",amount_excluding_tax:"1000",tax_rate:10,unit:"piece"},{line_id:"7102",description:"Part B",quantity:"1",unit_price:"450",amount_excluding_tax:"450",tax_rate:10,unit:"piece"}]};}}});
  const input={quote:{freee_id:"7001",company_id:"100",notion_id:"source-header",line_notion_ids:{"7101":"source-line-1","7102":"source-line-2"}}};
  try{await assert.rejects(()=>runtime.generate({requestId:"draft-sqlite-01",input}),/invoice_draft_header_create_unknown/);assert.equal(writes,1);
    await assert.rejects(()=>runtime.generate({requestId:"draft-sqlite-01",input}),/invoice_draft_line_create_unknown/);assert.equal(writes,2);
    const first=await runtime.generate({requestId:"draft-sqlite-01",input});assert.equal(first.status,"verified");assert.equal(writes,3);assert.equal(first.line_ids.length,2);const again=await runtime.generate({requestId:"draft-sqlite-01",input});assert.equal(again.status,"verified");assert.equal(writes,3);const state=await ledger.loadInvoiceDraftState("draft-sqlite-01");assert.equal(state.created_line_ids.length,2);const audit=await ledger.status();assert.equal(audit.lease,null);assert.equal(audit.ops.filter(x=>x[2]==="notion.page.create"&&x[5]==="succeeded").length,3);
  }finally{await rm(dir,{recursive:true,force:true});}
});
