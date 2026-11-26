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

The sync planner is the Private baseline's `phase8_sync_planner.py`. Its operation format is consumed by the generic runtime; project-specific values are supplied through `config.json`. The gate uses the existing `writer_lease`, `writer_audit`, and `external_ops` tables. Active/revoked operating policy is represented by the existing `continuous_sync_policy_enabled` / `continuous_sync_policy_revoked` audit events; no policy table or separate journal is added.

## Authorization and data safety

The operator approves a complete local policy scope before continuous sync is enabled. The SQLite gate checks that scope on each write intent; the runner also checks scope equality before inventory reads. The API adapter requires an operation-specific allowlist and page/data-source binding for each mutation. This policy is an operational authorization control, not proof of a person's cryptographic identity. Host operating-system permissions and credential protections remain required.

Unknown API outcomes are recorded and stop further writes. A later recovery run reads the exact target (or searches for a uniquely related line creation), and records success only when the operation's expected properties and relation are observed. Ambiguous or missing read-back remains unresolved. No retry of a create/update/archive is performed from an unknown state.

## Verification boundary

The formal-flow E2E uses two fictional mapping configurations, fake HTTP implementations of the Notion and freee APIs, and per-test temporary SQLite. It does not call live APIs, mutate a production database, configure an external notification destination, or register a scheduled task. The API client method/path and serialized Notion property payload are exercised. Real OAuth providers and the host's secure credential store still need deployment-specific wiring.
