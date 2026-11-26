# Notion ↔ freee Sync Core (isolated integration candidate)

This repository contains reusable synchronization components for quotations and invoices that are already registered in freee and linked to existing Notion pages. It is an isolated development candidate. It is not a production installer and has not been connected to a live workspace.

## Integrated registered-document flow

`createFormalSyncService` composes the existing API clients, registered-document inventory, the Private Phase 8 synchronization planner, the operation-scoped Notion transport, a SQLite lease/audit gate, read-back verification, recovery, and the local monitor. The single-document and batch execution use the same sequential runner. It uses the local monitor by default; a deployment can inject another event sink. Project identifiers, Notion data sources, property names/types, approved operations, and line matching rules come from a local configuration file.

Before any mutation, the runner verifies that the active SQLite policy exactly matches the configured company, data sources, document types, operations, property allowlists, and batch limit; enumerates registered records; validates their page/data-source/relation identities; retrieves all freee and Notion snapshots; and prepares every plan. It then applies only planned operations. Each operation is recorded before the API call and confirmed by a Notion GET. An uncertain result is reconciled by read-back; it is never resent automatically. A lease prevents concurrent runs.

The standard Notion client is given a short-lived operation-specific scope for each planned write. The persistent policy is recorded in the existing SQLite audit events and must first be approved in the local Windows terminal by its operator. No separate policy table or journal is added. That local policy is a deployment control; it does not claim cryptographic identity or replace the host's normal permission controls.

## Scope and current limits

- Supports registered quotation and invoice synchronization from freee to existing Notion records.
- Supports header updates, line updates/creation, and archiving removed lines when explicitly included in policy.
- Does not create document headers, hard-delete pages, or write business data to freee.
- Uses the copied Private baseline synchronization planner and a focused extraction of its SQLite operation-gate contract.
- API tokens are supplied by host-provided token-provider functions. OAuth enrollment/refresh setup and production credential-store integration are deployment work.
- The test suite uses fake HTTP endpoints and temporary SQLite databases only. No live API or production database has been used from this candidate.
- Initial quotation/invoice registration, quote-to-invoice draft generation, unattended scheduling, and production monitoring deployment are not packaged as a complete installable application yet.

## Configuration

Copy `config.example.json` outside the repository and replace every placeholder with the target project's company ID, data-source IDs, relation names, property names/types, and approved policy values. Keep local credentials, config, SQLite databases, event logs, and notification state outside Git. The example is a schema guide; it is intentionally not runnable until all placeholders and property allowlists are configured.

The configuration scope must exactly match the active SQLite policy. Changing a company, database, action, property, or batch bound requires a fresh policy approval. Never widen the configuration to make a failed plan pass.

## Isolated checks

```sh
npm test
npm run test:formal-sync
npm run scan
```

`formal-flow-e2e.test.mjs` runs the integrated runner against the real Notion/freee client code pointed at fake HTTP endpoints and two independent synthetic project mappings. It uses real temporary SQLite files to verify mixed quotation/invoice batch sync, line ID replacement, added/archived lines, no-op, scope mismatch rejection, operation auditing, read-back, restart recovery, unknown-stop/no-replay, and fake error notification. Existing unit tests cover the reusable planner, API clients, batch coordinator, and local monitor.

## Release status

Not published. Review the full source and Git history, third-party notices, license rights, project-specific configuration, and a clean-install procedure before any public release. No live credentials, company/data-source/page IDs, transaction examples, runtime logs, or production SQLite files belong in this repository.
