# Private formal path mapping

The reference implementation was read from an isolated private baseline checkout. No private repository identifier or project-specific identifier is needed by this generic runtime.

| Private formal responsibility | Generic candidate extraction |
| --- | --- |
| `phase8_registered_sync_runtime.mjs`: enumerate linked records and invoke latest-sync planning | `src/formal-inventory.mjs` filters configured header/line data sources by registered state, company, freee ID and relation; `src/formal-sync.mjs` freezes a GET/plan snapshot before writes. |
| `phase8_latest_sync_adapter.mjs` and `phase8_sync_planner.py`: normalize current record, compare lines/totals and prepare minimal operations | `src/phase8_sync_planner.py` is copied from the baseline; `src/formal-sync.mjs` converts project-mapped Notion/freee responses to the planner's canonical input/output. |
| `production_notion_sync_writer.mjs`: `applyPhase8CrudPlan`, exact operation scope, write/read-back boundaries | `src/formal-sync.mjs` binds each planned operation to a one-use in-memory plan binder and configured page/data source/property scope; `src/formal-api-ports.mjs` serializes Notion property values and creates a short-lived operation-specific API client. |
| `shared_sqlite_writer_ledger.mjs`: lease, intent, finish, unknown, reconcile, audit/read-back records | `src/formal-sqlite-gate.py` uses the same existing tables (`writer_lease`, `writer_audit`, `external_ops`) and operation transitions. Active/revoked policy uses the existing `continuous_sync_policy_enabled` / `continuous_sync_policy_revoked` audit events; policy scope comes from local configuration. |
| `writer_gate.py`: verify persisted policy and evidence before each write intent/transition | The focused gate validates exact persisted scope, plan/operation hashes, identity, data source, page/relation and property allowlists; it rejects operation types outside the registered-sync contract. |
| `test_phase8_formal_host_e2e.mjs`: formal registered writer path | `tests/formal-flow-e2e.test.mjs` exercises the composition root, real SQLite gate, API client code, fake HTTP methods, two independent mappings, partial outcomes, restart/recovery and notification sink. |

## Deliberate extraction differences

- Private company IDs, Data Sources, property names, state labels, and policy values are supplied from local project config rather than compiled into the runtime.
- Only the registered continuous-sync gate/actions are extracted. Draft creation, freee POST/PUT, and unrelated retry flows are outside this path.
- A persistent operating policy is compared exactly on every run and write intent. The operator must locally approve a scope. This is an operational permission record, not a cryptographic identity mechanism.
- When the same Windows host confirms that the process owning a lease has exited, the next acquire records `stale_lease_reclaimed` before proceeding. A live or different-host lease remains blocking.
- The existing host's real credential provider, Windows Credential Manager integration, scheduled task, and production application permissions are not part of this candidate test harness.

No live endpoint, real policy, production SQLite, task schedule, or customer record was used by these tests.
