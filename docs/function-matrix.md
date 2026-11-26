# Private baseline to generic candidate function matrix

Baseline: an approved Private reference commit. The candidate does not copy the Private repository history or any adopting project's configuration.

| Capability | Private baseline responsibility | Generic candidate | Evidence / remaining host work |
| --- | --- | --- | --- |
| Notion and freee API | Phase 6/8 direct clients and production transports | `src/api-clients.mjs`, `src/formal-api-ports.mjs` | Fake HTTP E2E exercises GET, Notion scoped PATCH, and freee quotation/invoice POST. Live credentials and real HTTP are not tested. |
| OAuth | Existing project token/refresh handling | `src/oauth-token-provider.mjs` | Authorization-code exchange, refresh rotation, cross-process lock contract and sanitized errors tested. Host must implement secure token store, lock and callback. |
| Registered quote/invoice inventory | Phase 8 registered-document list | `src/formal-inventory.mjs` | Two fictional DB mappings, duplicate/out-of-scope and pagination cases in `tests/formal-flow-e2e.test.mjs` and batch tests. |
| Latest-value synchronization | Phase 6/8 planner, adapter and writer | `src/phase8_sync_planner.py`, `src/formal-sync.mjs` | Mixed quote/invoice batch, line ID reissue/add/archive, no-op, relations, totals, unknown and restart recovery are covered by integrated E2E. |
| Persistent lease and operation ledger | `shared_sqlite_writer_ledger.mjs`, `writer_gate.py` | `src/formal-sqlite-gate.py` plus `createGateLedger` | Same table model (`writer_lease`, `writer_audit`, `external_ops`); temp SQLite tests cover leases, intent/finish/unknown/reconcile and audit. |
| Initial freee registration | Phase 5/7 approved quote/invoice POST and ID return | `src/first-registration.mjs`, `src/formal-registration.mjs`, `createFreeeRegistrationClient` | Fake API/SQLite E2E verifies scoped approval, repeat preflight, one-shot POST, GET/read-back, existing page updates and unknown no-repost. Host supplies real approval provider and duplicate preflight. |
| Quote-to-invoice draft | Phase 7 quote validation and invoice draft generation | `src/invoice-draft.mjs`, `src/invoice-draft-runtime.mjs` | Decimal/tax validation, quote-line relations, stable request keys, same SQLite ledger and lost-response recovery are covered with temporary SQLite and fake Notion. |
| Monitoring and notification | Private run events/unknown reporting | `src/local-monitor.mjs`, `src/monitor.mjs` | Local and fake sink tests cover outcome classification, duplicate suppression, recovery reset and notification failure isolation. External destination is not configured. |
| Scheduled execution | Private Windows runner/Task Scheduler configuration | `src/scheduled-runner.mjs`, `scripts/run-configured-sync.mjs`, and `npm run run:sync` | One-shot scheduler/manual entry, sanitized result events, exit status, and fake external host execution are tested. Actual scheduler registration, credentials and cadence remain host operations. |
| Project rules and mappings | A seven-database project mapping, labels and property names | `config.example.json` plus injected ports | Synthetic project configurations show source/property names are externalized. The reference project's mapping is intentionally excluded. |
| Security boundaries | Existing explicit operation approval, scopes, unknown stop and recovery | Config-bound policy, exact operation approvals, API scopes, SQLite intents and read-back | Candidate tests are isolated. A host must provide an authentic operator approval surface and production credentials/permissions; the generic code does not establish identity. |

## Acceptance boundary

The current candidate is suitable for a source review and further integration, not a claim of production readiness. A clean `npm test` and `npm run scan` show only the candidate's isolated code and history passed those checks. Live OAuth, host approval UI, secure store, production API permissions, deployment monitoring, and scheduled production execution remain unverified.
