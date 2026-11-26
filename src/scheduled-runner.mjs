import {randomUUID} from "node:crypto";

function safeCode(error){const value=String(error?.code??"");return /^(?:[A-Z][A-Z0-9_]{1,40}|(?:api|freee|notion|formal|sync|oauth|writer|registration|invoice_draft|continuous_sync)_[a-z0-9_]{1,80})$/.test(value)?value:"sync_run_failed";}

/** One scheduled/manual invocation. Scheduling remains the OS/host's job;
 * the service owns its SQLite lease and business-operation idempotency. */
export async function runScheduledSync({service,emit=async()=>{},now=()=>new Date()}={}){
  if(typeof service?.run!=="function"||typeof emit!=="function")throw Error("scheduled_sync_runner_ports_required");
  const runId=randomUUID(),started=now().toISOString(),eventErrors=[];
  const safeEmit=async event=>{try{await emit(event);return true;}catch(error){eventErrors.push(safeCode(error));return false;}};
  await safeEmit({type:"sync_run_started",run_id:runId,occurred_at:started});
  try{
    const result=await service.run(),completed=now().toISOString();
    const summary={run_id:runId,status:"succeeded",started_at:started,completed_at:completed,
      documents_processed:Number.isInteger(result?.documents_processed)?result.documents_processed:null,
      documents_unchanged:Number.isInteger(result?.documents_unchanged)?result.documents_unchanged:null,
      documents_failed:Number.isInteger(result?.documents_failed)?result.documents_failed:null,
      event_sink_errors:eventErrors.length};
    await safeEmit({type:"sync_run_completed",...summary});return summary;
  }catch(error){
    const failedAt=now().toISOString(),summary={run_id:runId,status:"failed",started_at:started,failed_at:failedAt,error_type:safeCode(error),event_sink_errors:eventErrors.length};
    await safeEmit({type:"sync_run_failed",...summary});throw Object.assign(Error(summary.error_type),{runSummary:summary});
  }
}
