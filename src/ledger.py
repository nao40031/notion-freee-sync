"""Small SQLite ledger for serialized sync runs and one-shot operations.

The caller must keep the database in a private runtime directory. This module
stores intent before an external write and never replays an unknown operation.
"""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


class LedgerError(RuntimeError):
    pass


class Ledger:
    def __init__(self, path: str | Path, *, lease_seconds: int = 300) -> None:
        if lease_seconds < 1:
            raise ValueError("lease_seconds must be positive")
        self.path = str(path)
        self.lease_seconds = lease_seconds
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=10000")
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        db = self._connect()
        try:
            yield db
        finally:
            db.close()

    def _initialize(self) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sync_run (
                    request_id TEXT PRIMARY KEY,
                    scope_hash TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('running','complete','failed','unknown')),
                    started_at REAL NOT NULL,
                    finished_at REAL
                );
                CREATE TABLE IF NOT EXISTS sync_lease (
                    lease_name TEXT PRIMARY KEY,
                    request_id TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    FOREIGN KEY(request_id) REFERENCES sync_run(request_id)
                );
                CREATE TABLE IF NOT EXISTS sync_operation (
                    request_id TEXT NOT NULL,
                    operation_key TEXT NOT NULL,
                    payload_hash TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('intent','complete','unknown','failed')),
                    created_at REAL NOT NULL,
                    finished_at REAL,
                    result_json TEXT,
                    PRIMARY KEY(request_id, operation_key),
                    FOREIGN KEY(request_id) REFERENCES sync_run(request_id)
                );
                CREATE TABLE IF NOT EXISTS sync_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    request_id TEXT NOT NULL,
                    event TEXT NOT NULL,
                    detail_json TEXT NOT NULL,
                    occurred_at REAL NOT NULL,
                    FOREIGN KEY(request_id) REFERENCES sync_run(request_id)
                );
            """)

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def begin_run(self, request_id: str, scope_hash: str, *, now: float | None = None) -> None:
        if not request_id or not scope_hash:
            raise LedgerError("request_id_and_scope_hash_required")
        now = time.time() if now is None else now
        with self._transaction() as db:
            prior = db.execute("SELECT scope_hash,status FROM sync_run WHERE request_id=?", (request_id,)).fetchone()
            if prior:
                if prior["scope_hash"] != scope_hash:
                    raise LedgerError("request_scope_mismatch")
                raise LedgerError("request_already_recorded")
            db.execute("INSERT INTO sync_run VALUES(?,?,?,?,NULL)", (request_id, scope_hash, "running", now))
            self._audit(db, request_id, "run_started", {"scope_hash": scope_hash}, now)

    def acquire_lease(self, request_id: str, lease_name: str = "sync", *, now: float | None = None) -> float:
        now = time.time() if now is None else now
        expires = now + self.lease_seconds
        with self._transaction() as db:
            run = db.execute("SELECT status FROM sync_run WHERE request_id=?", (request_id,)).fetchone()
            if not run or run["status"] != "running":
                raise LedgerError("run_not_active")
            existing = db.execute("SELECT request_id,expires_at FROM sync_lease WHERE lease_name=?", (lease_name,)).fetchone()
            if existing:
                raise LedgerError("lease_busy_or_manual_recovery_required")
            db.execute("INSERT INTO sync_lease VALUES(?,?,?)", (lease_name, request_id, expires))
            self._audit(db, request_id, "lease_acquired", {"lease_name": lease_name, "expires_at": expires}, now)
        return expires

    def reserve_operation(self, request_id: str, operation_key: str, payload_hash: str, *, now: float | None = None) -> str:
        now = time.time() if now is None else now
        with self._transaction() as db:
            lease = db.execute("SELECT request_id,expires_at FROM sync_lease WHERE lease_name='sync'").fetchone()
            if not lease or lease["request_id"] != request_id or lease["expires_at"] <= now:
                raise LedgerError("active_lease_required")
            run = db.execute("SELECT status FROM sync_run WHERE request_id=?", (request_id,)).fetchone()
            if not run or run["status"] != "running":
                raise LedgerError("run_not_active")
            prior = db.execute("SELECT payload_hash,status FROM sync_operation WHERE request_id=? AND operation_key=?", (request_id, operation_key)).fetchone()
            if prior:
                if prior["payload_hash"] != payload_hash:
                    raise LedgerError("operation_payload_mismatch")
                if prior["status"] == "unknown":
                    raise LedgerError("operation_unknown_no_replay")
                if prior["status"] != "failed":
                    raise LedgerError("operation_already_reserved")
                db.execute("UPDATE sync_operation SET status='intent',created_at=?,finished_at=NULL,result_json=NULL WHERE request_id=? AND operation_key=?", (now, request_id, operation_key))
                state = "resumed_after_confirmed_failure"
            else:
                db.execute("INSERT INTO sync_operation VALUES(?,?,?,?,?,NULL,NULL)", (request_id, operation_key, payload_hash, "intent", now))
                state = "intent"
            self._audit(db, request_id, "operation_" + state, {"operation_key": operation_key, "payload_hash": payload_hash}, now)
            return state

    def finish_operation(self, request_id: str, operation_key: str, status: str, result: dict | None = None, *, now: float | None = None) -> None:
        if status not in {"complete", "unknown", "failed"}:
            raise LedgerError("operation_status_invalid")
        now = time.time() if now is None else now
        with self._transaction() as db:
            row = db.execute("SELECT status FROM sync_operation WHERE request_id=? AND operation_key=?", (request_id, operation_key)).fetchone()
            if not row or row["status"] != "intent":
                raise LedgerError("operation_intent_required")
            encoded = json.dumps(result or {}, sort_keys=True, separators=(",", ":"))
            db.execute("UPDATE sync_operation SET status=?,finished_at=?,result_json=? WHERE request_id=? AND operation_key=?", (status, now, encoded, request_id, operation_key))
            self._audit(db, request_id, "operation_" + status, {"operation_key": operation_key, "result": result or {}}, now)

    def finish_run(self, request_id: str, status: str, *, now: float | None = None) -> None:
        if status not in {"complete", "failed", "unknown"}:
            raise LedgerError("run_status_invalid")
        now = time.time() if now is None else now
        with self._transaction() as db:
            row = db.execute("SELECT status FROM sync_run WHERE request_id=?", (request_id,)).fetchone()
            if not row or row["status"] != "running":
                raise LedgerError("run_not_active")
            db.execute("UPDATE sync_run SET status=?,finished_at=? WHERE request_id=?", (status, now, request_id))
            db.execute("DELETE FROM sync_lease WHERE request_id=?", (request_id,))
            self._audit(db, request_id, "run_" + status, {}, now)

    def get_operation(self, request_id: str, operation_key: str) -> dict | None:
        with self._connection() as db:
            row = db.execute("SELECT * FROM sync_operation WHERE request_id=? AND operation_key=?", (request_id, operation_key)).fetchone()
            return dict(row) if row else None

    def audit_events(self, request_id: str) -> list[dict]:
        with self._connection() as db:
            return [dict(row) for row in db.execute("SELECT event,detail_json,occurred_at FROM sync_audit WHERE request_id=? ORDER BY id", (request_id,))]

    @staticmethod
    def _audit(db: sqlite3.Connection, request_id: str, event: str, detail: dict, now: float) -> None:
        db.execute("INSERT INTO sync_audit(request_id,event,detail_json,occurred_at) VALUES(?,?,?,?)",
                   (request_id, event, json.dumps(detail, sort_keys=True, separators=(",", ":")), now))
