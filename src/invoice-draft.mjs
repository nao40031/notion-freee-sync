import { createHash } from 'node:crypto';

const json = value => JSON.stringify(value, Object.keys(value ?? {}).sort());
const hash = value => createHash('sha256').update(JSON.stringify(value, sortReplacer)).digest('hex');
function sortReplacer(_key, value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]]));
  return value;
}
function dec(value, name) {
  const s = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) throw Error(`invalid_decimal:${name}`);
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const negative = s.startsWith('-');
  const n = BigInt(whole) * 1000000n + BigInt((frac + '000000').slice(0, 6));
  return negative ? -n : n;
}
const fmt = n => `${n < 0 ? '-' : ''}${(n < 0 ? -n : n) / 1000000n}.${String((n < 0 ? -n : n) % 1000000n).padStart(6, '0')}`;
function rounded(n, mode = 'half-up') {
  const sign = n < 0n ? -1n : 1n, a = n < 0n ? -n : n, q = a / 10000n, r = a % 10000n;
  const bump = mode === 'floor' ? false : mode === 'ceil' ? r > 0n : mode === 'half-up' ? r >= 5000n : (() => { throw Error('unsupported_rounding'); })();
  return sign * (q + (bump ? 1n : 0n)) * 10000n;
}
function normalizeQuote(q, { rounding = 'half-up' } = {}) {
  if (!q || q.document_type !== 'quotation' || !q.freee_id || !q.company_id) throw Error('quote_identity_invalid');
  if (!Array.isArray(q.lines) || !q.lines.length) throw Error('quote_lines_missing');
  const ids = new Set();
  const lines = q.lines.map((l, i) => {
    if (!l.line_id || ids.has(String(l.line_id))) throw Error('quote_line_identity_invalid');
    ids.add(String(l.line_id));
    const quantity = dec(l.quantity, `quantity:${i}`), price = dec(l.unit_price, `unit_price:${i}`);
    const amount = dec(l.amount_excluding_tax, `line_amount:${i}`);
    if (rounded(quantity * price / 1000000n, rounding) !== rounded(amount, rounding)) throw Error(`quote_line_amount_mismatch:${l.line_id}`);
    if (![0, 8, 10].includes(Number(l.tax_rate))) throw Error('quote_tax_rate_invalid');
    return { source_line_id: String(l.line_id), description: String(l.description ?? ''), quantity: fmt(quantity), unit_price: fmt(price), unit: String(l.unit ?? ''), tax_rate: Number(l.tax_rate), reduced_tax_rate: Boolean(l.reduced_tax_rate), withholding: Boolean(l.withholding), amount_excluding_tax: fmt(amount) };
  });
  const net = lines.reduce((a, l) => a + dec(l.amount_excluding_tax, 'line_amount'), 0n);
  const tax = dec(q.amount_tax, 'amount_tax'), gross = dec(q.amount_including_tax, 'amount_including_tax');
  if (net !== dec(q.amount_excluding_tax, 'amount_excluding_tax') || net + tax !== gross) throw Error('quote_totals_inconsistent');
  // Validate tax by rate group using explicit rounding; a zero rate contributes no tax.
  const groups = new Map();
  for (const l of lines) groups.set(l.tax_rate, (groups.get(l.tax_rate) ?? 0n) + dec(l.amount_excluding_tax, 'line_amount'));
  const calculatedTax = [...groups].reduce((a, [rate, base]) => a + rounded(base * BigInt(rate) / 100n, rounding), 0n);
  if (calculatedTax !== tax) throw Error('quote_tax_rounding_mismatch');
  return { lines, net: fmt(net), tax: fmt(tax), gross: fmt(gross) };
}

/**
 * Formal draft-generation entry point. Ports are injected: freee only needs a GET,
 * while Notion writer provides lookup/create/readback. No network implementation lives here.
 */
