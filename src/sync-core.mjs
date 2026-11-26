const TYPES = new Set(["quotation", "invoice"]);

export class SyncError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "SyncError";
    this.code = code;
    this.details = details;
  }
}

const id = value => String(value ?? "").replaceAll("-", "").toLowerCase();
const decimal = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new SyncError("amount_invalid");
  return n;
};

function validateDocument(doc, policy) {
  if (!TYPES.has(doc?.documentType)) throw new SyncError("document_type_invalid");
  if (doc.registered !== true || !doc.freeeId || !doc.notionHeaderId)
    throw new SyncError("registered_identity_required");
  if (String(doc.companyId) !== String(policy.companyId))
    throw new SyncError("company_scope_mismatch");
  if (!policy.documentTypes.includes(doc.documentType)) throw new SyncError("document_type_out_of_scope");
  return doc;
}

function compare(a, b) {
  if (a == null || b == null) return a === b;
  if (typeof a === "number" || typeof b === "number") return decimal(a) === decimal(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => compare(v, b[i]));
  return a === b;
}

function relationIds(lines, relationProperty) {
  return lines.map(line => ({
    pageId: line.pageId,
    relations: (line.relations?.[relationProperty] ?? []).map(id),
  }));
}

function stableLineKey(line, keyFields) {
  return keyFields.map(field => String(line[field] ?? "").trim().normalize("NFKC").toLocaleLowerCase()).join("\u001f");
}

export function planDocumentSync({ document, header, notionLines, freeeDocument, propertyMap, policy }) {
  validateDocument(document, policy);
  if (id(header?.pageId) !== id(document.notionHeaderId) ||
      String(header?.freeeId) !== String(document.freeeId) ||
      String(header?.companyId) !== String(document.companyId))
    throw new SyncError("header_identity_mismatch");
  if (String(freeeDocument?.id) !== String(document.freeeId) ||
      String(freeeDocument?.companyId) !== String(document.companyId) ||
      String(freeeDocument?.documentNumber) !== String(document.documentNumber))
    throw new SyncError("freee_identity_mismatch");
  if (!Array.isArray(notionLines) || !Array.isArray(freeeDocument.lines))
    throw new SyncError("line_data_incomplete");

  const required = ["documentType", "freeeId", "companyId", "documentNumber", "syncState", "sourceHash", "syncedAt"];
  for (const field of required) if (!propertyMap?.[field]) throw new SyncError("property_mapping_incomplete", {field});
  const relationProperty = propertyMap.lineParentRelation;
  if (!relationProperty) throw new SyncError("relation_mapping_required");
  if (relationIds(notionLines, relationProperty).some(row => !row.relations.includes(id(document.notionHeaderId))))
    throw new SyncError("line_relation_mismatch");

  const oldById = new Map();
  const oldByKey = new Map();
  for (const line of notionLines) {
    const lineId = String(line.freeeLineId ?? "");
    if (!line.pageId || !lineId || oldById.has(lineId)) throw new SyncError("notion_line_identity_duplicate");
    oldById.set(lineId, line);
  }
  const newIds = new Set();
  for (const line of freeeDocument.lines) {
    const lineId = String(line.id ?? "");
    if (!lineId || newIds.has(lineId)) throw new SyncError("freee_line_identity_duplicate");
    newIds.add(lineId);
  }

  const usedOld = new Set();
  const matched = new Map();
  for (const line of freeeDocument.lines) {
    const exact = oldById.get(String(line.id));
    if (exact) { matched.set(String(line.id), exact); usedOld.add(exact.pageId); }
  }

  const keyFields = policy.lineReissueKeyFields;
  if (!Array.isArray(keyFields) || keyFields.length === 0) throw new SyncError("line_reissue_key_required");
  const unmatchedOld = notionLines.filter(line => !usedOld.has(line.pageId));
  const unmatchedNew = freeeDocument.lines.filter(line => !matched.has(String(line.id)));
  const countKeys = (rows, keyFn) => {
    const counts = new Map();
    for (const row of rows) { const k = keyFn(row); counts.set(k, (counts.get(k) ?? 0) + 1); }
    return counts;
  };
  const oldCounts = countKeys(unmatchedOld, line => stableLineKey(line.identity, keyFields));
  const newCounts = countKeys(unmatchedNew, line => stableLineKey(line, keyFields));
  const oldByKeyLocal = new Map(unmatchedOld.map(line => [stableLineKey(line.identity, keyFields), line]));
  for (const line of unmatchedNew) {
    const key = stableLineKey(line, keyFields);
    if ((newCounts.get(key) ?? 0) > 1 || (oldCounts.get(key) ?? 0) > 1)
      throw new SyncError("line_reissue_mapping_ambiguous");
    const old = oldByKeyLocal.get(key);
    if (old) { matched.set(String(line.id), old); usedOld.add(old.pageId); }
  }

  const net = freeeDocument.lines.reduce((n, line) => n + decimal(line.amountExcludingTax), 0);
  const headerNet = decimal(freeeDocument.amountExcludingTax);
  const tax = decimal(freeeDocument.amountTax);
  const gross = decimal(freeeDocument.amountIncludingTax);
  if (Math.abs(net - headerNet) > 1e-8 || Math.abs(headerNet + tax - gross) > 1e-8)
    throw new SyncError("freee_totals_inconsistent");

  const operations = [];
  const headerValues = {
    title: freeeDocument.title,
    status: freeeDocument.status,
    branch: freeeDocument.branch ?? null,
    amountExcludingTax: headerNet,
    amountTax: tax,
    amountIncludingTax: gross,
  };
  const headerDelta = {};
  for (const [logical, value] of Object.entries(headerValues)) {
    const property = propertyMap[logical];
    if (property && !compare(header[logical], value)) headerDelta[property] = value;
  }
  if (Object.keys(headerDelta).length) operations.push({action:"update_header", pageId:document.notionHeaderId, properties:headerDelta});

  const removed = notionLines.filter(line => !usedOld.has(line.pageId));
  const added = [];
  for (let index = 0; index < freeeDocument.lines.length; index++) {
    const line = freeeDocument.lines[index];
    const prior = matched.get(String(line.id));
    const values = {
      freeeLineId: String(line.id), title: line.description,
      quantity: decimal(line.quantity), unitPrice: decimal(line.unitPrice),
      taxRate: decimal(line.taxRate), amountExcludingTax: decimal(line.amountExcludingTax),
      unit: line.unit ?? "", lineNumber: index + 1,
    };
    if (!prior) {
      added.push(line);
      const props = Object.fromEntries(Object.entries(values).flatMap(([k,v]) => propertyMap[k] ? [[propertyMap[k],v]] : []));
      operations.push({action:"create_line", sourceLineId:String(line.id), properties:props,
        relations:{[relationProperty]:[document.notionHeaderId]}});
    } else {
      const delta = Object.fromEntries(Object.entries(values).flatMap(([k,v]) =>
        propertyMap[k] && !compare(prior[k],v) ? [[propertyMap[k],v]] : []));
      if (Object.keys(delta).length) operations.push({action:"update_line", pageId:prior.pageId, sourceLineId:String(line.id), properties:delta});
    }
  }
  if (removed.length && policy.allowArchiveRemovedLines) {
    for (const line of removed) operations.push({action:"archive_line", pageId:line.pageId, sourceLineId:line.freeeLineId});
  } else if (removed.length) {
    throw new SyncError("removed_lines_out_of_scope");
  }
  if (operations.some(op => op.action === "create_header" || op.action === "hard_delete"))
    throw new SyncError("forbidden_operation_planned");

  const sourceHash = freeeDocument.sourceHash;
  if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(sourceHash)) throw new SyncError("source_hash_invalid");
  const semanticChange = operations.length > 0;
  const metadataStale = header.syncState !== "synced" || header.sourceHash !== sourceHash || !header.syncedAt;
  if (semanticChange || metadataStale) {
    const syncProps = {};
    syncProps[propertyMap.syncState] = "synced";
    syncProps[propertyMap.sourceHash] = sourceHash;
    syncProps[propertyMap.syncedAt] = "<set-at-apply-time>";
    operations.push({action:"finalize_sync_metadata", pageId:document.notionHeaderId, properties:syncProps});
  }
  return Object.freeze({documentKey:`${document.companyId}:${document.documentType}:${document.freeeId}`,
    operations:Object.freeze(operations), writeCount:operations.length, noOp:operations.length===0,
    lineCounts:Object.freeze({before:notionLines.length,after:freeeDocument.lines.length}), sourceHash});
}

