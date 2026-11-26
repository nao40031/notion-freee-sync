import {createHash} from "node:crypto";

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const sha=v=>createHash("sha256").update(JSON.stringify(canonical(v)),"utf8").digest("hex");
const norm=v=>String(v??"").replaceAll("-","").toLowerCase();
function docKey(r){return `${r.company_id}|${r.document_type}|${r.document_number}`;}
function freeeType(t){if(t!=="quotation"&&t!=="invoice")throw Error("registration_document_type_invalid");return t;}
function freeeId(value,type){const id=value?.[type]?.id??value?.data?.[type]?.id??value?.id??value?.[`${type}_id`]??value?.data?.id;if(!/^\d+$/.test(String(id??"")))throw Error("registration_freee_id_missing");return String(id);}
function validateAuthorization(auth,request,payloadHash,registration,now){
  const issued=Date.parse(auth?.issued_at),expires=Date.parse(auth?.expires_at);
  if(auth?.approved!==true||auth?.origin!=="host_interactive_approval"||typeof auth?.approval_id!=="string"||!auth.approval_id||
    !Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<=now||expires<=issued||expires-issued>60*60*1000||
    auth.request_id!==request.request_id||auth.company_id!==Number(request.company_id)||auth.document_type!==request.document_type||
    auth.document_number!==request.document_number||auth.freee_payload_sha256!==payloadHash||
    auth.notion_header_id!==request.notion_header_id||JSON.stringify(auth.notion_line_ids)!==JSON.stringify(request.notion_line_ids||[])||
    auth.notion_header_datasource!==registration.header.datasource||JSON.stringify(auth.notion_line_datasources)!==JSON.stringify(registration.lines.map(x=>x.datasource))||
    JSON.stringify(auth.notion_header_properties)!==JSON.stringify(Object.keys(registration.header.properties).sort())||
    JSON.stringify(auth.notion_line_properties)!==JSON.stringify(registration.lines.map(x=>Object.keys(x.properties).sort())))throw Error("registration_approval_scope_invalid");
  return auth;
}
function approvalForOperation(auth,{request,method,target,payloadHash}){return {approved:true,approval_id:auth.approval_id,request_id:request.request_id,operation:method,target,payload_sha256:payloadHash,doc_key:docKey(request),expires_at:auth.expires_at};}
function externalEvidence({request,operationKey,method,target,payloadHash,auth}){return {request_id:request.request_id,operation_key:operationKey,method,target,payload_hash:payloadHash,approval_id:auth.approval_id,doc_key:docKey(request),approval_scope:approvalForOperation(auth,{request,method,target,payloadHash})};}
function pageMatches(page,patch){
  if(!page||norm(page.id)!==norm(patch.page_id)||page.archived===true||norm(page.parent?.data_source_id)!==norm(patch.datasource))return false;
  for(const [name,expected] of Object.entries(patch.properties)){
    const p=page.properties?.[name];if(!p)return false;const value=p[p.type];let actual;
    if(p.type==="title"||p.type==="rich_text")actual=(value||[]).map(x=>x.plain_text??x.text?.content??"").join("");
    else if(p.type==="select"||p.type==="status")actual=value?.name??null;
    else if(p.type==="relation"){if(p.has_more===true)return false;actual=(value||[]).map(x=>String(x.id));}
    else if(p.type==="date")actual=value?.start??null;
    else if(p.type==="number")actual=value??null;
    else if(p.type==="checkbox")actual=value??false;
    else return false;
    if(JSON.stringify(actual)!==JSON.stringify(expected))return false;
  }
  return true;
}
function verifyFreeeDocument({request,body,document,id}){
  const num=x=>Number(x),round=x=>Math.round(num(x)*100)/100;
  const numberKey=request.document_type==="quotation"?"quotation_number":"invoice_number";
  if(String(document?.id)!==id||String(document?.company_id)!==String(request.company_id)||String(document?.partner_id)!==String(request.partner_id)||
    String(document?.[numberKey])!==String(request.document_number)||!Array.isArray(document?.lines)||!Array.isArray(body.lines)||document.lines.length!==body.lines.length)return false;
  for(let i=0;i<body.lines.length;i++){
    const a=body.lines[i],b=document.lines[i];if(!/^\d+$/.test(String(b?.id??""))||String(a.description??"")!==String(b.description??"")||
      round(a.quantity)!==round(b.quantity)||round(a.unit_price)!==round(b.unit_price)||Number(a.tax_rate)!==Number(b.tax_rate)||
      (a.unit!=null&&String(a.unit)!==String(b.unit??"")))return false;
  }
  const netLines=document.lines.reduce((sum,x)=>sum+num(x.amount_excluding_tax),0);
  return Number.isFinite(netLines)&&round(netLines)===round(document.amount_excluding_tax)&&
    round(num(document.amount_excluding_tax)+num(document.amount_tax))===round(document.amount_including_tax);
}

