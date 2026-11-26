"""Fail-closed, write-free planner for variable-length freee→Notion line sync.

This planner deliberately produces operations only. A separately approved
writer must validate page/property allowlists and perform each operation.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
from typing import Any


class SyncPlanError(ValueError):
    pass


def _id(value: Any) -> str:
    return str(value or "").replace("-", "").lower()


def _amount(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise SyncPlanError("invalid_amount") from exc


def _notion_number(value: Any) -> int | float:
    """Return a JSON number for Notion number properties, never a numeric string."""
    number = _amount(value)
    if not number.is_finite():
        raise SyncPlanError("invalid_amount")
    if number == number.to_integral_value():
        return int(number)
    result = float(number)
    if not math.isfinite(result):
        raise SyncPlanError("invalid_amount")
    return result


def _same(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is b
    try:
        return _amount(a) == _amount(b)
    except SyncPlanError:
        return a == b


def _source_hash(expected: dict[str, Any], freee: dict[str, Any], lines: list[dict[str, Any]]) -> str:
    """Stable hash of the normalized freee values mirrored into Notion."""
    source = {
        "document_type": expected["document_type"], "freee_id": str(freee["id"]),
        "company_id": str(freee["company_id"]), "document_number": str(freee["document_number"]),
        "branch_no": freee.get("branch_no"), "title": freee.get("title"), "status": freee.get("status"),
        "amount_excluding_tax": str(_amount(freee["amount_excluding_tax"])),
        "amount_tax": str(_amount(freee["amount_tax"])),
        "amount_including_tax": str(_amount(freee["amount_including_tax"])),
        "lines": [{"id": str(x["id"]), "description": str(x["description"]),
                   "quantity": str(_amount(x["quantity"])), "unit_price": str(_amount(x["unit_price"])),
                   "tax_rate": str(_amount(x["tax_rate"])),
                   "amount_excluding_tax": str(_amount(x["amount_excluding_tax"])),
                   "unit": str(x.get("unit", ""))} for x in lines],
    }
    canonical = json.dumps(source, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def plan_registered_document_sync(expected: dict[str, Any], header: dict[str, Any],
                                  notion_lines: list[dict[str, Any]],
                                  freee: dict[str, Any]) -> dict[str, Any]:
    """Build per-page create/update/archive candidates; never call an API.

    Identity is the registered document (company, type, freee ID, number).
    Lines join by freee line ID. When an ID was reissued, a unique unchanged
    description may reconnect it; all other ambiguous changes fail closed.
    """
    required = ("notion_id", "document_type", "freee_id", "company_id", "document_number")
    if any(not expected.get(k) for k in required):
        raise SyncPlanError("registered_identity_required")
    if expected["document_type"] not in ("invoice", "quotation"):
        raise SyncPlanError("unsupported_document_type")
    if (_id(header.get("page_id") or expected["notion_id"]) != _id(expected["notion_id"])
        or str(header.get("freee帳票ID") or "") != str(expected["freee_id"])
        or str(header.get("freee事業所ID") or "") != str(expected["company_id"])
        or str(header.get("freee正式番号") or "") != str(expected["document_number"])):
        raise SyncPlanError("registered_header_mismatch")
    if (_id(freee.get("id")) != _id(expected["freee_id"])
        or str(freee.get("company_id")) != str(expected["company_id"])
        or str(freee.get("document_number")) != str(expected["document_number"])):
        raise SyncPlanError("freee_identity_mismatch")

    source = freee.get("lines")
    if not isinstance(source, list):
        raise SyncPlanError("freee_lines_incomplete")
    old_by_id: dict[str, dict[str, Any]] = {}
    old_names: dict[str, int] = {}
    parent = _id(expected["notion_id"])
    relation_name = "請求書" if expected["document_type"] == "invoice" else "見積書"
    for row in notion_lines:
        pid = _id(row.get("page_id"))
        lid = _id(row.get("freee明細ID"))
        if not pid or not lid or pid in old_by_id or lid in old_by_id:
            raise SyncPlanError("notion_line_identity_missing_or_duplicate")
        rel = {_id(x) for x in (row.get(relation_name) or [])}
        if parent not in rel:
            raise SyncPlanError("notion_line_parent_mismatch")
        name = str(row.get("明細名") or "")
        old_names[name] = old_names.get(name, 0) + 1
        old_by_id[lid] = row
    new_by_id: dict[str, dict[str, Any]] = {}
    new_names: dict[str, int] = {}
    for line in source:
        lid, name = _id(line.get("id")), str(line.get("description") or "")
        if not lid or not name or lid in new_by_id:
            raise SyncPlanError("freee_line_identity_missing_or_duplicate")
        new_by_id[lid] = line
        new_names[name] = new_names.get(name, 0) + 1

    # Reconnect reissued IDs only when the unchanged name uniquely identifies
    # exactly one old and one new line. Mutable amounts are not identity keys.
    matched: dict[str, dict[str, Any]] = {}
    used_old: set[str] = set()
    for lid, line in new_by_id.items():
        if lid in old_by_id:
            matched[lid] = old_by_id[lid]; used_old.add(lid)
    unmatched_old = {k:v for k,v in old_by_id.items() if k not in used_old}
    unmatched_new = {k:v for k,v in new_by_id.items() if k not in matched}
    old_by_name: dict[str, list[tuple[str,dict[str,Any]]]] = {}
    new_by_name: dict[str, list[tuple[str,dict[str,Any]]]] = {}
    for k,v in unmatched_old.items(): old_by_name.setdefault(str(v.get("明細名") or ""), []).append((k,v))
    for k,v in unmatched_new.items(): new_by_name.setdefault(str(v.get("description") or ""), []).append((k,v))
    for name in set(old_by_name) & set(new_by_name):
        if old_names.get(name) != 1 or new_names.get(name) != 1 or len(old_by_name[name]) != 1 or len(new_by_name[name]) != 1:
            raise SyncPlanError("line_reissue_mapping_ambiguous")
        old_id, row = old_by_name[name][0]
        new_id, _ = new_by_name[name][0]
        matched[new_id] = row; used_old.add(old_id)
    removed = [v for k,v in old_by_id.items() if k not in used_old]
    added = [v for k,v in new_by_id.items() if k not in matched]

    operations = []
    ordered = list(source)
    for index, line in enumerate(ordered, 1):
        lid = _id(line["id"]); row = matched.get(lid)
        props = {"freee明細ID": str(line["id"]), "明細名": line["description"],
                 "数量": _notion_number(line["quantity"]), "単価": _notion_number(line["unit_price"]),
                 "税率": _notion_number(line["tax_rate"]), "税抜金額": _notion_number(line["amount_excluding_tax"]),
                 "単位": line.get("unit", ""), "行番号": index}
        if row is None:
            operations.append({"action":"create","source_line_id":line["id"],"properties":props,
                               "relations":{relation_name:[expected["notion_id"]]}})
        else:
            delta = {k:v for k,v in props.items() if not _same(row.get(k),v)}
            if delta:
                operations.append({"action":"update","page_id":row["page_id"],
                                   "source_line_id":line["id"],"properties":delta})
    for row in removed:
        operations.append({"action":"archive_candidate","page_id":row["page_id"],
                           "source_line_id":row["freee明細ID"]})

    totals = [_amount(x.get("amount_excluding_tax")) for x in source]
    net, tax, gross = (_amount(freee.get(k)) for k in
                       ("amount_excluding_tax","amount_tax","amount_including_tax"))
    if sum(totals, Decimal(0)) != net or net + tax != gross:
        raise SyncPlanError("freee_totals_inconsistent")
    source_hash = _source_hash(expected, freee, source)
    branch = freee.get("branch_no")
    header_props = {"枝番":None if branch in (None, "") else _notion_number(branch),"税抜合計":_notion_number(net),
                    "税額":_notion_number(tax),"税込合計":_notion_number(gross),
                    "件名":freee.get("title")}
    # Only mirror status when the target data source defines the property.
    if "帳票状態" in header:
        header_props["帳票状態"] = freee.get("status")
    header_delta = {k:v for k,v in header_props.items() if not _same(header.get(k),v)}
    if header_delta:
        operations.insert(0,{"action":"update_header","page_id":expected["notion_id"],
                             "properties":header_delta})
    # Sync metadata is finalized last, so a partial line update is never marked
    # current. The stable marker lets retries retain the same plan hash while
    # the production transport supplies the actual apply timestamp.
    sync_timestamp = header.get("同期日時") or header.get("date:同期日時:start")
    # Existing Phase 6 records use a different source-hash projection. Do not
    # treat a non-empty legacy hash as evidence of a business-data change: the
    # planner has already compared every mirrored header/line field above.
    # Preserve the legacy hash on a semantic no-op; migrate to this planner's
    # hash only when business fields actually change. Missing metadata and an
    # unfinished sync still require finalization.
    legacy_or_current_hash_present = isinstance(header.get("同期元ハッシュ"), str) and bool(header.get("同期元ハッシュ"))
    semantic_change_planned = bool(operations)
    metadata_stale = (header.get("同期状態") != "同期済"
                      or not isinstance(sync_timestamp, str) or not sync_timestamp
                      or not legacy_or_current_hash_present)
    if metadata_stale or (semantic_change_planned and header.get("同期元ハッシュ") != source_hash):
        operations.append({"action":"update_header","page_id":expected["notion_id"],
                           "properties":{"同期状態":"同期済","同期元ハッシュ":source_hash,
                                         "date:同期日時:start":"<set-at-apply-time>"}})
    return {"operations":operations,"write_count":len(operations),"source_hash":source_hash,
            "no_op":not operations,"external_writes":0,
            "line_counts":{"before":len(notion_lines),"after":len(source)}}
