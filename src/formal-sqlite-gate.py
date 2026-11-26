#!/usr/bin/env python3
"""Focused extraction of the Private formal Phase 8 SQLite writer gate.

Only the registered-document continuous-sync operations are included here.
Project scope is loaded from a local JSON config supplied on the command line;
no database IDs or company IDs are compiled into this module.
"""
from __future__ import annotations
import argparse, hashlib, json, os, re, socket, sqlite3, sys, uuid
import ctypes
from datetime import datetime, timezone
from pathlib import Path

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()

def norm(value):
    return str(value or "").replace("-", "").lower()

def load_config(path):
    config=json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(config,dict): raise RuntimeError("project_config_invalid")
    company=str(config.get("freee",{}).get("companyId", ""))
    docs=config.get("notion",{}).get("documentSources",{})
    policy=config.get("policy",{})
    if not company.isdigit() or not policy.get("policyId") or policy.get("direction")!="freee-to-notion":
        raise RuntimeError("project_policy_config_invalid")
    types=policy.get("documentTypes")
    if not isinstance(types,list) or not types or set(types)-{"quotation","invoice"}: raise RuntimeError("project_document_types_invalid")
    sources={}
    for kind in types:
        header=docs.get(kind); line=docs.get(kind+"Line")
        relation=docs.get(kind+"Relation")
        if not header or not line or not relation: raise RuntimeError("project_datasource_mapping_incomplete")
        sources[kind]={"header":"collection://"+str(header).removeprefix("collection://"),"lines":"collection://"+str(line).removeprefix("collection://"),"relation":relation}
        for value in (header,line):
            if not re.fullmatch(r"(?:[0-9a-f]{32}|[0-9a-f-]{36})",str(value).removeprefix("collection://"),re.I): raise RuntimeError("project_datasource_id_invalid")
    mapped=policy.get("allowedProperties",{})
    if not isinstance(mapped,dict) or any(not isinstance(v,list) or not v for v in mapped.values()): raise RuntimeError("project_property_scope_invalid")
    actions=policy.get("allowedActions")
    if not isinstance(actions,list) or not actions or len(set(actions))!=len(actions) or set(actions)-{"update","create","archive"} or "update" not in actions:
        raise RuntimeError("project_action_scope_invalid")
    if policy.get("allowHeaderCreate") is not False or policy.get("allowHardDelete") is not False: raise RuntimeError("project_forbidden_operation_enabled")
    return {"company_id":int(company),"policy_id":str(policy["policyId"]),"sources":sources,"policy":policy}

def connect(path):
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(path,timeout=30,isolation_level=None)
    db.execute("PRAGMA busy_timeout=30000"); db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA synchronous=FULL")
    db.executescript("""
      CREATE TABLE IF NOT EXISTS writer_lease(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,host TEXT NOT NULL,pid INTEGER NOT NULL,started_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS writer_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,token TEXT,detail TEXT NOT NULL,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS external_ops(op_key TEXT PRIMARY KEY,request_id TEXT NOT NULL,method TEXT NOT NULL,target TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,result_id TEXT,error TEXT,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,approval_id TEXT,doc_key TEXT);
    """)
    return db

def policy_scope(cfg):
    return {"company_id":cfg["company_id"],"document_types":cfg["policy"]["documentTypes"],
      "header_datasources":[cfg["sources"][t]["header"] for t in cfg["policy"]["documentTypes"]],
      "line_datasources":[cfg["sources"][t]["lines"] for t in cfg["policy"]["documentTypes"]],
      "actions":cfg["policy"]["allowedActions"],"header_properties":cfg["policy"]["allowedProperties"].get("header",[]),
      "line_properties":cfg["policy"]["allowedProperties"].get("line",[]),
      "max_documents":int(cfg["policy"].get("maxDocumentsPerRun",100))}

def latest_policy(db,cfg):
    row=db.execute("SELECT event,detail FROM writer_audit WHERE event IN ('continuous_sync_policy_enabled','continuous_sync_policy_revoked') ORDER BY seq DESC LIMIT 1").fetchone()
    if not row or row[0]!="continuous_sync_policy_enabled": return None
    try: item=json.loads(row[1])
    except Exception as exc: raise RuntimeError("continuous_sync_policy_record_invalid") from exc
    if item.get("policy_id")!=cfg["policy_id"] or item.get("scope")!=policy_scope(cfg): raise RuntimeError("continuous_sync_policy_scope_mismatch")
    return item