/** One approved first registration, using the same lease/external_ops gate as
 * registered sync. This workflow never retries a possibly-sent freee POST. */
export async function runFirstRegistration({request,approvalProvider,preflight,freeePost,freeeGet,notion,ledger,verifyFreee=null,now=Date.now}={}){
  if(!request||typeof request!=="object"||!request.request_id||!/^\d+$/.test(String(request.company_id))||!/^\d+$/.test(String(request.partner_id))||
    !request.document_number||!request.notion_header_id||!Array.isArray(request.notion_line_ids)||!request.body||typeof approvalProvider!=="function"||
    typeof preflight!=="function"||typeof freeePost!=="function"||typeof freeeGet!=="function"||typeof notion?.getPage!=="function"||typeof notion?.updatePage!=="function"||
    typeof ledger?.acquire!=="function"||typeof ledger?.externalIntent!=="function"||typeof ledger?.externalFinish!=="function"||typeof ledger?.externalUnknown!=="function"||typeof ledger?.release!=="function")throw Error("registration_ports_or_request_invalid");
  const type=freeeType(request.document_type),path=`/${type==="quotation"?"quotations":"invoices"}`;
  if(Number(request.body.company_id)!==Number(request.company_id)||Number(request.body.partner_id)!==Number(request.partner_id)||
    String(request.body[type==="quotation"?"quotation_number":"invoice_number"]??"")!==String(request.document_number))throw Error("registration_body_identity_mismatch");
  const body=structuredClone(request.body),payloadHash=sha(body),registration=structuredClone(request.notion_registration||{});
  if(!registration.header?.datasource||!registration.header?.properties||!Array.isArray(registration.lines)||registration.lines.length!==request.notion_line_ids.length||
    !Object.hasOwn(registration.header.properties,request.notion_freee_id_property)||!Object.hasOwn(registration.header.properties,request.notion_document_number_property)||
    registration.lines.some((x,i)=>norm(x.page_id)!==norm(request.notion_line_ids[i])||!x.datasource||!x.properties||!Object.hasOwn(x.properties,request.notion_line_freee_id_property)||!Number.isInteger(x.line_index)||x.line_index<0)||
    new Set(registration.lines.map(x=>x.line_index)).size!==registration.lines.length)throw Error("registration_notion_plan_invalid");
  const freeeOp=`freee:${type}:create:${request.request_id}`,freeeTarget=`freee:${path}`,priorState=await ledger.status?.();
  const priorFreee=(priorState?.ops||[]).find(x=>x[0]===freeeOp);
  if(priorFreee&&(priorFreee[1]!==request.request_id||priorFreee[2]!==`freee.${type}.create`||priorFreee[3]!==freeeTarget||priorFreee[4]!==payloadHash||priorFreee[10]!==docKey(request)))throw Error("registration_existing_operation_conflict");
  if(priorFreee&&priorFreee[5]!=="succeeded")return {status:"unknown",reason:"registration_existing_operation_unresolved",automatic_retry:false,request_id:request.request_id};
  const resuming=Boolean(priorFreee);
  const first=resuming?{status:"resume",duplicate_check:"persisted_success_requires_readback"}:await preflight(structuredClone(request));
  if(!resuming&&(first?.status!=="clear"||first.duplicate_count!==0||first.notion_registered!==false))throw Error("registration_preflight_not_clear");
  const preview=Object.freeze({request_id:request.request_id,document_type:type,company_id:Number(request.company_id),partner_id:Number(request.partner_id),document_number:request.document_number,
    notion_header_id:request.notion_header_id,notion_line_ids:[...request.notion_line_ids],freee_payload_sha256:payloadHash,freee_path:path,preflight:structuredClone(first),
    notion_header_datasource:registration.header.datasource,notion_header_properties:Object.keys(registration.header.properties).sort(),
    notion_line_datasources:registration.lines.map(x=>x.datasource),notion_line_properties:registration.lines.map(x=>Object.keys(x.properties).sort()),effects:["one freee draft POST","update only the supplied existing Notion pages"]});
  const auth=validateAuthorization(await approvalProvider(preview),request,payloadHash,registration,now());if(Date.parse(auth.expires_at)<=now())throw Error("registration_approval_expired");
  const lease=await ledger.acquire(),freeeEvidence=externalEvidence({request,operationKey:freeeOp,method:`freee.${type}.create`,target:freeeTarget,payloadHash,auth});
  try{
    let id,verified;
    if(resuming){id=String(priorFreee[6]);verified=await freeeGet({documentType:type,companyId:String(request.company_id),documentId:id});}
    else {
      const latest=await preflight(structuredClone(request));if(JSON.stringify(canonical(latest))!==JSON.stringify(canonical(first)))throw Error("registration_preflight_changed_after_approval");
      await ledger.externalIntent({lease,evidence:freeeEvidence});let created;
      try{created=await freeePost({documentType:type,path,body:structuredClone(body)});}catch(error){await ledger.externalUnknown({lease,evidence:freeeEvidence}).catch(()=>{});return {status:"unknown",reason:"freee_post_result_unknown",automatic_retry:false,request_id:request.request_id};}
      try{id=freeeId(created,type);}catch{await ledger.externalUnknown({lease,evidence:freeeEvidence}).catch(()=>{});return {status:"unknown",reason:"freee_post_response_unverifiable",automatic_retry:false,request_id:request.request_id};}
      try{verified=await freeeGet({documentType:type,companyId:String(request.company_id),documentId:id});}
      catch{await ledger.externalUnknown({lease,evidence:freeeEvidence}).catch(()=>{});return {status:"unknown",reason:"freee_post_readback_failed",automatic_retry:false,request_id:request.request_id};}
    }
    const record=verified?.[type]??verified?.data?.[type]??verified?.data??verified;
    const valid=verifyFreee?await verifyFreee({request,body,document:record,id}):verifyFreeeDocument({request,body,document:record,id});
    if(!valid){await ledger.externalUnknown({lease,evidence:freeeEvidence}).catch(()=>{});return {status:"unknown",reason:"freee_post_readback_mismatch",automatic_retry:false,request_id:request.request_id};}
    if(!resuming)await ledger.externalFinish({lease,evidence:{...freeeEvidence,result_id:id}});
    const headerProperties={...registration.header.properties,[request.notion_freee_id_property]:id,[request.notion_document_number_property]:String(record?.[type==="quotation"?"quotation_number":"invoice_number"]??request.document_number)};
    const patches=[{page_id:request.notion_header_id,datasource:registration.header.datasource,properties:headerProperties},...registration.lines.map(line=>({page_id:line.page_id,datasource:line.datasource,properties:{...line.properties,[request.notion_line_freee_id_property]:String(record?.lines?.[line.line_index]?.id??"")}}))];
    let notionWriteCalls=0;for(const patch of patches){if(!Object.values(patch.properties).every(v=>v!==undefined&&v!==""))throw Error("registration_line_readback_id_missing");
      const hash=sha(patch.properties),op=`notion:registration:${request.request_id}:${norm(patch.page_id)}`,target=`${patch.datasource}:${patch.page_id}`;
      const evidence=externalEvidence({request,operationKey:op,method:"notion.page.update",target,payloadHash:hash,auth}),old=(await ledger.status()).ops.find(x=>x[0]===op);
      if(old){
        if(old[1]!==request.request_id||old[2]!=="notion.page.update"||old[3]!==target||old[4]!==hash)throw Error("registration_notion_operation_conflict");
        let observed=null;try{observed=await notion.getPage(patch.page_id);}catch{}
        if(pageMatches(observed,patch)){
          if(old[5]==="started")await ledger.externalUnknown({lease,evidence});
          if(old[5]==="started"||old[5]==="unknown")await ledger.externalReconcile({lease,evidence:{...evidence,result_id:patch.page_id,candidate_count:1,readback_verified:true,observed_payload_hash:hash}});
          continue;
        }
        if(old[5]==="succeeded")throw Error("registration_completed_page_readback_mismatch");
        if(old[5]==="started")await ledger.externalUnknown({lease,evidence});
        return {status:"partial_unknown",reason:"registration_page_operation_unresolved",freee_id:id,completed_pages:patches.indexOf(patch),automatic_retry:false};
      }
      await ledger.externalIntent({lease,evidence});
      try{notionWriteCalls++;await notion.updatePage({pageId:patch.page_id,datasource:patch.datasource,properties:patch.properties,approvalProvider:{assertApproved:async actual=>{
        if(actual.action!=="update"||norm(actual.page_id)!==norm(patch.page_id)||actual.datasource!==patch.datasource||JSON.stringify(canonical(actual.properties))!==JSON.stringify(canonical(patch.properties)))throw Error("registration_notion_operation_scope_mismatch");}}});
        const readback=await notion.getPage(patch.page_id);if(!pageMatches(readback,patch))throw Error("registration_notion_readback_mismatch");
        await ledger.externalFinish({lease,evidence:{...evidence,result_id:patch.page_id}});
      }catch(error){
        let readback=null;try{readback=await notion.getPage(patch.page_id);}catch{}
        if(pageMatches(readback,patch)){await ledger.externalFinish({lease,evidence:{...evidence,result_id:patch.page_id}});continue;}
        await ledger.externalUnknown({lease,evidence}).catch(()=>{});return {status:"partial_unknown",reason:"notion_registration_result_unknown",freee_id:id,completed_pages:patches.indexOf(patch),automatic_retry:false};}}
    return {status:"complete",request_id:request.request_id,freee_id:id,updated_pages:notionWriteCalls};
  }finally{await ledger.release(lease);}
}

