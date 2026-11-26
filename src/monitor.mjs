const safe = value => String(value ?? "").replace(/[^A-Za-z0-9_:-]/g, "_").slice(0,96);

export function createMonitor({append=async()=>{},notify=async()=>{},dedupe=new Set()}={}) {
  return Object.freeze({
    async emit(event) {
      const record=Object.freeze({event:safe(event.event),runId:safe(event.runId),documentType:safe(event.documentType),
        documentId:safe(event.documentId),status:safe(event.status),reason:safe(event.reason),at:new Date().toISOString()});
      await append(record);
      if (["failed","unknown"].includes(record.status)) {
        const key=`${record.documentType}:${record.documentId}:${record.status}:${record.reason}`;
        if (!dedupe.has(key)) { dedupe.add(key); await notify(record); }
      }
      return record;
    }
  });
}