def validate_evidence(db,cfg,e,page,is_create,require_active=True):
    scope=policy_scope(cfg); policy=latest_policy(db,cfg)
    if require_active and not policy: raise RuntimeError("continuous_sync_policy_not_active_or_scope_mismatch")
    ident=e.get("registered_identity")
    if (not isinstance(ident,dict) or ident.get("registered") is not True or int(ident.get("company_id",-1))!=cfg["company_id"] or
        ident.get("document_type") not in cfg["policy"]["documentTypes"] or not str(ident.get("freee_id","")).isdigit() or
        not ident.get("document_number") or not ident.get("header_page_id")):
        raise RuntimeError("continuous_sync_registered_identity_invalid")
    spec=cfg["sources"][ident["document_type"]]; ds=e["datasource"]
    is_header=ds==spec["header"]
    if not is_header and ds!=spec["lines"]: raise RuntimeError("continuous_sync_datasource_out_of_scope")
    allowed=scope["header_properties"] if is_header else scope["line_properties"]
    if e["action"] not in scope["actions"] or e["action"] not in (("update",) if is_header else ("create","update","archive")) or set(e["properties"])-set(allowed) or (is_create and spec["relation"] not in allowed):
        raise RuntimeError("continuous_sync_operation_or_property_out_of_scope")
    pages={norm(x) for x in ident.get("document_page_ids",[])}
    if norm(ident.get("header_page_id")) not in pages or len(pages)!=len(ident.get("document_page_ids",[])) or (not is_create and norm(page) not in pages):
        raise RuntimeError("continuous_sync_page_out_of_scope")
    if is_create:
        rel=e["operation"].get("relations",{}); relation=spec["relation"]
        if len(rel)!=1 or relation not in rel or len(rel[relation])!=1 or norm(rel[relation][0])!=norm(ident["header_page_id"]):
            raise RuntimeError("continuous_sync_create_relation_out_of_scope")
    if e.get("registered_identity_hash")!=digest(ident): raise RuntimeError("continuous_sync_identity_hash_mismatch")

def process_is_alive(pid):
    if not isinstance(pid,int) or pid<=0: return False
    if os.name=="nt":
        kernel=ctypes.windll.kernel32; kernel.OpenProcess.argtypes=[ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]; kernel.OpenProcess.restype=ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]; kernel.GetExitCodeProcess.restype=ctypes.c_int
        kernel.CloseHandle.argtypes=[ctypes.c_void_p]; kernel.CloseHandle.restype=ctypes.c_int
        kernel.GetLastError.restype=ctypes.c_ulong; handle=kernel.OpenProcess(0x1000,False,pid)
        if not handle: return kernel.GetLastError()!=87
        code=ctypes.c_ulong(); ok=kernel.GetExitCodeProcess(handle,ctypes.byref(code)); kernel.CloseHandle(handle)
        return not ok or code.value==259
    try: os.kill(pid,0); return True
    except ProcessLookupError: return False
    except PermissionError: return True
    except OSError as exc:
        if getattr(exc,"winerror",None)==87 or exc.errno==3: return False
        return True

