# Notion × freee Sync Core

Reusable JavaScript and Python components for quotation and invoice workflows between Notion and freee. This is the v0.2.1 release candidate. Tests use fictional projects, fake API transports, and temporary SQLite databases. It has not been connected to a live Notion or freee workspace and is not a ready-made production installer.

## Included workflows

### Registered-document synchronization

`createFormalSyncService` composes the Notion/freee API clients, configured inventory, the baseline-derived sync planner, operation-scoped Notion transport, the SQLite lease/audit gate, read-back, unknown reconciliation, and local event monitor. Single-document and sequential batch runs use the same planner and writer path.

Before writing, the runner verifies the active local policy scope, enumerates only registered quotations and invoices, validates IDs, data sources, relations and totals, fetches every source snapshot, and builds the full run plan. It then records each operation before calling Notion, verifies the result with GET, and stops on an uncertain result. Unknown mutations are reconciled by read-back; they are not sent again. The workflow does not create document headers, hard-delete pages, or write business data to freee.

`service.run({ noOpOnly: true, expectedDocuments })` enables a no-op-only guard. `expectedDocuments` must be a non-empty array of `{ company_id, document_type, freee_id }` identities and must exactly match the registered inventory (no missing, extra, duplicate, or invalid identities). Under the same SQLite lease, the service prepares every document before allowing the run to finish; if any plan contains an operation, the whole run throws before creating any operation intent or sending a Notion mutation. The default `run()` behavior is unchanged. This guarded mode is **not a fully read-only execution**: it performs Notion/freee GET requests and acquires/releases the SQLite lease; lease bookkeeping may write SQLite state. It sends no business mutation when the guard passes, and stops on a detected difference.

### First quotation/invoice registration

`runFirstRegistration` supports one explicitly approved quotation or invoice POST to freee, followed by GET verification and ID registration on the supplied existing Notion header and line pages. The host supplies the operation-specific approval provider, duplicate preflight, API ports, and the same SQLite ledger used by registered synchronization. A POST with an uncertain response is recorded as unknown and is never retried. A separate read-only reconciliation entry can bind a unique GET result to the original request.

`buildFreeeCreatePayload` maps a normalized, unregistered draft into a quotation or invoice request body, checking company scope, dates, line arithmetic, tax rates, and totals before an adapter can submit it. `buildProjectTaskLines` maps explicitly selected project tasks through configured project and price relations. Both are pure builders: they do not call an API, approve an operation, or write to the ledger. Exact decimal arithmetic is used for money checks and configured whole-currency rounding.

### Quote-to-invoice draft generation

`generateInvoiceDraft` validates source identity, line arithmetic, tax rates, totals and rounding before generating an independent invoice draft. `createLedgerBackedInvoiceDraftRuntime` binds it to the shared SQLite lease and external-operation ledger, mapped Notion properties, request keys, Relations, operation-scoped approval, and read-back. Unknown creates are resolved only when a unique matching page can be verified; otherwise processing stops for manual recovery.

### Host connections

`createOAuthTokenProvider` exchanges authorization codes and refreshes tokens through a store with a cross-process `withLock`. The candidate includes `WindowsDpapiTokenStore`, which encrypts token records with Windows CurrentUser DPAPI, protects its directory ACL, atomically replaces token files, and serializes access. It also includes a provider-neutral `startLoopbackOAuthCallback` that binds to IPv4 loopback and validates a one-time state before returning a code. OAuth app registration, consent, client-secret provisioning and real-account validation remain adopter setup.

`src/local-monitor.mjs` provides sanitized local events and duplicate suppression. `createGmailApiNotifier` is an optional Gmail API sender that uses an injected OAuth token provider and explicit sender/recipient settings. Configure only the `gmail.send` scope; no mailbox or destination is embedded in the repository.

