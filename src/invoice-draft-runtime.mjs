import {createHash} from "node:crypto";
import {generateInvoiceDraft} from "./invoice-draft.mjs";

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const sha=v=>createHash("sha256").update(JSON.stringify(canonical(v)),"utf8").digest("hex");
const norm=v=>String(v??"").replaceAll("-","").toLowerCase();
const rich=v=>v?.type==="title"||v?.type==="rich_text"?(v[v.type]||[]).map(x=>x.plain_text??x.text?.content??"").join(""):v?.type==="relation"?(v.has_more?(()=>{throw Error("invoice_draft_relation_incomplete")})():(v.relation||[]).map(x=>String(x.id))):v?.type==="select"||v?.type==="status"?v[v.type]?.name??null:v?.[v?.type]??null;

function mappings(config){const d=config?.notion?.invoiceDraft;if(!d||!d.dataSources?.header||!d.dataSources?.line||!d.propertyMap?.header||!d.propertyMap?.line||!d.relations?.invoiceParent||!d.relations?.sourceQuote||!d.relations?.sourceQuoteLine)throw Error("invoice_draft_mapping_invalid");return d;}
function toNotion(values,kind,config,draft){const map=draft.propertyMap[kind],out={};for(const [key,value] of Object.entries(values)){if(key==="source_line_id"||key==="source_quote_notion_id"||key==="copied_from_quote_relation"||key==="copied_from_quote_line_relation"||key==="source_quote_line_id")continue;const logical=map[key];if(!logical||!config.notion.propertyMap[logical])throw Error("invoice_draft_property_mapping_missing");out[config.notion.propertyMap[logical]]=value;}return out;}
function fromNotion(page,kind,config,draft){const inverse=Object.fromEntries(Object.entries(config.notion.propertyMap).map(([logical,name])=>[name,logical])),reverse=Object.fromEntries(Object.entries(draft.propertyMap[kind]).map(([draftName,logical])=>[logical,draftName]));const out={id:page.id};for(const [name,p] of Object.entries(page.properties||{})){const logical=inverse[name],key=reverse[logical];if(key)out[key]=rich(p);}return out;}
function mappedPageMismatch(page,target,properties,relations={}){if(!page||page.archived===true||norm(page.parent?.data_source_id)!==norm(target))return"identity";for(const [name,value] of Object.entries(properties)){if(JSON.stringify(rich(page.properties?.[name]))!==JSON.stringify(value))return`property:${name}`;}for(const [name,ids] of Object.entries(relations)){const actual=rich(page.properties?.[name]);if(!Array.isArray(actual)||actual.length!==ids.length||actual.some((x,i)=>norm(x)!==norm(ids[i])))return`relation:${name}`;}return null;}
const mappedPageMatches=(page,target,properties,relations={})=>mappedPageMismatch(page,target,properties,relations)===null;
function filterText(property,value){return{property,...(typeof value==="string"?{rich_text:{equals:value}}:{title:{equals:String(value)}})};}
function safeAuth(auth,{requestId,operation,target,payloadHash}){if(auth?.approved!==true||auth?.origin!=="host_interactive_approval"||!auth.approval_id||auth.request_id!==requestId||auth.operation!==operation||auth.target!==target||auth.payload_sha256!==payloadHash||!Number.isFinite(Date.parse(auth.expires_at))||Date.parse(auth.expires_at)<=Date.now())throw Error("invoice_draft_approval_scope_invalid");return auth;}

/** Quote-to-invoice generation adapter over the same Notion writer, lease and
 * external_ops SQLite gate used by the registered-document sync runtime. */
