# Capability inventory

This package provides configurable Notion and freee workflows. Project IDs, credentials, business labels, numbering rules, and deployment settings belong in the adopting project's private configuration.

| Capability | Public implementation | Scope and verification |
|---|---|---|
| Notion/freee API | `src/api-clients.mjs`, `src/formal-api-ports.mjs` | Scoped GET, one-shot quotation/invoice POST, and operation-bound Notion updates. Fake transports only. |
| OAuth lifecycle | `src/oauth-token-provider.mjs`, `src/loopback-oauth-callback.mjs` | Authorization-code and refresh flow, state validation, and refresh locking; real consent remains adopter setup. |
| Windows credentials | `src/windows-credential-store.mjs` | DPAPI-backed storage adapter and ACL handling; host tests use an injected encryption provider. |
| Initial registration | `src/draft-builders.mjs`, `src/first-registration.mjs`, `src/formal-registration.mjs` | Quote/invoice request assembly, bounded approval, duplicate preflight, one POST, GET read-back, existing-page ID updates, and unknown stop. |
| Invoice draft from quote | `src/invoice-draft.mjs`, `src/invoice-draft-runtime.mjs` | Validates totals/relations, stable request identity, durable intent and read-back. |
| Registered-document sync | `src/formal-inventory.mjs`, `src/formal-sync.mjs`, `src/phase8_sync_planner.py` | Sequential quote/invoice inventory, full-plan preflight, scoped mutations, line reconciliation, no-op and unknown recovery. |
| Durable ledger | `src/formal-sqlite-gate.py` | SQLite lease, audit, external-operation state, additive schema compatibility, and fail-closed transitions. |
| Monitoring and email | `src/local-monitor.mjs`, `src/monitor.mjs`, `src/gmail-api-notifier.mjs` | Sanitized event logging, incident dedupe, optional Gmail API sender; live delivery is unverified. |
| Scheduled execution | `src/scheduled-runner.mjs`, `scripts/run-configured-sync.mjs`, `scripts/manage-windows-sync-task.ps1` | One-shot runner and disabled-by-default Windows Task Scheduler management. |
| Project mapping | `config.example.json` and injected host ports | Company, data sources, property names, tax rules and policy scope are configuration. |
| Verification/docs | `tests/`, `docs/`, `scripts/scan.mjs` | Fictional projects, fake API transports, temporary SQLite and history/content scans. |

This is an implementation inventory, not a claim of live-account or production-host certification. See [integration compatibility](integration-compatibility.md) for migration boundaries.