`npm run run:sync -- --host-module <absolute-path-outside-repository>` is the single-run entry point for a scheduler or operator. The external host module exports `createSyncHost()` and returns `{ service, emit }`; it owns project configuration, API clients, official operator-approval surface and event delivery. The service's SQLite lease rejects concurrent business runs. The wrapper runs once and exits. `scripts/manage-windows-sync-task.ps1 -Mode plan` previews a weekday Task Scheduler configuration. Registering a task requires explicit `-Apply` and registers it disabled; `-Mode stop` and `-Mode resume` explicitly disable or enable an existing task. Actual registration and enablement are deployment actions and are not performed by the tests.

## Project configuration

Copy `config.example.json` outside the repository and supply the target company's freee ID, Notion data sources, property names/types, relation mappings, state values, policy scope, and invoice-draft mappings. Keep credentials, local configuration, SQLite, logs and notification state outside Git. The sample contains placeholders only. On Windows, the included DPAPI token store can protect OAuth tokens; the adopter still registers the OAuth app, grants consent, configures the callback, provisions client credentials outside the repository, and supplies the official operation/policy approval interface.

The persistent operating policy must exactly match the configured company, databases, document types, actions, property allowlists and batch limit. Policy approval is an operational authorization boundary; it is not a cryptographic identity assertion and does not replace the host OS or API permissions.

The candidate uses run-scoped synchronization identities, preserves existing ledger tables when opening a database, and does not convert prior approvals or unresolved operations into new authorization. See the public [capability inventory](docs/capability-inventory.md) and [integration compatibility](docs/integration-compatibility.md) for supported interfaces and limits.

## Local checks

Requires Node.js with built-in `node:test` and Python 3. No third-party runtime package is required by the core candidate.

```sh
npm test
npm run test:formal-sync
npm run scan
```

The integrated registered-sync E2E exercises two fictional project mappings. The registration suite exercises first quotation registration with a second mapping, POST-unknown reconciliation, quote-to-invoice generation, OAuth refresh token rotation, and the shared ledger-backed draft writer. Draft-builder tests cover quote/invoice payload mapping, invalid scope/totals, explicit task/price relation mapping, and half-cent rounding. The host-integration suite covers fake-DPAPI storage and lock contention, callback-to-token-exchange composition, sanitized Gmail API request construction, and Task Scheduler plan generation. The callback listener and actual Windows DPAPI/ACL behavior are not exercised against the host OS. All external API requests are faked; each ledger test uses a temporary SQLite database.

### Private registered-sync connection

For a Private host, pin this package to the approved immutable Public commit and inject the existing project config, OAuth/DPAPI token providers, Notion/freee transports, persistent monitor/notifier, and the already-approved SQLite path into `createFormalSyncService`. Keep the existing policy identity and exact scope; compare them before execution. Route scheduled sync through `service.run()` and map complete to exit 0 and partial/unknown or thrown errors to non-zero. Use `noOpOnly` only with an explicit expected document list. Keep first registration and invoice-draft generation on their separate per-operation approval routes. Never point a candidate at the production database or task until a separate cutover approval and rollback plan are in place.

## License

MIT. Copyright (c) 2026 Oshino. See [LICENSE](LICENSE) and [third-party notices](THIRD-PARTY-NOTICES.md).

## Security and verification limits

- No real API calls, live OAuth consent, Windows DPAPI/ACL under an adopter account, actual Task Scheduler registration/execution, production SQLite, or external email delivery is verified by this candidate.
- The generic host adapters provide secure-storage, callback, notification and schedule-management code; adopters still provision provider credentials and configuration and validate them under the target Windows account.
- Initial freee registration and invoice draft creation require an explicit host-provided operation approval. Registered sync requires a separately approved bounded operating policy.
- Never retry a create after an unknown result. Read back and reconcile one exact candidate; otherwise stop.
- Do not widen policy, targets, data sources, properties, or actions just to make a plan pass.

See [setup](docs/setup.md), [design](docs/design.md), [function matrix](docs/function-matrix.md), [integration compatibility](docs/integration-compatibility.md), and [release checklist](docs/release-checklist.md).
