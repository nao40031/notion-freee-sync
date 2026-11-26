import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const MAX_BYTES=5*1024*1024;
function safeReason(value){const text=String(value??"");return /^[A-Za-z0-9_:-]{1,96}$/.test(text)?text:"sync_error";}
function safeRecord(event){const r={event:String(event.event??"sync_event").slice(0,48),run_id:String(event.run_id??"").slice(0,96),at:new Date().toISOString()};
  if(event.document_type)r.document_type=String(event.document_type);if(event.freee_id)r.freee_id=String(event.freee_id).replace(/[^0-9]/g,"").slice(0,24);
  if(event.header_page_id)r.header_page_id=String(event.header_page_id).slice(0,40);if(Number.isSafeInteger(event.line_count))r.line_count=event.line_count;
  if(Number.isSafeInteger(event.write_count))r.write_count=event.write_count;if(event.status)r.status=String(event.status).slice(0,24);
  if(event.reason)r.reason=safeReason(event.reason);if(event.counts&&typeof event.counts==="object")r.counts=Object.fromEntries(["discovered","processed","skipped_after_unknown","synced","unchanged","failed","unknown"].filter(k=>Number.isSafeInteger(event.counts[k])).map(k=>[k,event.counts[k]]));
  return Object.freeze(r);}

/** Local structured run log + stderr alert. Does not contact an external service. */
function safeDocumentKey(record){return `${record.document_type||"batch"}:${record.freee_id||"batch"}`;}
function fingerprint(record){return createHash("sha256").update(`${record.event}|${safeDocumentKey(record)}|${record.reason||"sync_error"}`).digest("hex");}
function readNotificationState(path){try{const value=JSON.parse(readFileSync(path,"utf8"));return value&&typeof value==="object"&&!Array.isArray(value)?value:{}}catch{return {};}}
function writeNotificationState(path,value){const temporary=`${path}.${process.pid}.tmp`;writeFileSync(temporary,JSON.stringify(value),{encoding:"utf8",mode:0o600});renameSync(temporary,path);}

export function createLocalSyncMonitor({path=join(process.env.LOCALAPPDATA||process.cwd(),"NotionFreee","sync-events.jsonl"),append=appendFileSync,notify=text=>process.stderr.write(text),emailNotify=null,
  statePath=`${path}.notification-state.json`,readState=readNotificationState,writeState=writeNotificationState}={}){
  const notified=new Set();let emailSent=0;
  return Object.freeze({emailSentCount:()=>emailSent,async emit(event){const record=safeRecord(event);mkdirSync(dirname(path),{recursive:true});
    try{if(existsSync(path)&&statSync(path).size>=MAX_BYTES){const previous=path+".1";if(existsSync(previous))unlinkSync(previous);renameSync(path,previous);}}catch{}
    append(path,JSON.stringify(record)+"\n",{encoding:"utf8"});
    const documentKey=safeDocumentKey(record);
    if(["sync_succeeded","sync_no_change"].includes(record.event)){
      try{const state=readState(statePath);if(state[documentKey]){delete state[documentKey];writeState(statePath,state);}}catch{}
    }
    if(["sync_failed","sync_unknown"].includes(record.event)){
      const key=`${record.run_id}:${record.event}:${record.freee_id||"batch"}`;
      if(!notified.has(key)){
        notified.add(key);notify(`[Notion-freee] ${JSON.stringify(record)}\n`);
        if(emailNotify){
          const prior=readState(statePath),id=fingerprint(record);
          if(prior[documentKey]?.fingerprint!==id){
            try{await emailNotify(record);emailSent++;prior[documentKey]={fingerprint:id,sent_at:new Date().toISOString()};writeState(statePath,prior);
              append(path,JSON.stringify({event:"sync_email_sent",run_id:record.run_id,at:new Date().toISOString(),document_type:record.document_type,freee_id:record.freee_id,reason:"gmail_send_succeeded"})+"\n",{encoding:"utf8"});
            }catch(error){
              const reason=safeReason(error?.code||error?.message||"gmail_send_failed");
              append(path,JSON.stringify({event:"sync_email_failed",run_id:record.run_id,at:new Date().toISOString(),document_type:record.document_type,freee_id:record.freee_id,reason})+"\n",{encoding:"utf8"});
              notify(`[Notion-freee] email_notification_failed reason=${reason}\n`);
            }
          }
        }
      }
    }
    return record;}});
}