def main():
    p=argparse.ArgumentParser(); p.add_argument("action",choices=["acquire","release","status","policy-status","recovery-items","policy-approve","policy-revoke","phase8-intent","phase8-finish","phase8-unknown","phase8-reconcile","external-intent","external-finish","external-unknown","external-reconcile","draft-state-get","draft-state-put"]); p.add_argument("--db",required=True); p.add_argument("--config",required=True); p.add_argument("--token",default=""); p.add_argument("--owner-pid",type=int,default=0); p.add_argument("--evidence-b64",default=""); p.add_argument("--request-id",default=""); p.add_argument("--record-b64",default=""); a=p.parse_args(); cfg=load_config(a.config)
    db=connect(a.db)
    try:
      db.execute("BEGIN IMMEDIATE")
      if a.action=="acquire":
        current=db.execute("SELECT token,host,pid,started_at FROM writer_lease WHERE id=1").fetchone()
        if current:
          if current[1]!=socket.gethostname() or process_is_alive(int(current[2])): raise RuntimeError("writer_lease_held")
          db.execute("DELETE FROM writer_lease WHERE id=1 AND token=?",(current[0],))
          db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('stale_lease_reclaimed',?,?)",(current[0],canonical({"old_host":current[1],"old_pid":current[2],"old_started_at":current[3]})))
        token=uuid.uuid4().hex; db.execute("INSERT INTO writer_lease VALUES(1,?,?,?,?)",(token,socket.gethostname(),a.owner_pid,datetime.now(timezone.utc).isoformat())); db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('lease_acquired',?,?)",(token,json.dumps({"pid":a.owner_pid}))); db.commit(); print(json.dumps({"ok":True,"token":token})); return
      if a.action in ("status","policy-status"):
        lease=db.execute("SELECT token,host,pid,started_at FROM writer_lease WHERE id=1").fetchone(); ops=db.execute("SELECT op_key,request_id,method,target,payload_hash,status,result_id,error,at,approval_id,doc_key FROM external_ops ORDER BY at").fetchall(); pol=latest_policy(db,cfg); db.commit(); print(json.dumps({"ok":True,"lease":lease,"ops":ops,"policy":{"policy_id":pol["policy_id"],"scope":pol["scope"],"approved_at":pol["approved_at"],"status":"active"} if pol else {"policy_id":cfg["policy_id"],"scope":policy_scope(cfg),"status":"inactive"}})); return
      if a.action=="draft-state-get":
        if not a.request_id: raise RuntimeError("draft_state_request_id_required")
        rows=db.execute("SELECT detail FROM writer_audit WHERE event='invoice_draft_generation_state' ORDER BY seq DESC").fetchall(); found=None
        for raw, in rows:
          item=json.loads(raw)
          if item.get("request_id")==a.request_id: found=item.get("record"); break
        db.commit(); print(json.dumps({"ok":True,"record":found},ensure_ascii=False)); return
      if a.action=="recovery-items":
        rows=db.execute("SELECT detail FROM writer_audit WHERE event='phase8_intent_evidence' ORDER BY seq").fetchall(); items=[json.loads(x[0]) for x in rows]; unresolved={x[0] for x in db.execute("SELECT op_key FROM external_ops WHERE status IN ('started','unknown')")}; db.commit(); print(json.dumps({"ok":True,"items":[x for x in items if x.get("operation_key") in unresolved]})); return
      row=db.execute("SELECT token FROM writer_lease WHERE id=1").fetchone()
      if a.action in ("policy-approve","policy-revoke"):
        if not a.token or not row or row[0]!=a.token: raise RuntimeError("continuous_sync_policy_writer_lease_required")
        if not sys.stdin.isatty() or not sys.stdout.isatty(): raise RuntimeError("policy_operator_tty_required")
        phrase="APPROVE REGISTERED DOCUMENT SYNC" if a.action=="policy-approve" else "REVOKE REGISTERED DOCUMENT SYNC"
        print(json.dumps({"policy_id":cfg["policy_id"],"scope":policy_scope(cfg),"action":a.action},indent=2)); print(f'Type exactly "{phrase}": ',end="",flush=True)
        if sys.stdin.readline().strip()!=phrase: raise RuntimeError("policy_operator_declined")
        active=latest_policy(db,cfg)
        if a.action=="policy-approve":
          if active: raise RuntimeError("continuous_sync_policy_already_active")
          item={"policy_id":cfg["policy_id"],"scope":policy_scope(cfg),"approved_at":datetime.now(timezone.utc).isoformat(),"identity_assurance":"local_operator_unverified"}
          db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('continuous_sync_policy_enabled',NULL,?)",(canonical(item),))
          db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('continuous_sync_policy_operator_confirmed',?,?)",(a.token,canonical({"action":a.action,"policy_id":cfg["policy_id"],"identity_assurance":"local_operator_unverified"})))
        else:
          if not active: raise RuntimeError("continuous_sync_policy_not_active")
          item={"policy_id":cfg["policy_id"],"revoked_at":datetime.now(timezone.utc).isoformat()}
          db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('continuous_sync_policy_revoked',NULL,?)",(canonical(item),))
          db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('continuous_sync_policy_operator_confirmed',?,?)",(a.token,canonical({"action":a.action,"policy_id":cfg["policy_id"],"identity_assurance":"local_operator_unverified"})))
        db.commit(); print(json.dumps({"ok":True,"policy_id":cfg["policy_id"],"action":a.action})); return
      if not a.token or not row or row[0]!=a.token: raise RuntimeError("active_writer_lease_required")
      if a.action=="draft-state-put":
        import base64
        if not a.request_id or not a.record_b64: raise RuntimeError("draft_state_record_required")
        record=json.loads(base64.urlsafe_b64decode(a.record_b64+"="*((4-len(a.record_b64)%4)%4)).decode("utf-8"))
        if not isinstance(record,dict) or record.get("request_id")!=a.request_id or not re.fullmatch(r"[0-9a-f]{64}",str(record.get("input_hash",""))) or len(canonical(record).encode("utf-8"))>1000000: raise RuntimeError("draft_state_record_invalid")
        db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('invoice_draft_generation_state',?,?)",(a.token,canonical({"request_id":a.request_id,"input_hash":record["input_hash"],"record":record})))
        db.commit(); print(json.dumps({"ok":True})); return
      if a.action=="release": db.execute("DELETE FROM writer_lease WHERE id=1 AND token=?",(a.token,)); db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('lease_released',?, '{}')",(a.token,)); db.commit(); print(json.dumps({"ok":True})); return
      if a.action.startswith("external-"):
        if not a.evidence_b64: raise RuntimeError("external_operation_evidence_required")
        import base64
        e=json.loads(base64.urlsafe_b64decode(a.evidence_b64+"="*((4-len(a.evidence_b64)%4)%4)).decode("utf-8"))
        required={"request_id","operation_key","method","target","payload_hash","approval_id","doc_key","approval_scope"}
        if not isinstance(e,dict) or not required.issubset(e): raise RuntimeError("external_operation_evidence_invalid")
        if not re.fullmatch(r"[a-z]+\.(?:quotation|invoice)\.create|notion\.page\.(?:create|update)",str(e["method"])) or not re.fullmatch(r"[0-9a-f]{64}",str(e["payload_hash"])): raise RuntimeError("external_operation_scope_invalid")
        approval=e["approval_scope"]
        expected={"approved":True,"approval_id":e["approval_id"],"request_id":e["request_id"],"operation":e["method"],"target":e["target"],"payload_sha256":e["payload_hash"],"doc_key":e["doc_key"]}
        if not isinstance(approval,dict) or any(approval.get(k)!=v for k,v in expected.items()) or not isinstance(approval.get("expires_at"),str): raise RuntimeError("external_operation_approval_scope_invalid")
        if a.action=="external-intent" and not datetime.fromisoformat(approval["expires_at"].replace("Z","+00:00"))>datetime.now(timezone.utc): raise RuntimeError("external_operation_approval_expired")
        key=e["operation_key"]; prior=db.execute("SELECT request_id,method,target,payload_hash,status,result_id FROM external_ops WHERE op_key=?",(key,)).fetchone()
        if a.action=="external-intent":
          if prior: raise RuntimeError("external_operation_already_recorded")
          unresolved=db.execute("SELECT status FROM external_ops WHERE doc_key=? AND status IN ('started','unknown') LIMIT 1",(e["doc_key"],)).fetchone()
          if unresolved: raise RuntimeError("external_document_unresolved_operation")
          db.execute("INSERT INTO external_ops(op_key,request_id,method,target,payload_hash,status,approval_id,doc_key) VALUES(?,?,?,?,?,'started',?,?)",(key,e["request_id"],e["method"],e["target"],e["payload_hash"],e["approval_id"],e["doc_key"]))
          db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('external_operation_intent',?,?)",(a.token,canonical({"operation_key":key,"request_id":e["request_id"],"payload_hash":e["payload_hash"]})))
        else:
          if not prior or prior[0]!=e["request_id"] or prior[1]!=e["method"] or prior[2]!=e["target"] or prior[3]!=e["payload_hash"]: raise RuntimeError("external_operation_identity_mismatch")
          expected_status="started" if a.action in ("external-finish","external-unknown") else "unknown"
          if prior[4]!=expected_status: raise RuntimeError("external_operation_transition_invalid")
          if a.action=="external-finish":
            if not isinstance(e.get("result_id"),str) or not e["result_id"]: raise RuntimeError("external_operation_result_id_required")
            db.execute("UPDATE external_ops SET status='succeeded',result_id=? WHERE op_key=? AND status='started'",(e["result_id"],key)); event="external_operation_finished"
          elif a.action=="external-unknown":
            db.execute("UPDATE external_ops SET status='unknown',error='outcome_unknown' WHERE op_key=? AND status='started'",(key,)); event="external_operation_unknown"
          else:
            if e.get("candidate_count")!=1 or e.get("readback_verified") is not True or e.get("observed_payload_hash")!=e["payload_hash"] or not isinstance(e.get("result_id"),str) or not e["result_id"]: raise RuntimeError("external_operation_reconcile_invalid")
            db.execute("UPDATE external_ops SET status='succeeded',result_id=?,error=NULL WHERE op_key=? AND status='unknown'",(e["result_id"],key)); event="external_operation_reconciled"
          db.execute("INSERT INTO writer_audit(event,token,detail) VALUES(?,?,?)",(event,a.token,canonical({"operation_key":key,"result_id":e.get("result_id"),"payload_hash":e["payload_hash"]})))
        db.commit(); print(json.dumps({"ok":True,"action":a.action})); return
      if not a.evidence_b64: raise RuntimeError("phase8_evidence_required")
      import base64
      e=json.loads(base64.urlsafe_b64decode(a.evidence_b64+"="*((4-len(a.evidence_b64)%4)%4)).decode("utf-8")); required={"request_id","plan_hash","operation_key","action","method","datasource","page_id","properties","property_allowlist","page_allowlist","operation_hash","operation","plan","operation_index","source_line_id","approval_id","registered_identity","registered_identity_hash"}
      if not isinstance(e,dict) or not required.issubset(e): raise RuntimeError("phase8_evidence_invalid")
      op=e["operation"]; idx=e["operation_index"]
      if digest(op)!=e["operation_hash"] or digest(e["plan"])!=e["plan_hash"] or not isinstance(idx,int) or idx<0 or idx>=len(e["plan"].get("operations",[])) or e["plan"]["operations"][idx]!=op: raise RuntimeError("phase8_plan_or_operation_hash_invalid")
      if e["operation_key"]!=f"phase8:{e['request_id']}:{idx}:{e['operation_hash']}": raise RuntimeError("phase8_operation_key_invalid")
      action={"update_header":"update","archive_candidate":"archive"}.get(op.get("action"),op.get("action"))
      if e["action"]!=action or e["method"]!="notion."+action or e["datasource"]!=op.get("target") or e["properties"]!=op.get("properties",{}) or str(e["source_line_id"])!=str(op.get("source_line_id","")): raise RuntimeError("phase8_operation_binding_invalid")
      if action!="create" and norm(e["page_id"])!=norm(op.get("page_id")): raise RuntimeError("phase8_page_binding_invalid")
      validate_evidence(db,cfg,e,e["page_id"],action=="create",require_active=a.action=="phase8-intent")
      key=e["operation_key"]; prior=db.execute("SELECT request_id,method,target,payload_hash,status,result_id FROM external_ops WHERE op_key=?",(key,)).fetchone()
      if a.action=="phase8-intent":
        if prior: raise RuntimeError("phase8_operation_already_recorded")
        unresolved=db.execute("SELECT status FROM external_ops WHERE target=? AND status IN ('started','unknown') LIMIT 1",(e["datasource"],)).fetchone()
        if unresolved: raise RuntimeError("phase8_datasource_unresolved_operation")
        db.execute("INSERT INTO external_ops(op_key,request_id,method,target,payload_hash,status,approval_id) VALUES(?,?,?,?,?,'started',?)",(key,e["request_id"],e["method"],e["datasource"],e["operation_hash"],e["approval_id"]))
        db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('phase8_intent',?,?)",(a.token,canonical({"operation_key":key,"operation_hash":e["operation_hash"],"request_id":e["request_id"]})))
        db.execute("INSERT INTO writer_audit(event,token,detail) VALUES('phase8_intent_evidence',?,?)",(a.token,canonical(e)))
      else:
        if not prior or prior[0]!=e["request_id"] or prior[1]!=e["method"] or prior[2]!=e["datasource"] or prior[3]!=e["operation_hash"]: raise RuntimeError("phase8_operation_identity_mismatch")
        expected="started" if a.action in ("phase8-finish","phase8-unknown") else "unknown"
        if prior[4]!=expected: raise RuntimeError("phase8_operation_transition_invalid")
        if a.action=="phase8-finish":
          if not e.get("result_id"): raise RuntimeError("phase8_result_id_required")
          db.execute("UPDATE external_ops SET status='succeeded',result_id=? WHERE op_key=? AND status='started'",(e["result_id"],key)); event="phase8_finished"
        elif a.action=="phase8-unknown":
          db.execute("UPDATE external_ops SET status='unknown',error='outcome_unknown' WHERE op_key=? AND status='started'",(key,)); event="phase8_unknown"
        else:
          if e.get("candidate_count")!=1 or e.get("readback_verified") is not True or e.get("observed_operation_hash")!=e["operation_hash"]: raise RuntimeError("phase8_reconcile_evidence_invalid")
          db.execute("UPDATE external_ops SET status='succeeded',result_id=?,error=NULL WHERE op_key=? AND status='unknown'",(e.get("result_id"),key)); event="phase8_reconciled"
        db.execute("INSERT INTO writer_audit(event,token,detail) VALUES(?,?,?)",(event,a.token,canonical({"operation_key":key,"result_id":e.get("result_id"),"operation_hash":e["operation_hash"]})))
      db.commit(); print(json.dumps({"ok":True,"action":a.action}));
    except Exception as exc:
      db.rollback(); print(json.dumps({"ok":False,"error":str(exc)})); sys.exit(2)
    finally: db.close()
if __name__=="__main__": main()
