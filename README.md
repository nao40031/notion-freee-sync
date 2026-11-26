# Notion × freee Sync Core

Reusable JavaScript and Python components for quotation and invoice workflows between Notion and freee. This repository is an isolated release candidate: the included tests use fictional projects, fake API transports, and temporary SQLite databases. It has not been connected to a live Notion or freee workspace and is not a ready-made production installer.

## Included workflows

### Registered-document synchronization

`createFormalSyncService` composes the Notion/freee API clients, configured inventory, the baseline-derived sync planner, operation-scoped Notion transport, the SQLite lease/audit gate, read-back, unknown reconciliation, and local event monitor. Single-document and sequential batch runs use the same planner and writer path.

Before writing, the runner verifies the active local policy scope, enumerates only registered quotations and invoices, validates IDs, data sources, relations and totals, fetches every source snapshot, and builds the full run plan. It then records each operation before calling Notion, verifies the result with GET, and stops on an uncertain result. Unknown mutations are reconciled by read-back; they are not sent again. The workflow does not create document headers, hard-delete pages, or write business data to freee.

### First quotation/invoice registration

`runFirstRegistration` supports one explicitly approved quotation or invoice POST to freee, followed by GET verification and ID registration on the supplied existing Notion header and line pages. The host supplies the operation-specific approval provider, duplicate preflight, API ports, and the same SQLite ledger used by registered synchronization. A POST with an uncertain response is recorded as unknown and is never retried. A separate read-only reconciliation entry can bind a unique GET result to the original request.

### Quote-to-invoice draft generation

`generateInvoiceDraft` validates source identity, line arithmetic, tax rates, totals and rounding before generating an independent invoice draft. `createLedgerBackedInvoiceDraftRuntime` binds it to the shared SQLite lease and external-operation ledger, mapped Notion properties, request keys, Relations, operation-scoped approval, and read-back. Unknown creates are resolved only when a unique matching page can be verified; otherwise processing stops for manual recovery.

### OAuth and operation support

`createOAuthTokenProvider` exchanges authorization codes and refreshes tokens through a host-owned secure token store. The store must implement a cross-process `withLock` around refresh-token reads and writes; this is needed when a scheduled run and manual run can overlap. The repository does not ship a platform credential-store adapter or an interactive callback server. `src/local-monitor.mjs` provides sanitized local events and a notification sink port; a host chooses and secures the actual destination.

## Project configuration

Copy `config.example.json` outside the repository and supply the target company's freee ID, Notion data sources, property names/types, relation mappings, state values, policy scope, and invoice-draft mappings. Keep credentials, local configuration, SQLite, logs and notification state outside Git. The sample contains placeholders only. A host must provide a protected config/SQLite path, token store, OAuth registration flow, and explicit operation/policy approval interface.

The persistent operating policy must exactly match the configured company, databases, document types, actions, property allowlists and batch limit. Policy approval is an operational authorization boundary; it is not a cryptographic identity assertion and does not replace the host OS or API permissions.

## Local checks

Requires Node.js with built-in `node:test` and Python 3. No third-party runtime package is required by the core candidate.

```sh
npm test
npm run test:formal-sync
npm run scan
```

The integrated registered-sync E2E exercises two fictional project mappings. The registration suite exercises first quotation registration with a second mapping, POST-unknown reconciliation, quote-to-invoice generation, OAuth refresh token rotation, and the shared ledger-backed draft writer. All external requests are faked; each ledger test uses a temporary SQLite database.

## Security and verification limits

- No real API calls, live OAuth, Windows credential store, scheduled task, production SQLite, or external email delivery is verified by this candidate.
- A host must implement the token store's cross-process lock, secure secret storage, redirect/callback handling, regular operator authorization, notifications, and scheduler lifecycle.
- Initial freee registration and invoice draft creation require an explicit host-provided operation approval. Registered sync requires a separately approved bounded operating policy.
- Never retry a create after an unknown result. Read back and reconcile one exact candidate; otherwise stop.
- Do not widen policy, targets, data sources, properties, or actions just to make a plan pass.

See [setup](docs/setup.md), [design](docs/design.md), [function matrix](docs/function-matrix.md), [Private path map](docs/private-formal-path-map.md), and [release checklist](docs/release-checklist.md). `LICENSE.preview` is a proposed MIT notice and is not a confirmed rights clearance.