export async function generateInvoiceDraft({ requestId, input, freeeGet, notionWriter, rounding = 'half-up' }) {
  if (!requestId || !input || !notionWriter || typeof notionWriter.findByRequest !== 'function') throw Error('draft_ports_or_request_missing');
  const inputHash = hash({ requestId, input });
  const existing = await notionWriter.findByRequest(requestId);
  if (existing) {
    if (existing.input_hash !== inputHash) throw Error('generation_request_payload_conflict');
    return await resume(existing, { requestId, inputHash, notionWriter });
  }
  let source = null, sourceQuoteId = null, sourceQuoteHeaderId = null, sourceLines = [], sourceLineNotionIds = {};
  let normalized;
  if (input.quote) {
    if (!freeeGet) throw Error('freee_get_port_missing');
    const binding = input.quote;
    const latest = await freeeGet.getDetail('quotation', String(binding.freee_id), String(binding.company_id));
    if (String(latest.freee_id) !== String(binding.freee_id) || String(latest.company_id) !== String(binding.company_id) || latest.document_type !== 'quotation') throw Error('quote_identity_mismatch');
    if (binding.mirror && hash(binding.mirror) !== hash(latest)) throw Error('quote_mirror_stale');
    normalized = normalizeQuote(latest, { rounding });
    source = String(binding.freee_id); sourceQuoteId = String(binding.notion_id ?? ''); sourceQuoteHeaderId = String(binding.notion_id ?? '');
    sourceLines = normalized.lines.map(l => l.source_line_id);
    sourceLineNotionIds = binding.line_notion_ids ?? {};
  } else {
    if (!Array.isArray(input.lines) || !input.lines.length) throw Error('direct_draft_lines_missing');
    const lines = input.lines.map((l, i) => {
      const quantity = dec(l.quantity, `quantity:${i}`), price = dec(l.unit_price, `unit_price:${i}`);
      const amount = rounded(quantity * price / 1000000n, rounding);
      if (l.amount_excluding_tax != null && rounded(dec(l.amount_excluding_tax, 'line_amount'), rounding) !== amount) throw Error(`line_amount_mismatch:${i}`);
      return { source_line_id: null, description: String(l.description ?? ''), quantity: fmt(quantity), unit_price: fmt(price), unit: String(l.unit ?? ''), tax_rate: Number(l.tax_rate), reduced_tax_rate: Boolean(l.reduced_tax_rate), withholding: Boolean(l.withholding), amount_excluding_tax: fmt(amount) };
    });
    if (lines.some(l => ![0, 8, 10].includes(l.tax_rate))) throw Error('draft_tax_rate_invalid');
    const net = lines.reduce((a,l) => a + dec(l.amount_excluding_tax,'line_amount'), 0n);
    const groups = new Map(); for (const l of lines) groups.set(l.tax_rate,(groups.get(l.tax_rate)??0n)+dec(l.amount_excluding_tax,'line_amount'));
    const tax = [...groups].reduce((a,[rate,base])=>a+rounded(base*BigInt(rate)/100n,rounding),0n);
    normalized = { lines, net:fmt(net), tax:fmt(tax), gross:fmt(net+tax) };
  }
  const spec = { request_id:requestId, input_hash:inputHash, generation_request_id:requestId, generation_input_hash:inputHash, document_type:'invoice', source_quote_freee_id:source, source_quote_notion_id:sourceQuoteId, amount_excluding_tax:normalized.net, amount_tax:normalized.tax, amount_including_tax:normalized.gross, status:'draft' };
  const header = await notionWriter.createHeader(spec);
  const planned = normalized.lines.map(l => ({ ...l }));
  const record = { request_id:requestId, input_hash:inputHash, header_id:header.id, source_quote_freee_id:source, source_quote_notion_id:sourceQuoteHeaderId, source_line_notion_ids:sourceLineNotionIds, expected_line_count:planned.length, planned_lines:planned, created_line_ids:[] };
  await notionWriter.saveRequest(record);
  return resume(record, { requestId, inputHash, notionWriter, lines:normalized.lines, sourceLines, sourceLineNotionIds });
}

async function resume(record, { requestId, inputHash, notionWriter, lines, sourceLines, sourceLineNotionIds }) {
  if (record.input_hash !== inputHash) throw Error('generation_request_payload_conflict');
  const current = lines ?? record.planned_lines ?? await notionWriter.getPlannedLines(requestId);
  sourceLineNotionIds ??= record.source_line_notion_ids ?? {};
  if (!current) throw Error('draft_resume_data_missing');
  for (let i=0;i<current.length;i++) {
    const line = current[i], stableId = `${requestId}:L${String(i+1).padStart(3,'0')}`;
    const relation = record.source_quote_notion_id ? [record.source_quote_notion_id] : [];
    const sourceLineId = sourceLines?.[i] ?? line.source_line_id ?? null;
    const sourceLineNotionId = sourceLineNotionIds[sourceLineId] ?? null;
    const props = { ...line, generation_request_id:requestId, generation_input_hash:inputHash, copied_from_freee_line_id:line.source_line_id, source_quote_notion_id:record.source_quote_notion_id, source_quote_line_id:sourceLineId, copied_from_quote_relation:relation, copied_from_quote_line_relation:sourceLineNotionId ? [sourceLineNotionId] : [] };
    let matches = await notionWriter.findLineByRequest(requestId, stableId);
    if (matches.length > 1) throw Error(`duplicate_generation_line:${stableId}`);
    let page = matches[0];
    if (page) {
      if (page.generation_input_hash !== inputHash || page.header_id !== record.header_id) throw Error(`existing_line_conflict:${stableId}`);
    } else {
      const id = await notionWriter.createLine({ header_id:record.header_id, stable_id:stableId, properties:props });
      page = await notionWriter.getLine(id);
    }
    if (!page || page.header_id !== record.header_id || page.generation_input_hash !== inputHash || page.copied_from_quote_relation?.[0] !== relation[0]) throw Error(`line_readback_mismatch:${stableId}`);
    record.created_line_ids[i] = page.id;
    await notionWriter.saveRequest(record);
  }
  const check = await notionWriter.getDraft(record.header_id);
  if (!check || check.generation_input_hash !== inputHash || check.lines.length !== current.length) throw Error('draft_readback_mismatch');
  return { request_id:requestId, header_id:record.header_id, line_ids:record.created_line_ids.slice(0,current.length), status:'verified', source_quote_freee_id:record.source_quote_freee_id, external_writes:0 };
}
