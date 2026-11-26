/**
 * Registered-document sync service for configured quotation and invoice flows:
 * pre-plan the bounded inventory, hold one SQLite lease, persist every
 * operation intent, invoke the scoped Notion transport, GET read-back, and
 * reconcile an uncertain response without replaying the mutation.
 *
 * All project identifiers and property names come from a local project config.
 */
import {createHash,randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createFormalApiPorts} from "./formal-api-ports.mjs";
import {createLocalSyncMonitor} from "./local-monitor.mjs";

const HERE=dirname(fileURLToPath(import.meta.url));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>createHash("sha256").update(JSON.stringify(canonical(value)),"utf8").digest("hex");
const norm=value=>String(value??"").replace(/^collection:\/\//,"").replaceAll("-","").toLowerCase();
const allowedTypes=new Set(["quotation","invoice"]);

function validateConfig(config){
  const companyId=String(config?.freee?.companyId??"");
  if(!/^\d+$/.test(companyId))throw Error("formal_sync_company_id_invalid");
  const policy=config.policy, types=policy?.documentTypes, sources=config.notion?.documentSources, props=config.notion?.propertyMap;
  if(policy?.direction!=="freee-to-notion"||!policy.policyId||!Array.isArray(types)||!types.length||types.some(t=>!allowedTypes.has(t))||!Array.isArray(policy.allowedActions)||policy.allowedActions.some(x=>!["update","create","archive"].includes(x)))throw Error("formal_sync_policy_config_invalid");
  if(policy.allowHeaderCreate!==false||policy.allowHardDelete!==false||!policy.allowedProperties||!Array.isArray(policy.allowedProperties.header)||!Array.isArray(policy.allowedProperties.line))throw Error("formal_sync_policy_config_invalid");
  if(!sources||!props)throw Error("formal_sync_mapping_required");
  const docs={};
  for(const type of types){const prefix=type==="quotation"?"quotation":"invoice",header=sources[prefix],lines=sources[prefix+"Line"],relation=sources[prefix+"Relation"];
    if(!header||!lines||!relation)throw Error("formal_sync_datasource_mapping_incomplete");
    docs[type]={header:`collection://${String(header).replace(/^collection:\/\//,"")}`,lines:`collection://${String(lines).replace(/^collection:\/\//,"")}`,relation};
  }
  const canonicalFields=["freeeId","companyId","documentNumber","documentType","inputState","status","syncState","sourceHash","syncedAt","title","branch","amountExcludingTax","amountTax","amountIncludingTax","lineFreeeId","lineTitle","quantity","unitPrice","taxRate","lineAmountExcludingTax","unit","lineNumber","lineParentRelation"];
  if(canonicalFields.some(k=>typeof props[k]!=="string"||!props[k]))throw Error("formal_sync_property_mapping_incomplete");
  const typesMap=config.notion.propertyTypes,allowedPropertyTypes=new Set(["title","rich_text","select","status","number","date","relation"]);
  if(!typesMap||canonicalFields.some(k=>!allowedPropertyTypes.has(typesMap[k]))||typesMap.syncedAt!=="date"||typesMap.lineParentRelation!=="relation")throw Error("formal_sync_property_type_mapping_incomplete");
  if(!Number.isInteger(policy.maxDocumentsPerRun)||policy.maxDocumentsPerRun<1||policy.maxDocumentsPerRun>100)throw Error("formal_sync_batch_limit_invalid");
  return Object.freeze({companyId,types:[...types],policy:Object.freeze({...policy}),sources:Object.freeze(docs),properties:Object.freeze({...props})});
}

function parseProperties(page,config,type=null){
  const out={};
  for(const [logical,name] of Object.entries(config.properties)){const p=page?.properties?.[name];if(!p?.type){out[logical]=null;continue;}const raw=p[p.type];
    if(p.type==="title"||p.type==="rich_text")out[logical]=(raw||[]).map(x=>x.plain_text??x.text?.content??"").join("");
    else if(p.type==="select"||p.type==="status")out[logical]=raw?.name??null;
    else if(p.type==="date")out[logical]=raw?.start??null;
    else if(p.type==="relation"){if(p.has_more)throw Error("formal_sync_relation_incomplete");out[logical]=(raw||[]).map(x=>x.id);}
    else out[logical]=raw??null;
  }
  if(type){const relName=config.sources[type].relation,rel=page?.properties?.[relName];if(!rel||rel.type!=="relation"||rel.has_more)throw Error("formal_sync_relation_incomplete");out.lineParentRelation=(rel.relation||[]).map(x=>x.id);}
  return out;
}
function plannerHeader(input,config){
  const output={};for(const [logical,name] of Object.entries(config.properties))if(Object.hasOwn(input,logical))output[name]=input[logical];
  return Object.fromEntries(Object.entries(output).map(([name,value])=>[Object.keys(config.properties).find(k=>config.properties[k]===name),value]));
}
function plannerLine(line,config){
  const out={page_id:line.id};const keys={freeeLineId:"freee明細ID",lineTitle:"明細名",quantity:"数量",unitPrice:"単価",taxRate:"税率",lineAmountExcludingTax:"税抜金額",unit:"単位",lineNumber:"行番号"};
  for(const [key,canonicalName] of Object.entries(keys))out[canonicalName]=line[config.properties[key]]??null;
  const relationName=config.properties.lineParentRelation;out[config.sources[line.document_type]?.relation||relationName]=line[relationName]??[];
  return out;
}
function mapPlannerProperties(properties,config){
  const aliases={"freee明細ID":"lineFreeeId","明細名":"lineTitle","数量":"quantity","単価":"unitPrice","税率":"taxRate","税抜金額":"lineAmountExcludingTax","単位":"unit","行番号":"lineNumber","枝番":"branch","税抜合計":"amountExcludingTax","税額":"amountTax","税込合計":"amountIncludingTax","件名":"title","帳票状態":"status","同期状態":"syncState","同期元ハッシュ":"sourceHash"};
  return Object.fromEntries(Object.entries(properties).map(([key,value])=>{
    if(key.startsWith("date:")&&key.includes(":start"))return [`date:${config.properties.syncedAt}:start`,value];
    const logical=aliases[key];return [logical?config.properties[logical]:key,value];
  }));
}
function pyPlan(plannerPath,input,python="python"){
  const code='import importlib.util,json,sys;p=sys.argv[1];s=importlib.util.spec_from_file_location("formal_planner",p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);x=json.load(sys.stdin);print(json.dumps(m.plan_registered_document_sync(x["expected"],x["header"],x["notion_lines"],x["freee"]),ensure_ascii=False,separators=(",",":")))';
  const p=spawnSync(python,["-X","utf8","-c",code,plannerPath],{input:JSON.stringify(input),encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:2*1024*1024});
  if(p.error||p.status!==0)throw Object.assign(Error("formal_sync_planner_failed"),{cause:String(p.stderr||p.error?.code||p.status)});
  return JSON.parse(p.stdout);
}

function createGateLedger({dbPath,configPath,gatePath=resolve(HERE,"formal-sqlite-gate.py"),python="python"}={}){
  const run=(action,args=[])=>{const p=spawnSync(python,["-X","utf8",gatePath,action,"--db",dbPath,"--config",configPath,...args],{encoding:"utf8",windowsHide:true,timeout:30000});let r;try{r=JSON.parse(p.stdout||"");}catch{throw Error("formal_sqlite_gate_invalid_response");}if(p.status!==0||r.ok===false)throw Error(`formal_sqlite_gate:${r.error||p.status}`);return r;};
  const interactive=(action,lease)=>{if(!lease)throw Error("formal_sync_policy_lease_required");const p=spawnSync(python,["-X","utf8",gatePath,action,"--db",dbPath,"--config",configPath,"--token",lease],{stdio:"inherit",windowsHide:false,timeout:300000});if(p.error||p.status!==0)throw Error("formal_sync_policy_operator_rejected");return run("policy-status").policy;};
  const currentPolicy=()=>{const policy=run("policy-status").policy;return policy?.status==="active"?{active:policy}:{active:null};};
  const enc=e=>Buffer.from(JSON.stringify(e),"utf8").toString("base64url");
  const external=(action,lease,evidence)=>{if(!lease||!evidence)throw Error("external_operation_gate_evidence_required");run(`external-${action}`,["--token",lease,"--evidence-b64",enc(evidence)]);};
  return Object.freeze({
    async acquire(){return run("acquire",["--owner-pid",String(process.pid)]).token;},
    async release(token){run("release",["--token",token]);},
    async status(){return run("status");},
    async recoveryItems(){return run("recovery-items").items;},
    async continuousSyncPolicy(){return currentPolicy();},
    async approveContinuousSyncPolicy({lease}={}){interactive("policy-approve",lease);return currentPolicy();},
    async revokeContinuousSyncPolicy({lease}={}){interactive("policy-revoke",lease);return currentPolicy();},
    async phase8Intent({lease,evidence}){run("phase8-intent",["--token",lease,"--evidence-b64",enc(evidence)]);},
    async phase8Finish({lease,evidence}){run("phase8-finish",["--token",lease,"--evidence-b64",enc(evidence)]);},
    async phase8Unknown({lease,evidence}){run("phase8-unknown",["--token",lease,"--evidence-b64",enc(evidence)]);},
    async phase8Reconcile({lease,evidence}){run("phase8-reconcile",["--token",lease,"--evidence-b64",enc(evidence)]);},
    async externalIntent({lease,evidence}){external("intent",lease,evidence);},
    async externalFinish({lease,evidence}){external("finish",lease,evidence);},
    async externalUnknown({lease,evidence}){external("unknown",lease,evidence);},
    async externalReconcile({lease,evidence}){external("reconcile",lease,evidence);},
    async loadInvoiceDraftState(requestId){return run("draft-state-get",["--request-id",String(requestId)]).record;},
    async saveInvoiceDraftState({lease,requestId,record}){if(!lease||record?.request_id!==requestId)throw Error("draft_state_lease_and_identity_required");run("draft-state-put",["--token",lease,"--request-id",String(requestId),"--record-b64",enc(record)]);},
  });
}

function makeScope(document,plan,requestId,config){
  const pageIds=[document.header_page_id,...document.line_page_ids].map(String);
  const byDs={};for(const op of plan.operations){const ds=op.target;byDs[ds]??=[];for(const key of Object.keys(op.properties||{}))if(!byDs[ds].includes(key))byDs[ds].push(key);}
  const identity={registered:true,document_type:document.document_type,company_id:Number(document.company_id),freee_id:String(document.freee_id),document_number:String(document.document_number),header_page_id:String(document.header_page_id),document_page_ids:pageIds};
  return {approval_id:config.policy.policyId,origin:"continuous_sync_policy",generation_request_id:requestId,plan_hash:hash(plan),page_ids:pageIds,property_allowlist_by_datasource:byDs,registered_identity:identity};
}
function expectedPolicyScope(config){return {company_id:Number(config.companyId),document_types:[...config.types],
  header_datasources:config.types.map(type=>config.sources[type].header),line_datasources:config.types.map(type=>config.sources[type].lines),
  actions:[...config.policy.allowedActions],header_properties:config.policy.allowedProperties.header,line_properties:config.policy.allowedProperties.line,max_documents:config.policy.maxDocumentsPerRun};}
function binder(plan){const used=new Set();return Object.freeze({async assertApproved(actual){const match=(op,index)=>({unused:!used.has(index),action:({update_header:"update",archive_candidate:"archive"}[op.action]||op.action)===actual.action,datasource:String(op.target)===String(actual.datasource),page:op.action==="create"||norm(op.page_id)===norm(actual.page_id),properties:JSON.stringify(canonical(op.properties||{}))===JSON.stringify(canonical(actual.properties||{})),relations:JSON.stringify(canonical(op.relations||{}))===JSON.stringify(canonical(actual.relations||{}))});const i=plan.operations.findIndex((op,index)=>Object.values(match(op,index)).every(Boolean));if(i<0)throw Error("formal_sync_transport_operation_mismatch");used.add(i);}});}

function propertyMatch(expected,observed,config){const inverse=Object.fromEntries(Object.entries(config.properties).map(([logical,name])=>[name,logical]));for(const [key,value] of Object.entries(expected||{})){const date=/^date:(.+):start$/.exec(key),name=date?date[1]:key,logical=inverse[name],actual=logical?observed?.[logical]:observed?.[name];if(date&&value==="<set-at-apply-time>"){if(typeof actual!=="string"||!Number.isFinite(Date.parse(actual)))return false;}else if(JSON.stringify(actual)!==JSON.stringify(value))return false;}return true;}

// Use a stable per-run identity so new runs cannot impersonate prior operations.
export function runScopedSyncRequestId({runId,documentType,freeeId}={}){
  if(!runId||!allowedTypes.has(documentType)||!/^\d+$/.test(String(freeeId??"")))throw Error("formal_sync_request_identity_invalid");
  return `continuous:${runId}:${documentType}:${freeeId}`;
}

/** Inject real or fake API ports; both use this exact runner/writer/ledger path. */
export function createFormalRegisteredSync({config,configPath,plannerPath=resolve(HERE,"phase8_sync_planner.py"),dbPath,notion,freee,emit=async()=>{},python="python"}={}){
  const cfg=validateConfig(config);if(!configPath||!dbPath||typeof notion?.listRegisteredDocuments!=="function"||typeof notion?.getPage!=="function"||typeof notion?.updatePage!=="function"||typeof notion?.createPage!=="function"||typeof notion?.archivePage!=="function"||typeof freee?.getDocument!=="function")throw Error("formal_sync_ports_required");
  const ledger=createGateLedger({dbPath,configPath,python});
  async function prepare(doc){
    if(doc.registered!==true||Number(doc.company_id)!==Number(cfg.companyId)||!cfg.types.includes(doc.document_type)||!/^[0-9]+$/.test(String(doc.freee_id))||!doc.header_page_id||!Array.isArray(doc.line_page_ids)||!doc.line_page_ids.length)throw Error("formal_sync_document_out_of_scope");
    const spec=cfg.sources[doc.document_type],page=await notion.getPage(doc.header_page_id);if(norm(page?.id)!==norm(doc.header_page_id)||page.archived||norm(page.parent?.data_source_id)!==norm(spec.header))throw Error("formal_sync_header_identity_mismatch");
    const headerProps=parseProperties(page,cfg),canonicalHeader={};for(const [logical] of Object.entries(cfg.properties))canonicalHeader[({freeeId:"freee帳票ID",companyId:"freee事業所ID",documentNumber:"freee正式番号",documentType:"帳票種別",inputState:"入力状態",status:"帳票状態",syncState:"同期状態",sourceHash:"同期元ハッシュ",syncedAt:"同期日時",title:"件名",branch:"枝番",amountExcludingTax:"税抜合計",amountTax:"税額",amountIncludingTax:"税込合計"}[logical]||logical)]=headerProps[logical];
    if(canonicalHeader["同期状態"]===cfg.policy.syncedStateValue)canonicalHeader["同期状態"]="同期済";
    if(String(headerProps.freeeId)!==String(doc.freee_id)||String(headerProps.companyId)!==String(doc.company_id)||String(headerProps.documentNumber)!==String(doc.document_number)||headerProps.inputState!==cfg.policy.registeredStateValue)throw Error("formal_sync_registered_header_mismatch");
    const linePages=[];for(const id of doc.line_page_ids){const p=await notion.getPage(id);if(norm(p?.id)!==norm(id)||p.archived||norm(p.parent?.data_source_id)!==norm(spec.lines))throw Error("formal_sync_line_identity_mismatch");linePages.push(p);}
    const canonicalRelation=doc.document_type==="invoice"?"請求書":"見積書";
    const plannerLines=linePages.map(p=>{const x=parseProperties(p,cfg,doc.document_type);return {page_id:p.id,freee明細ID:x.lineFreeeId,明細名:x.lineTitle,数量:x.quantity,単価:x.unitPrice,税率:x.taxRate,税抜金額:x.lineAmountExcludingTax,単位:x.unit,行番号:x.lineNumber,[canonicalRelation]:x.lineParentRelation};});
    for(const line of plannerLines)if(!Array.isArray(line[canonicalRelation])||line[canonicalRelation].length!==1||norm(line[canonicalRelation][0])!==norm(doc.header_page_id))throw Error("formal_sync_line_relation_mismatch");
    const raw=await freee.getDocument({documentType:doc.document_type,companyId:doc.company_id,documentId:doc.freee_id});
    const number=doc.document_type==="quotation"?raw?.quotation_number:raw?.invoice_number;
    if(String(raw?.id)!==String(doc.freee_id)||String(raw?.company_id)!==String(doc.company_id)||String(number)!==String(doc.document_number)||!Array.isArray(raw?.lines))throw Error("formal_sync_freee_identity_mismatch");
    const normalized={id:String(raw.id),company_id:String(raw.company_id),document_number:String(number),branch_no:raw.branch_no,title:String(raw.subject??raw.title??""),status:String(raw.status??""),amount_excluding_tax:raw.amount_excluding_tax,amount_tax:raw.amount_tax,amount_including_tax:raw.amount_including_tax,lines:raw.lines.map(l=>({id:String(l.id),description:String(l.description??""),quantity:l.quantity,unit_price:l.unit_price,tax_rate:l.tax_rate,amount_excluding_tax:l.amount_excluding_tax,unit:l.unit??""}))};
    const expected={notion_id:doc.header_page_id,document_type:doc.document_type,freee_id:String(doc.freee_id),company_id:String(doc.company_id),document_number:String(doc.document_number)};
    const planned=pyPlan(plannerPath,{expected,header:canonicalHeader,notion_lines:plannerLines,freee:normalized},python);
    const operations=planned.operations.map(op=>({...op,target:op.action==="update_header"?spec.header:spec.lines,
      ...(op.relations?{relations:{[spec.relation]:op.relations[canonicalRelation]}}:{}),
      properties:mapPlannerProperties(Object.fromEntries(Object.entries(op.properties||{}).map(([k,v])=>[k,k==="同期状態"&&v==="同期済"?cfg.policy.syncedStateValue:v])),cfg)}));
    return {doc,header:page,lines:linePages,raw,planned,plan:{...planned,operations}};
  }
  async function applyPrepared(prepared,lease,runId){
    const {doc,plan,planned}=prepared;if(plan.no_op)return {status:"unchanged",write_count:0,source_hash:planned.source_hash};
    let writesApplied=0;
    const requestId=runScopedSyncRequestId({runId,documentType:doc.document_type,freeeId:doc.freee_id}),scope=makeScope(doc,plan,requestId,cfg),approvalProvider=binder(plan);
    const evidenceBase={approval_id:scope.approval_id,approval_mode:"standing-continuous-policy",registered_identity:scope.registered_identity,registered_identity_hash:hash(scope.registered_identity),request_id:requestId,plan_hash:hash(plan),page_allowlist:scope.page_ids};
    for(let index=0;index<plan.operations.length;index++){
      const op=plan.operations[index],action=({update_header:"update",archive_candidate:"archive"}[op.action]||op.action),datasource=op.target,pageId=op.page_id||"",properties=op.properties||{},opHash=hash(op),operationKey=`phase8:${requestId}:${index}:${opHash}`;
      if(!["update","create","archive"].includes(action))throw Error("formal_sync_action_rejected");
      const isHeader=datasource===cfg.sources[doc.document_type].header,isLine=datasource===cfg.sources[doc.document_type].lines;if(!isHeader&&!isLine)throw Error("formal_sync_datasource_out_of_scope");
      if(Object.keys(properties).some(k=>!(cfg.policy.allowedProperties[isHeader?"header":"line"]||[]).includes(k))||(action==="create"&&!cfg.policy.allowedProperties.line.includes(cfg.sources[doc.document_type].relation)))throw Error("formal_sync_property_out_of_scope");
      if(action!=="create"&&!scope.page_ids.some(x=>norm(x)===norm(pageId)))throw Error("formal_sync_page_out_of_scope");
      if(!cfg.policy.allowedActions.includes(action)||(action==="archive"&&!cfg.policy.allowArchiveRemovedLines)||(action==="create"&&!cfg.policy.allowLineCreate))throw Error("formal_sync_policy_action_rejected");
      const evidence={...evidenceBase,operation_key:operationKey,operation_index:index,action,method:`notion.${action}`,datasource,page_id:pageId,properties,property_allowlist:cfg.policy.allowedProperties[isHeader?"header":"line"],operation_hash:opHash,operation:op,plan,source_line_id:String(op.source_line_id||"")};
      const state=await ledger.status(),prior=(state.ops||[]).find(x=>x[0]===operationKey);
      if(!prior){const unresolved=(state.ops||[]).find(x=>String(x[3])===String(datasource)&&["started","unknown"].includes(x[5])&&String(x[0]).startsWith("phase8:"));if(unresolved)throw Object.assign(Error("formal_sync_datasource_unresolved_operation"),{unknown:true});}
      if(prior){
        if(prior[5]==="succeeded") {const observed=action==="create"?await notion.getPage(prior[6]):await notion.getPage(pageId);if(observed&&propertyMatch(properties,parseProperties(observed,cfg,isLine?doc.document_type:null),cfg))continue;throw Object.assign(Error("formal_sync_completed_readback_mismatch"),{unknown:true});}
        const observed=action==="create"?await notion.findCreateOutcome?.({requestId,sourceLineId:op.source_line_id,parentId:doc.header_page_id}):await notion.getPage(pageId);
        if(prior[5]==="unknown"||prior[5]==="started"){
          if(action==="create"&&(!Array.isArray(observed)||observed.length!==1))throw Object.assign(Error("formal_sync_unknown_no_replay"),{unknown:true});
          const page=action==="create"?observed[0]:observed;if(page&&propertyMatch(properties,parseProperties(page,cfg,isLine?doc.document_type:null),cfg)){await ledger.phase8Reconcile({lease,evidence:{...evidence,result_id:page.id,candidate_count:1,readback_verified:true,observed_operation_hash:opHash}});continue;}
          throw Object.assign(Error("formal_sync_unknown_no_replay"),{unknown:true});
        }
        throw Error("formal_sync_duplicate_operation_rejected");
      }
      await ledger.phase8Intent({lease,evidence});
      try{
        let result;if(action==="update")result=await notion.updatePage({pageId,datasource,properties,approvalProvider});else if(action==="create")result=await notion.createPage({datasource,properties,relations:op.relations,requestId,sourceLineId:op.source_line_id,approvalProvider});else result=await notion.archivePage({pageId,datasource,approvalProvider});
        const readback=action==="create"?await notion.getPage(result?.id):await notion.getPage(pageId);
        if(!readback||!(action==="archive"?readback.archived===true:propertyMatch(properties,parseProperties(readback,cfg,isLine?doc.document_type:null),cfg))||isLine&&norm(parseProperties(readback,cfg,doc.document_type).lineParentRelation?.[0])!==norm(doc.header_page_id))throw Error("formal_sync_readback_mismatch");
        await ledger.phase8Finish({lease,evidence:{...evidence,result_id:readback.id||result?.id}});writesApplied++;
      }catch(error){
        await ledger.phase8Unknown({lease,evidence}).catch(()=>{});
          try{const observed=action==="create"?await notion.findCreateOutcome?.({requestId,sourceLineId:op.source_line_id,parentId:doc.header_page_id,documentType:doc.document_type}):await notion.getPage(pageId);
          const page=action==="create"&&Array.isArray(observed)&&observed.length===1?observed[0]:action!=="create"?observed:null;
          if(page&&propertyMatch(properties,parseProperties(page,cfg,isLine?doc.document_type:null),cfg)){await ledger.phase8Reconcile({lease,evidence:{...evidence,result_id:page.id,candidate_count:1,readback_verified:true,observed_operation_hash:opHash}});continue;}
        }catch{}
        throw Object.assign(Error("formal_sync_unknown_outcome"),{unknown:true,cause:error?.message});
      }
    }
    return {status:writesApplied?"synced":"unchanged",write_count:writesApplied,source_hash:planned.source_hash};
  }
  async function recoverUnknown(){
    const lease=await ledger.acquire();try{const items=await ledger.recoveryItems(),recovered=[],unresolved=[];
      for(const e of items){const op=e.operation,action=e.action;let candidate=null;
        if(action==="create"){const found=await notion.findCreateOutcome?.({requestId:e.request_id,sourceLineId:e.source_line_id,parentId:e.registered_identity.header_page_id,documentType:e.registered_identity.document_type});if(Array.isArray(found)&&found.length===1)candidate=found[0];}
        else candidate=await notion.getPage(e.page_id);
        const datasource=e.datasource,spec=cfg.sources[e.registered_identity.document_type],line=datasource===spec.lines;
        const matches=Boolean(candidate)&&(action==="archive"?candidate.archived===true:propertyMatch(e.properties,parseProperties(candidate,cfg,line?e.registered_identity.document_type:null),cfg))&&(!line||norm(parseProperties(candidate,cfg,e.registered_identity.document_type).lineParentRelation?.[0])===norm(e.registered_identity.header_page_id));
        if(matches){if(e.action){const status=(await ledger.status()).ops.find(x=>x[0]===e.operation_key)?.[5];if(status==="started")await ledger.phase8Unknown({lease,evidence:e});}
          await ledger.phase8Reconcile({lease,evidence:{...e,result_id:candidate.id,candidate_count:1,readback_verified:true,observed_operation_hash:e.operation_hash}});recovered.push(e.operation_key);}
        else unresolved.push({operation_key:e.operation_key,status:"unknown_no_unique_matching_readback"});
      }
      return {recovered,unresolved,status:unresolved.length?"unknown":"complete"};
    }finally{await ledger.release(lease);}}
  return Object.freeze({ledger,recoverUnknown,async run({runId=`sync-${randomUUID()}`}={}){
    const policy=await ledger.continuousSyncPolicy();if(policy?.active?.policy_id!==cfg.policy.policyId||policy?.active?.status!=="active")throw Error("formal_sync_policy_not_active");
    if(JSON.stringify(canonical(policy.active.scope))!==JSON.stringify(canonical(expectedPolicyScope(cfg))))throw Error("formal_sync_policy_scope_mismatch");
    const lease=await ledger.acquire();try{
      const docs=await notion.listRegisteredDocuments({companyId:cfg.companyId,documentTypes:cfg.types,limit:cfg.policy.maxDocumentsPerRun,config:cfg});
      if(!Array.isArray(docs)||docs.length>cfg.policy.maxDocumentsPerRun)throw Error("formal_sync_inventory_invalid");
      const unique=new Set();for(const d of docs){if(d.registered!==true||String(d.company_id)!==cfg.companyId||!cfg.types.includes(d.document_type))throw Error("formal_sync_unregistered_document_rejected");const key=`${d.company_id}:${d.document_type}:${d.freee_id}`;if(unique.has(key))throw Error("formal_sync_duplicate_identity");unique.add(key);}
      // Freeze one fully-read plan set before the first mutation. Any GET or
      // mapping error aborts this batch without a partial write.
      const prepared=[];for(const doc of docs)prepared.push(await prepare(doc));
      const results=[];await emit({event:"sync_batch_started",run_id:runId,count:prepared.length});
      for(const item of prepared){try{const result=await applyPrepared(item,lease,runId);results.push({document_type:item.doc.document_type,freee_id:item.doc.freee_id,...result});await emit({event:result.status==="unchanged"?"sync_no_change":"sync_succeeded",run_id:runId,...results.at(-1)});}
        catch(error){const unknown=error?.unknown===true;results.push({document_type:item.doc.document_type,freee_id:item.doc.freee_id,status:unknown?"unknown":"failed",reason:String(error?.cause||error?.message||"sync_failed")});await emit({event:unknown?"sync_unknown":"sync_failed",run_id:runId,...results.at(-1)});if(unknown)break;}}
      const counts={discovered:prepared.length,processed:results.length,synced:results.filter(x=>x.status==="synced").length,unchanged:results.filter(x=>x.status==="unchanged").length,failed:results.filter(x=>x.status==="failed").length,unknown:results.filter(x=>x.status==="unknown").length};
      await emit({event:"sync_batch_finished",run_id:runId,counts});return Object.freeze({run_id:runId,status:counts.unknown?"unknown":counts.failed?"partial":"complete",counts,results});
    }finally{await ledger.release(lease);}
  }});
}

/** Production composition root: config + credential providers + API transports
 *  are connected to the same registered-document runner and SQLite gate used
 *  by the isolated end-to-end suite. No credentials are read from the repo.
 */
export function createFormalSyncService({config,configPath,dbPath,notionTokenProvider,freeeTokenProvider,notionFetch=globalThis.fetch,freeeFetch=globalThis.fetch,notionBaseUrl,freeeBaseUrl,emit=null,monitorPath=null,emailNotify=null,python="python"}={}){
  const ports=createFormalApiPorts({config,notionTokenProvider,freeeTokenProvider,notionFetch,freeeFetch,notionBaseUrl,freeeBaseUrl});
  const monitor=emit?null:createLocalSyncMonitor({...(monitorPath?{path:monitorPath}:{}),emailNotify});
  const eventSink=emit||((event)=>monitor.emit(event));
  const runner=createFormalRegisteredSync({config,configPath,dbPath,notion:ports.notion,freee:ports.freee,emit:eventSink,python});
  return Object.freeze({...runner,ports});
}

export {validateConfig,createGateLedger};
