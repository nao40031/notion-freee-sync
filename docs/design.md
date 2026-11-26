# Registered-document sync design

## Runtime path

`createFormalSyncService` composes the shared API clients, inventory lister, sync planner, operation-scoped Notion API port, formal SQLite gate, and event monitor:

1. Check that the active persisted policy exactly equals the local project scope.
2. Acquire the single-writer lease.
3. Enumerate only registered quotation/invoice headers, and resolve lines through their configured relation.
4. Validate company, document type/ID/number, header and line data sources, existing relations, duplicate identities, and policy limits.
5. GET all Notion pages and freee documents and calculate all plans before the first write.
6. For each planned operation, check its configured action/property/page/data-source scope, persist its intent, call the normal Notion API client with that exact operation scope, GET the result, and finish or mark it unknown in SQLite.
7. Stop on unknown. Recovery only performs read-back and reconciliation; it never repeats a mutation.
8. Emit sanitized batch/document events to the local monitor and release the lease.

The sync planner consumes normalized, project-mapped inputs and returns a bounded operation plan. Project-specific values are supplied through `config.json`. The gate uses the `writer_lease`, `writer_audit`, and `external_ops` tables. Active/revoked operating policy is represented by audit events; no separate policy table or journal is added.

## Authorization and data safety

The operator approves a complete local policy scope before continuous sync is enabled. The SQLite gate checks that scope on each write intent; the runner also checks scope equality before inventory reads. The API adapter requires an operation-specific allowlist and page/data-source binding for each mutation. This policy is an operational authorization control, not proof of a person's cryptographic identity. Host operating-system permissions and credential protections remain required.

Unknown API outcomes are recorded and stop further writes. A later recovery run reads the exact target (or searches for a uniquely related line creation), and records success only when the operation's expected properties and relation are observed. Ambiguous or missing read-back remains unresolved. No retry of a create/update/archive is performed from an unknown state.

## Verification boundary

The formal-flow E2E uses two fictional mapping configurations, fake HTTP implementations of the Notion and freee APIs, and per-test temporary SQLite. It does not call live APIs, mutate a production database, configure an external notification destination, or register a scheduled task. The API client method/path and serialized Notion property payload are exercised. Real OAuth providers and the host's secure credential store still need deployment-specific wiring.

## Initial registration and invoice drafts

`src/first-registration.mjs` is a single-document flow for quotation or invoice POST. The host supplies a duplicate preflight and a short-lived operation-scoped authorization. The flow hashes the exact freee request body, checks authorization against company, partner, document number, type, existing Notion page IDs, data sources, and property sets, repeats preflight after approval, then records the freee operation intent in the same `external_ops` table before POST. A successful response is not accepted until freee GET confirms document identity, partner, number, line identities/content, and monetary totals. Only the supplied existing Notion pages can be updated. Each Notion update gets an intent and read-back; any uncertain result stops processing. The separate reconciliation function has no freee POST port.

`src/invoice-draft.mjs` preserves the baseline's exact-decimal quote validation and request-idempotent generation algorithm. `src/invoice-draft-runtime.mjs` adapts it to mapped Notion data sources and properties, source quote relations, the same SQLite lease and `external_ops` transitions, and the host approval callback. Before header creation it stores the expected request/hash in the existing audit stream. This allows a restart to query the request key and reconcile a single exact read-back; ambiguous results stop. Line creates use stable request/line keys and similarly reconcile only an exact matching page.

`src/oauth-token-provider.mjs` provides authorization-code exchange and refresh-token rotation without logging secrets. Storage is injected by the host and must implement `load`, `save`, and a cross-process `withLock` operation. The provider re-reads credentials after taking the lock so a concurrent scheduled process does not refresh with a rotated-away token. Secure platform storage and OAuth callback UI remain host responsibilities.

The `external_ops` actions added to `src/formal-sqlite-gate.py` and the matching `createGateLedger` methods in `src/formal-sync.mjs` share the registered-sync lease, audit and durable operation table; no separate journal or database was introduced. `src/formal-registration.mjs` wires first registration to the same API-client composition and ledger, and the freee client exposes only a one-shot quotation/invoice POST. A deployment-specific executable host, real secure approval provider, Windows credential store, and live API integration remain outside this candidate.

`src/scheduled-runner.mjs` wraps exactly one invocation with sanitized lifecycle events. `scripts/run-configured-sync.mjs` loads a host module from outside the repository and executes its configured service once; the service itself owns the SQLite lease. This provides an OS-scheduler entry point without putting credentials or project settings in the Public repository. Task registration/enablement remains a deployment operation.
