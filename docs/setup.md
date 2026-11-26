# Host integration and setup

This candidate provides reusable workflow code and API/ledger contracts. The adopting project supplies credential storage, approval UI, OAuth redirect handling, task scheduling and any external notification destination. No production installer or Windows Credential Manager adapter is included.

## 1. Prepare an isolated project

1. Copy `config.example.json` to a protected directory outside the Git checkout. Replace placeholders with the company's freee ID, four document/line data sources, relation names, Notion property names and types, local policy ID, allowed actions/properties, matching keys and invoice-draft mapping.
2. Store the shared SQLite file and sanitized logs beside the protected runtime configuration. Back up the SQLite file while no run is active. Do not copy production credentials or customer records into fixtures.
3. Use a dedicated Notion integration with only the required data sources shared, and a freee API credential limited to the read/write operations the host actually needs. Registered synchronization uses freee GET and Notion writes; first registration additionally requires freee POST.

## 2. Provide OAuth token storage

Construct `createOAuthTokenProvider` separately for Notion and freee. Supply each provider a `store` implementing:

- `load()` and `save(tokenRecord)` backed by a host-protected credential store;
- `withLock(async callback)`, a cross-process exclusive lock around refresh-token read/rotation. Re-read the token after acquiring the lock, as the provider does.

Do not put client secrets or token values in JSON configuration, command-line arguments, environment dumps, logs, SQLite audit records, or Git. The host owns the redirect URI and authorization-code capture. `exchangeCode({code,redirectUri})` exchanges a one-time code; `getAccessToken()` returns a current token or refreshes under the store lock. The candidate does not implement the browser callback or Credential Manager storage adapter. A missing/invalid refresh token fails with a sanitized error and requires host-managed reauthorization.

## 3. Configure and approve registered synchronization

Create the formal API ports and service from `src/formal-api-ports.mjs` and `src/formal-sync.mjs`, pointing `configPath` and `dbPath` to protected local files. Before first apply, the operator must review and approve the exact configured scope using the host's normal interactive authorization surface. Call the gate's policy-approval operation while holding its SQLite lease, then release in `finally`. The gate records the scope in the existing audit table; any company, database, action, property or batch-limit mismatch stops the run.

Use the same service for single-document and sequential batch sync. It fetches all plans before its first mutation, logs operation intent, performs the exact scoped Notion operation, GET-verifies it, and releases its lease. Use `recoverUnknown()` only for exact read-back reconciliation. It never replays a mutation.

## 4. First registration and invoice draft generation

For a first quotation or invoice registration, prepare an immutable request containing the company/partner/document identity, exact freee body, existing Notion header/line page IDs, data sources and property patches. The host must present this scope to the user and return a short-lived operation authorization through `approvalProvider`. Run `runFirstRegistration` with the same `createGateLedger` ledger, API ports, and a duplicate-check `preflight`. The function rechecks preflight after approval, writes the freee POST intent before POST, GET-verifies the result, and updates only the supplied existing Notion pages. If POST outcome is uncertain, stop and reconcile by a unique, identity-verified GET; never post again automatically.

For quote-to-invoice draft generation, map the draft header/line data sources, typed properties and source relations under `notion.invoiceDraft`. Use `createLedgerBackedInvoiceDraftRuntime` with the same formal Notion API port, ledger, freee GET port, and operation-scoped approval provider. A generation request ID must remain stable on resume. A conflicting payload under the same request ID is rejected.

## 5. Monitoring and recovery

Keep `src/local-monitor.mjs` events sanitized. The host's notification sink should alert only for failure or unknown, suppress duplicate alerts by event fingerprint, and never trigger a business operation. Logs and notification state stay outside Git. A notification error must be recorded separately and must not cause a business mutation retry.

If a process exits, inspect the ledger status and exact target via API GET before restarting. A live lease blocks a second run. A stale lease is reclaimed only when the same host can confirm the owner process has exited. An operation marked `started` or `unknown` remains blocked until exact read-back confirms one result; missing or multiple candidates require manual investigation.

## 6. Scheduled/manual one-shot entry

Create a host-owned JavaScript module outside this repository that exports `createSyncHost()` and returns the configured `service` and optional `emit` function. The host module loads local config, secure OAuth stores, real API ports, the persistent SQLite path, and the deployment-approved policy. Invoke the same one-shot entry manually or from the OS scheduler:

```sh
npm run run:sync -- --host-module /absolute/path/to/protected-host.mjs
```

The wrapper runs exactly once, emits sanitized start/completion/failure events, and exits nonzero on a failed run. It does not create or enable a schedule. The registered sync service acquires the SQLite single-writer lease, so overlapping scheduler/manual invocations fail closed. Keep scheduler registration, account, working directory, log retention and stop/restart procedure in the adopting project's operational runbook.

## 7. Rollout checks

Start with fake API transports and a new temporary SQLite file. Verify scope, inventory, totals/tax, relations, one mapped project, then a second distinct mapping, notification sink, restart and restore procedures. Before live rollout, separately review API app permissions, credential-store implementation, callback handling, operator authorization, network access, task account, working directory, schedule, backup, alert destination and rollback. This candidate's tests do not certify those deployment-specific controls.
