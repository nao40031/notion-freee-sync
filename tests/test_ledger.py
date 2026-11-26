import tempfile
import unittest
from pathlib import Path

from src.ledger import Ledger, LedgerError


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "isolated.sqlite"
        self.ledger = Ledger(self.path, lease_seconds=30)
        self.ledger.begin_run("run-1", "scope-hash", now=100)

    def tearDown(self):
        self.temp.cleanup()

    def test_persists_intent_unknown_and_never_replays_after_restart(self):
        self.ledger.acquire_lease("run-1", now=100)
        self.assertEqual(self.ledger.reserve_operation("run-1", "page:1", "body-hash", now=101), "intent")
        self.ledger.finish_operation("run-1", "page:1", "unknown", {"reason": "response_lost"}, now=102)

        restarted = Ledger(self.path)
        with self.assertRaisesRegex(LedgerError, "operation_unknown_no_replay"):
            restarted.reserve_operation("run-1", "page:1", "body-hash", now=103)
        self.assertEqual(restarted.get_operation("run-1", "page:1")["status"], "unknown")
        restarted.finish_run("run-1", "unknown", now=104)
        restarted.begin_run("run-2", "other-scope", now=105)
        restarted.acquire_lease("run-2", now=105)
        with self.assertRaisesRegex(LedgerError, "operation_unresolved_in_another_run"):
            restarted.reserve_operation("run-2", "page:1", "body-hash", now=106)
        self.assertEqual(restarted.reserve_operation("run-2", "page:2", "other-hash", now=106), "intent")
        with self.assertRaisesRegex(LedgerError, "unresolved_operations"):
            restarted.finish_run("run-2", "complete", now=107)

    def test_lease_excludes_a_second_run_and_is_released_at_completion(self):
        self.ledger.acquire_lease("run-1", now=100)
        self.ledger.begin_run("run-2", "scope-hash", now=100)
        with self.assertRaisesRegex(LedgerError, "lease_busy_or_manual_recovery_required"):
            self.ledger.acquire_lease("run-2", now=101)
        with self.assertRaisesRegex(LedgerError, "lease_busy_or_manual_recovery_required"):
            self.ledger.acquire_lease("run-2", now=200)
        self.ledger.finish_run("run-1", "complete", now=102)
        self.assertEqual(self.ledger.acquire_lease("run-2", now=103), 133)

    def test_scope_and_payload_reuse_are_rejected(self):
        with self.assertRaisesRegex(LedgerError, "request_scope_mismatch"):
            self.ledger.begin_run("run-1", "different-scope", now=100)
        self.ledger.acquire_lease("run-1", now=100)
        self.ledger.reserve_operation("run-1", "page:1", "body-hash", now=101)
        with self.assertRaisesRegex(LedgerError, "operation_payload_mismatch"):
            self.ledger.reserve_operation("run-1", "page:1", "different-body", now=102)

    def test_audit_history_survives_a_new_ledger_instance(self):
        self.ledger.acquire_lease("run-1", now=100)
        self.ledger.finish_run("run-1", "failed", now=101)
        events = Ledger(self.path).audit_events("run-1")
        self.assertEqual([event["event"] for event in events], ["run_started", "lease_acquired", "run_failed"])


if __name__ == "__main__":
    unittest.main()
