# Integration compatibility

## Host responsibilities

The adopting project provides its protected configuration, OAuth client credentials, credential store, operation approval interface, API permissions, and deployment account. The generic package does not claim to identify an approver or consume approval events from a specific agent platform.

## Existing SQLite databases

The gate opens an existing compatible SQLite file additively. It preserves existing audit and operation rows, and adds only missing compatibility columns/tables required by the package. It never rewrites old approvals into current authorization. A prior `started` or `unknown` operation blocks replay until a read-back reconciliation establishes the outcome.

For initial freee registration, the gate checks both the current operation identity and document identity before creating a new intent. It recognizes document-number keys from older writers and current composite keys. An unresolved legacy POST with no document key blocks new registration for that document type because its identity cannot be safely established. Exceptional retry flows remain host-specific.

Before adopting a shared database, back it up while all writers are stopped. Run the package against an isolated copy first. To roll back, stop the new runner, preserve the database and logs, and restore the prior host executable; do not delete unknown or audit rows. Reconcile any operation that was started during the attempted cutover before resuming either host.

## Project-specific rules

Number sequences, template fallback, tax choices, document labels, relation names, and property mappings must be supplied by project configuration or a host extension. No example value grants permission to create or modify a live record.

## Verification limits

The automated suite uses fictional projects, fake API transports, and temporary SQLite. It does not validate live OAuth consent, real Gmail delivery, a target Windows account's DPAPI/ACL, or a scheduled production run. Review the configured scope, credentials, task account, backup, alert destination, and rollback procedure before deployment.
