# Design boundary (preview)

- `sync-core.mjs` normalizes identity checks, diff planning and sequential batch preflight. It has no network side effects.
- `api-clients.mjs` injects credentials and transport. freee is GET-only. Notion write methods require an explicit operation, page/data-source scope and property allowlist.
- `monitor.mjs` emits sanitized events and deduplicates failure notifications by document/status/reason. A deployment supplies persistence and notification transport.
- Tests use synthetic identifiers, fake HTTP handlers and in-memory event collectors.

The host remains responsible for normal user authorization, a single writer, durable audit/lease implementation, unknown-outcome recovery and scheduling. The preview does not impersonate an approval event or treat a configuration flag as proof that a user approved it.