export function createLedgerBackedInvoiceDraftRuntime({config,notion,freeeGet,ledger,approvalProvider}={}){
  const draft=mappings(config);if(!notion||!ledger||typeof approvalProvider!=="function"||!freeeGet)throw Error("invoice_draft_runtime_ports_required");
  const propertyMap=config.notion.propertyMap,headerRequestProp=propertyMap[draft.propertyMap.header.generation_request_id],lineRequestProp=propertyMap[draft.propertyMap.line.generation_request_id],lineKeyProp=propertyMap[draft.propertyMap.line.line_request_key];
  if(!headerRequestProp||!lineRequestProp||!lineKeyProp)throw Error("invoice_draft_idempotency_properties_required");
  const query=async(ds,filter)=>{const result=await notion.queryDataSource(ds,{page_size:100,filter});if(!Array.isArray(result?.results)||result.has_more===true)throw Error("invoice_draft_query_incomplete");return result.results;};
  async function recordApproval({requestId,operation,target,properties,relations}){
    const payloadHash=sha({target,properties,relations:relations||{}}),auth=safeAuth(await approvalProvider({request_id:requestId,operation,target,properties,relations:relations||{},payload_sha256:payloadHash}),{requestId,operation,target,payloadHash});
    return {auth,payloadHash};
  }
  return Object.freeze({async generate({requestId,input,rounding="half-up"}={}){
    const lease=await ledger.acquire();
    const doc={request_id:requestId,company_id:String(config.freee.companyId),document_type:"invoice",document_number:`draft:${requestId}`};
    const writer={
      async findByRequest(id){const state=await ledger.loadInvoiceDraftState(id);if(state?.header_id)return state;if(state&&state.header_id==null)return null;const rows=await query(draft.dataSources.header,filterText(headerRequestProp,id));if(rows.length>0)throw Error(rows.length===1?"invoice_draft_header_state_missing_manual_recovery":"invoice_draft_duplicate_request_headers");return null;},
      async createHeader(spec){const properties=toNotion({...spec,generation_request_id:spec.generation_request_id,generation_input_hash:spec.generation_input_hash},"header",config,draft),target=draft.dataSources.header,op=`invoice-draft:${requestId}:header`,operation="notion.page.create",{auth,payloadHash}=await recordApproval({requestId,operation,target,properties,relations:{}}),docKey=`${doc.company_id}|invoice|draft:${requestId}`,evidence={request_id:requestId,operation_key:op,method:operation,target,payload_hash:payloadHash,approval_id:auth.approval_id,doc_key:docKey,approval_scope:{approved:true,approval_id:auth.approval_id,request_id:requestId,operation,target,payload_sha256:payloadHash,doc_key:docKey,expires_at:auth.expires_at}};
        // Persist enough expected identity before CREATE so a restart can safely
        // reconcile one matching page without replaying an uncertain request.
        const priorState=await ledger.loadInvoiceDraftState(requestId);if(priorState&&priorState.input_hash!==spec.generation_input_hash)throw Error("invoice_draft_request_payload_conflict");
        if(!priorState)await ledger.saveInvoiceDraftState({lease,requestId,record:{request_id:requestId,input_hash:spec.generation_input_hash,header_id:null,header_properties:properties,planned_lines:null,created_line_ids:[]}});
        const old=(await ledger.status()).ops.find(x=>x[0]===op);
        if(old){
          if(old[1]!==requestId||old[2]!==operation||old[3]!==target||old[4]!==payloadHash)throw Error("invoice_draft_header_operation_conflict");
          const rows=await query(target,filterText(headerRequestProp,requestId));if(rows.length!==1)throw Error("invoice_draft_header_create_unknown_manual_recovery");
          const page=rows[0],mismatch=mappedPageMismatch(page,target,properties);if(mismatch)throw Error(`invoice_draft_header_recovery_mismatch:${mismatch}`);
          if(old[5]==="started")await ledger.externalUnknown({lease,evidence});
          if(old[5]==="started"||old[5]==="unknown")await ledger.externalReconcile({lease,evidence:{...evidence,result_id:page.id,candidate_count:1,readback_verified:true,observed_payload_hash:payloadHash}});
          if(!["started","unknown","succeeded"].includes(old[5]))throw Error("invoice_draft_header_operation_state_invalid");
          return{id:page.id};
        }
        await ledger.externalIntent({lease,evidence});
        try{const created=await notion.createPage({datasource:target,properties,relations:{},approvalProvider:{assertApproved:async actual=>{if(actual.action!=="create"||actual.datasource!==target||JSON.stringify(canonical(actual.properties))!==JSON.stringify(canonical(properties)))throw Error("invoice_draft_header_operation_mismatch");}}});
          const page=await notion.getPage(created.id);if(norm(page?.id)!==norm(created.id)||!mappedPageMatches(page,target,properties))throw Error("invoice_draft_header_readback_mismatch");await ledger.externalFinish({lease,evidence:{...evidence,result_id:created.id}});return{id:created.id};
        }catch(error){await ledger.externalUnknown({lease,evidence}).catch(()=>{});throw Error("invoice_draft_header_create_unknown");}},
      async saveRequest(record){await ledger.saveInvoiceDraftState({lease,requestId,record});},
      async getPlannedLines(id){return (await ledger.loadInvoiceDraftState(id))?.planned_lines||null;},
      async findLineByRequest(id,stable){const pages=await query(draft.dataSources.line,{and:[filterText(lineRequestProp,id),filterText(lineKeyProp,stable)]});if(pages.length>1)throw Error("invoice_draft_duplicate_line_key");
        if(pages.length===1){
          const page=pages[0],op=`invoice-draft:${requestId}:line:${stable}`,old=(await ledger.status()).ops.find(x=>x[0]===op);
          if(old&&["started","unknown"].includes(old[5])){
            const match=/:L(\d+)$/.exec(stable),record=await ledger.loadInvoiceDraftState(id),index=match?Number(match[1])-1:-1,line=record?.planned_lines?.[index];
            if(!record||!line||page.archived||norm(page.parent?.data_source_id)!==norm(draft.dataSources.line))throw Error("invoice_draft_unknown_line_unresolved");
            const sourceLineId=line.source_line_id??null,sourceLineNotionId=record.source_line_notion_ids?.[sourceLineId]??null,quoteRelation=record.source_quote_notion_id?[record.source_quote_notion_id]:[];
            const expectedValues={...line,generation_request_id:requestId,generation_input_hash:record.input_hash,copied_from_freee_line_id:line.source_line_id,source_quote_notion_id:record.source_quote_notion_id,source_quote_line_id:sourceLineId,copied_from_quote_relation:quoteRelation,copied_from_quote_line_relation:sourceLineNotionId?[sourceLineNotionId]:[]};
            const expectedProperties=toNotion({...expectedValues,line_request_key:stable},"line",config,draft),expectedRelations={[draft.relations.invoiceParent]:[record.header_id]};
            if(quoteRelation.length)expectedRelations[draft.relations.sourceQuote]=quoteRelation;if(sourceLineNotionId)expectedRelations[draft.relations.sourceQuoteLine]=[sourceLineNotionId];
            const expectedHash=sha({target:draft.dataSources.line,properties:expectedProperties,relations:expectedRelations});
            const actualProps=fromNotion(page,"line",config,draft),propsMatch=Object.entries(expectedValues).filter(([key])=>key!=="source_quote_notion_id"&&key!=="copied_from_quote_relation"&&key!=="copied_from_quote_line_relation"&&key!=="source_quote_line_id"&&key!=="source_line_id").every(([key,value])=>JSON.stringify(actualProps[key])===JSON.stringify(value))&&actualProps.line_request_key===stable;
            const relationMatches=Object.entries(expectedRelations).every(([name,ids])=>{const actual=rich(page.properties?.[name]);return Array.isArray(actual)&&actual.length===ids.length&&actual.every((x,i)=>norm(x)===norm(ids[i]));});
            if(!propsMatch||!relationMatches||expectedHash!==old[4])throw Error("invoice_draft_unknown_line_unresolved");
            const evidence={request_id:requestId,operation_key:op,method:old[2],target:old[3],payload_hash:old[4],approval_id:old[9],doc_key:old[10],approval_scope:{approved:true,approval_id:old[9],request_id:requestId,operation:old[2],target:old[3],payload_sha256:old[4],doc_key:old[10],expires_at:new Date(Date.now()+60000).toISOString()}};
            if(old[5]==="started")await ledger.externalUnknown({lease,evidence});await ledger.externalReconcile({lease,evidence:{...evidence,result_id:page.id,candidate_count:1,readback_verified:true,observed_payload_hash:old[4]}});
          }
          return[pageFromLine(page,id,config,draft)];}return[];},
      async createLine({header_id,stable_id,properties:values}){const properties=toNotion({...values,generation_request_id:requestId,line_request_key:stable_id},"line",config,draft),relations={};const parent=draft.relations.invoiceParent;if(parent)relations[parent]=[header_id];
        const sourceQuote=values.copied_from_quote_relation?.[0];if(sourceQuote)relations[draft.relations.sourceQuote]=[sourceQuote];const sourceLine=values.copied_from_quote_line_relation?.[0];if(sourceLine)relations[draft.relations.sourceQuoteLine]=[sourceLine];
        const target=draft.dataSources.line,op=`invoice-draft:${requestId}:line:${stable_id}`,operation="notion.page.create",{auth,payloadHash}=await recordApproval({requestId,operation,target,properties,relations}),docKey=`${doc.company_id}|invoice|draft:${requestId}`,evidence={request_id:requestId,operation_key:op,method:operation,target,payload_hash:payloadHash,approval_id:auth.approval_id,doc_key:docKey,approval_scope:{approved:true,approval_id:auth.approval_id,request_id:requestId,operation,target,payload_sha256:payloadHash,doc_key:docKey,expires_at:auth.expires_at}};
        if((await ledger.status()).ops.some(x=>x[0]===op))throw Error("invoice_draft_unknown_line_no_replay");await ledger.externalIntent({lease,evidence});
        try{const created=await notion.createPage({datasource:target,properties,relations,approvalProvider:{assertApproved:async actual=>{if(actual.action!=="create"||actual.datasource!==target||JSON.stringify(canonical(actual.properties))!==JSON.stringify(canonical(properties))||JSON.stringify(canonical(actual.relations||{}))!==JSON.stringify(canonical(relations)))throw Error("invoice_draft_line_operation_mismatch");}}});
          const page=await notion.getPage(created.id),mismatch=mappedPageMismatch(page,target,properties,relations);if(norm(page?.id)!==norm(created.id)||mismatch)throw Error(`invoice_draft_line_readback_mismatch:${mismatch||"page_id"}`);await ledger.externalFinish({lease,evidence:{...evidence,result_id:created.id}});return created.id;
        }catch(error){await ledger.externalUnknown({lease,evidence}).catch(()=>{});throw Object.assign(Error("invoice_draft_line_create_unknown"),{cause:error?.message||"unknown"});}},
      async getLine(id){const page=await notion.getPage(id);return pageFromLine(page,requestId,config,draft);},
      async getDraft(id){const page=await notion.getPage(id);if(!page)return null;const prop=page.properties?.[headerRequestProp],headerHash=rich(page.properties?.[propertyMap[draft.propertyMap.header.generation_input_hash]]);const linePages=await query(draft.dataSources.line,{property:draft.relations.invoiceParent,relation:{contains:id}});return{id:page.id,generation_input_hash:headerHash,lines:linePages};}
    };
    try{return await generateInvoiceDraft({requestId,input,freeeGet,notionWriter:writer,rounding});}finally{await ledger.release(lease);}
  }});
}
function pageFromLine(page,headerId,config,draft){const parsed=fromNotion(page,"line",config,draft),relName=draft.relations.invoiceParent,rel=page.properties?.[relName];parsed.id=page.id;parsed.header_id=rich(rel)?.[0]||headerId;parsed.generation_input_hash=rich(page.properties?.[config.notion.propertyMap[draft.propertyMap.line.generation_input_hash]]);parsed.copied_from_quote_relation=rich(page.properties?.[draft.relations.sourceQuote])||[];return parsed;}