export async function runBatch({documents, loadSnapshot, plan, apply, policy, emit=async()=>{}}) {
  if (!Array.isArray(documents) || documents.length > policy.maxDocumentsPerRun) throw new SyncError("batch_limit_exceeded");
  const seen = new Set();
  const snapshots = [];
  for (const doc of documents) {
    validateDocument(doc, policy);
    const key = `${doc.companyId}:${doc.documentType}:${doc.freeeId}`;
    if (seen.has(key)) throw new SyncError("duplicate_document_identity");
    seen.add(key);
    snapshots.push(await loadSnapshot(doc));
  }
  const plans = snapshots.map((snapshot, index) => plan(snapshot, documents[index]));
  const totalOps = plans.reduce((n, p) => n + p.writeCount, 0);
  if (policy.requireNoOp && totalOps !== 0) throw new SyncError("noop_guard_failed", {totalOps});
  await emit({event:"batch_started",count:documents.length});
  const results = [];
  for (let i=0;i<documents.length;i++) {
    const p=plans[i];
    if (p.noOp) { results.push({status:"unchanged",writeCount:0}); continue; }
    try { results.push(await apply(p, documents[i])); }
    catch (error) { results.push({status:error?.unknown?"unknown":"failed",reason:error?.code||"sync_failed"}); if(error?.unknown) break; }
  }
  await emit({event:"batch_finished",count:documents.length,processed:results.length});
  return Object.freeze({results:Object.freeze(results),plannedOperations:totalOps});
}