/** A separate recovery entry only verifies by exact request identity and reads
 * back the persisted result. It deliberately has no freeePost dependency. */
export async function reconcileFirstRegistration({request,operationKey,ledger,findFreeeByNumber,verifyCandidate}={}){
  if(typeof findFreeeByNumber!=="function")throw Error("registration_recovery_ports_required");
  const state=await ledger.status(),row=(state.ops||[]).find(x=>x[0]===operationKey),type=freeeType(request?.document_type);
  if(!row||row[5]!=="unknown")throw Error("registration_recovery_requires_unknown");
  if(row[1]!==request.request_id||row[2]!==`freee.${type}.create`||row[4]!==sha(request.body)||row[10]!==docKey(request))throw Error("registration_recovery_request_mismatch");
  const candidates=await findFreeeByNumber({documentType:request.document_type,companyId:String(request.company_id),documentNumber:request.document_number});
  if(!Array.isArray(candidates)||candidates.length!==1) return {status:"unknown",candidate_count:Array.isArray(candidates)?candidates.length:null,automatic_retry:false};
  const candidate=candidates[0],document=candidate?.[type]??candidate?.data?.[type]??candidate?.data??candidate,id=String(document?.id??""),valid=/^\d+$/.test(id)&&verifyFreeeDocument({request,body:request.body,document,id})&&
    (typeof verifyCandidate!=="function"||await verifyCandidate(candidate));if(!valid)return {status:"unknown",candidate_count:1,automatic_retry:false};
  const lease=await ledger.acquire();try{
    const evidence={request_id:request.request_id,operation_key:operationKey,method:row[2],target:row[3],payload_hash:row[4],approval_id:row[9],doc_key:row[10],
      approval_scope:{approved:true,approval_id:row[9],request_id:request.request_id,operation:row[2],target:row[3],payload_sha256:row[4],doc_key:row[10],expires_at:new Date(Date.now()+60000).toISOString()},
      candidate_count:1,readback_verified:true,observed_payload_hash:row[4],result_id:String(candidate.id)};
    await ledger.externalReconcile({lease,evidence});return {status:"reconciled",freee_id:String(candidate.id),automatic_retry:false};
  }finally{await ledger.release(lease);}
}
