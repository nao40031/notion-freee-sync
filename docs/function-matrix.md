# Workflow and safety matrix

| Workflow | Shared behavior | Controls | Verification status |
|---|---|---|---|
| Project/task to draft lines | Explicit selection, configurable relation/property mapping, quantity and unit-price checks, rounding | Rejects missing or ambiguous project/price relations | Fictional mapping tests |
| Quotation/invoice draft assembly | Common normalized draft shape and freee request payload mapping | Company scope, document type, dates, line arithmetic, tax and totals checked | Isolated builder tests |
| Initial freee registration | One approved create operation, then read-back and existing Notion ID update | Approval is host-provided; duplicate preflight repeats; unknown create is never replayed | Fake API and temporary SQLite E2E |
| Quote-to-invoice draft | Validated copy into a separate invoice draft with source relations | Stable request key, durable intent and exact read-back | Fake Notion/SQLite E2E |
| Registered-document synchronization | Latest freee GET, normalized plan, header/line updates, archive of removed lines where policy permits | Target and property allowlists, one writer lease, intent-before-write, read-back, unknown stop | Two fictional mappings, mixed document batch and recovery tests |
| Persistent ledger | Lease, operation status, audit evidence and legacy schema preservation | Additive migration only; existing approvals are not authorization for new operations | Existing-schema and unknown-state tests |
| Monitoring and alerts | Sanitized logs, status classification, deduplication, optional email transport | Notification failure never triggers business replay | Fake sink and sender tests |
| Scheduled execution | One-shot entry suitable for an operating-system scheduler | Disabled by default; task registration/enablement is explicit | Plan and runner tests only |
| Host security | OAuth refresh, protected token store, cross-process lock, loopback callback | Credentials are external; approval provider must be supplied by the host | Injected provider tests; real-host certification remains open |

A project must set its own company, databases, relations, property names, tax policy, numbering, and operating authorization. See [setup](setup.md) and [integration compatibility](integration-compatibility.md).
