import test from "node:test";
import assert from "node:assert/strict";
import { runRegisteredDocumentBatch, safeGetWithRetry } from "../src/registered-batch.mjs";

const doc = (id, extra = {}) => ({
  registered: true, document_type: "quotation", freee_id: String(id), company_id: 12345,
  header_page_id: `header-${id}`, line_page_ids: [`line-${id}-1`, `line-${id}-2`], ...extra,
});

test("batch sequentially syncs registered quotes and invoices only", async () => {
  const seen = [];
  const report = await runRegisteredDocumentBatch({ companyId: "12345",
    listRegisteredDocuments: async () => [doc(1), doc(2, { document_type: "invoice" })],
    syncOne: async d => { seen.push(d.freee_id); return { status: "complete", write_count: 2 }; },
    runId: "e2e-1",
  });
  assert.deepEqual(seen, ["1", "2"]);
  assert.equal(report.status, "complete");
  assert.deepEqual(report.counts, { discovered: 2, processed:2, skipped_after_unknown:0, synced: 2, unchanged: 0, failed: 0, unknown: 0 });
  assert.equal(report.external_notification_sent, false);
  assert.equal(report.scheduled, false);
});

test("company scope is provided by each deployment and omission fails closed", async () => {
  for (const companyId of ["12345", "67890"]) {
    const report = await runRegisteredDocumentBatch({companyId,
      listRegisteredDocuments: async () => [doc(1, {company_id: companyId})],
      syncOne: async () => ({status:"complete_observed",write_count:0})});
    assert.equal(report.counts.unchanged, 1);
  }
  await assert.rejects(runRegisteredDocumentBatch({listRegisteredDocuments:async()=>[],syncOne:async()=>{}}), /company_scope_required/);
});

test("batch rejects unregistered/freee-unlinked records before calling writer", async () => {
  let calls = 0;
  await assert.rejects(runRegisteredDocumentBatch({ companyId: "12345",
    listRegisteredDocuments: async () => [{ ...doc(3), registered: false }],
    syncOne: async () => { calls++; return { status: "complete" }; },
  }), /unregistered_document_rejected/);
  assert.equal(calls, 0);
});

test("batch rejects duplicate identities and scope mismatches", async () => {
  const noop = async () => ({ status: "complete" });
  await assert.rejects(runRegisteredDocumentBatch({ companyId: "12345",
    listRegisteredDocuments: async () => [doc(7), doc(7)], syncOne: noop,
  }), /duplicate_registered_freee_identity/);
  await assert.rejects(runRegisteredDocumentBatch({ companyId: "12345",
    listRegisteredDocuments: async () => [doc(8, { company_id: 9 })], syncOne: noop,
  }), /company_scope_mismatch/);
});

test("no-diff documents report WRITE zero and remain unchanged", async () => {
  const events = [];
  const report = await runRegisteredDocumentBatch({ companyId: "12345",
    listRegisteredDocuments: async () => [doc(9)],
    syncOne: async () => ({ status: "complete_observed", write_count: 0 }),
    emitEvent: async e => events.push(e),
  });
  assert.equal(report.counts.unchanged, 1);
  assert.equal(report.results[0].write_count, 0);
  assert.equal(events.find(e=>e.event==="sync_no_change").event, "sync_no_change");
  assert.equal(events.at(-1).event, "sync_batch_finished");
});

test("unknown is reported and never retried by the batch coordinator", async () => {
  let calls = 0;
  const report = await runRegisteredDocumentBatch({ companyId: "12345",
    listRegisteredDocuments: async () => [doc(10), doc(11)],
    syncOne: async d => { calls++; return d.freee_id === "10" ? { status: "unknown" } : { status: "complete", write_count: 0 }; },
  });
  assert.equal(calls, 1);
  assert.equal(report.counts.unknown, 1);
  assert.equal(report.counts.skipped_after_unknown, 1);
  assert.equal(report.status, "partial");
});

test("ordinary document failure is isolated while later documents continue", async () => {
  const seen = [];
  const report = await runRegisteredDocumentBatch({ companyId: "12345",
    listRegisteredDocuments: async () => [doc(12), doc(13)],
    syncOne: async d => { seen.push(d.freee_id); if (d.freee_id === "12") throw Error("validation_failed"); return { status: "synced", write_count: 1 }; },
  });
  assert.deepEqual(seen, ["12", "13"]);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.synced, 1);
});

test("GET retries 429 then 5xx with bounded delay and GET method only", async () => {
  const calls = [], delays = [];
  const responses = [
    { status: 429, headers: { get: () => "1" } },
    { status: 503, headers: { get: () => null } },
    { status: 200, headers: { get: () => null } },
  ];
  const response = await safeGetWithRetry("https://example.invalid/x", {
    fetchImpl: async (_url, init) => { calls.push(init.method); return responses.shift(); },
    sleep: async ms => delays.push(ms),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["GET", "GET", "GET"]);
  assert.deepEqual(delays, [1000, 500]);
});

test("GET does not retry permanent 4xx and never changes method", async () => {
  let calls = 0;
  const response = await safeGetWithRetry("https://example.invalid/x", {
    fetchImpl: async (_url, init) => { calls++; assert.equal(init.method, "GET"); return { status: 404 }; },
  });
  assert.equal(response.status, 404);
  assert.equal(calls, 1);
});

test("GET retries are finite and invalid retry limit fails closed", async () => {
  let calls = 0;
  const response = await safeGetWithRetry("https://example.invalid/x", {
    maxAttempts: 2, sleep: async () => {},
    fetchImpl: async () => { calls++; return { status: 503, headers: { get: () => null } }; },
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 2);
  await assert.rejects(safeGetWithRetry("x", { maxAttempts: 4 }), /get_retry_limit_invalid/);
});
