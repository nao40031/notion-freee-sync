/**
 * Bounded batch coordinator for already-registered freee documents.
 *
 * This module deliberately does not create pages, write SQLite, or call a writer
 * directly. Each `syncOne` callback must be the existing single-document formal
 * host, which owns the shared SQLite lease, intent, unknown handling, and
 * read-back verification. The coordinator runs sequentially and never retries a
 * document after an unknown outcome.
 */

const ALLOWED_TYPES = new Set(["quotation", "invoice"]);
const MAX_DOCUMENTS = 500;

export class BatchSyncError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "BatchSyncError";
    this.code = code;
    this.details = details;
  }
}

const normId = value => String(value ?? "").replaceAll("-", "").toLowerCase();

function validateRegisteredDocument(document, companyId) {
  if (!document || typeof document !== "object" || document.registered !== true)
    throw new BatchSyncError("unregistered_document_rejected");
  if (!ALLOWED_TYPES.has(document.document_type))
    throw new BatchSyncError("document_type_invalid");
  if (!/^\d+$/.test(String(document.freee_id ?? "")))
    throw new BatchSyncError("registered_freee_id_required");
  if (String(document.company_id) !== companyId)
    throw new BatchSyncError("company_scope_mismatch");
  if (!document.header_page_id || !normId(document.header_page_id))
    throw new BatchSyncError("registered_header_page_required");
  if (!Array.isArray(document.line_page_ids) ||
      document.line_page_ids.some(id => !id || !normId(id)) ||
      new Set(document.line_page_ids.map(normId)).size !== document.line_page_ids.length)
    throw new BatchSyncError("registered_line_pages_invalid");
  if (document.request_id != null && (typeof document.request_id !== "string" || !document.request_id.trim()))
    throw new BatchSyncError("request_id_invalid");
  return Object.freeze({
    ...document,
    freee_id: String(document.freee_id),
    company_id: companyId,
    header_page_id: String(document.header_page_id),
    line_page_ids: [...document.line_page_ids].map(String),
  });
}

function outcomeKind(result) {
  const state = String(result?.status ?? "").toLowerCase();
  if (["unknown", "indeterminate", "outcome_unknown", "write_outcome_unknown"].includes(state) ||
      result?.unknown === true || result?.automatic_retry === false && result?.ledger_reconciliation_required)
    return "unknown";
  if (["no_change", "unchanged", "complete_observed"].includes(state)) return "unchanged";
  if (["complete", "synced", "notion_recovered"].includes(state)) return "synced";
  return "failed";
}

/**
 * Execute a stable snapshot of registered documents through one formal writer
 * callback at a time. Unknown outcomes are reported and never retried here.
 */
export async function runRegisteredDocumentBatch({
  listRegisteredDocuments,
  syncOne,
  emitEvent = async () => {},
  runId = `batch-${Date.now()}`,
  maxDocuments = 100,
  companyId,
} = {}) {
  if (typeof listRegisteredDocuments !== "function" || typeof syncOne !== "function")
    throw new BatchSyncError("batch_dependencies_required");
  if (!/^\d+$/.test(String(companyId ?? ""))) throw new BatchSyncError("company_scope_required");
  if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > MAX_DOCUMENTS)
    throw new BatchSyncError("batch_limit_invalid");

  const discovered = await listRegisteredDocuments({ limit: maxDocuments });
  if (!Array.isArray(discovered) || discovered.length > maxDocuments)
    throw new BatchSyncError("registered_document_list_invalid");

  const documents = discovered.map(document => validateRegisteredDocument(document, String(companyId)));
  const uniqueKeys = new Set();
  for (const document of documents) {
    const key = `${document.document_type}:${document.freee_id}`;
    if (uniqueKeys.has(key)) throw new BatchSyncError("duplicate_registered_freee_identity", { key });
    uniqueKeys.add(key);
  }

  const results = [];
  await emitEvent(Object.freeze({event:"sync_batch_started",run_id:runId,discovered:documents.length,started_at:new Date().toISOString()}));
  for (const document of documents) {
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await syncOne(document, { run_id: runId });
    } catch (error) {
      const unknown = error?.unknown === true || /unknown|indeterminate/i.test(String(error?.code ?? error?.message ?? ""));
      result = { status: unknown ? "unknown" : "failed", reason: String(error?.code ?? error?.message ?? "sync_failed") };
    }
    const classification = outcomeKind(result);
    const entry = Object.freeze({
      document_type: document.document_type,
      freee_id: document.freee_id,
      header_page_id: document.header_page_id,
      line_count: document.line_page_ids.length,
      status: classification,
      write_count: Number.isInteger(result?.write_count) ? result.write_count : null,
      reason: result?.reason ?? null,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
    results.push(entry);
    await emitEvent(Object.freeze({
      event: classification === "unknown" ? "sync_unknown" : classification === "failed" ? "sync_failed" :
        classification === "unchanged" ? "sync_no_change" : "sync_succeeded",
      run_id: runId,
      ...entry,
    }));
    if(classification==="unknown") break;
  }

  const counts = { discovered: documents.length, processed:results.length, skipped_after_unknown:documents.length-results.length, synced: 0, unchanged: 0, failed: 0, unknown: 0 };
  for (const result of results) counts[result.status]++;
  await emitEvent(Object.freeze({event:"sync_batch_finished",run_id:runId,status:counts.unknown?"unknown":counts.failed?"partial":"complete",counts,finished_at:new Date().toISOString()}));
  return Object.freeze({
    run_id: runId,
    status: counts.unknown || counts.failed ? "partial" : "complete",
    counts: Object.freeze(counts),
    results: Object.freeze(results),
    external_notification_sent: false,
    scheduled: false,
  });
}

function retryDelay(response, attempt, maxDelayMs) {
  const raw = response?.headers?.get?.("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelayMs, seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(maxDelayMs, Math.max(0, date - Date.now()));
  }
  return Math.min(maxDelayMs, 250 * (2 ** Math.max(0, attempt - 1)));
}

/** Retry only idempotent GET requests on transport failure, 429, or 5xx. */
export async function safeGetWithRetry(url, {
  fetchImpl = globalThis.fetch,
  headers,
  maxAttempts = 3,
  maxDelayMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  signal,
} = {}) {
  if (typeof fetchImpl !== "function") throw new BatchSyncError("get_fetch_required");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)
    throw new BatchSyncError("get_retry_limit_invalid");
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", headers, signal });
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw new BatchSyncError("get_transport_failed", { attempt });
      await sleep(Math.min(maxDelayMs, 250 * (2 ** (attempt - 1))));
      continue;
    }
    if (response?.status === 429 || (response?.status >= 500 && response?.status <= 599)) {
      if (attempt === maxAttempts) return response;
      await sleep(retryDelay(response, attempt, maxDelayMs));
      continue;
    }
    return response;
  }
  throw new BatchSyncError("get_transport_failed", { cause: lastError?.name ?? "unknown" });
}
