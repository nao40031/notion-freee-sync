# Notion ↔ freee Sync Core (preview)

Configurable building blocks for synchronizing **already registered** freee quotations and invoices into existing Notion records. This is an isolated extraction preview, not a production-ready installer.

The package has no embedded service credentials, company/data-source/page IDs, or real transaction fixtures. Authentication is injected through token-provider functions. Mapping and scope are supplied through configuration. Fake tests use synthetic data only.

## Safety boundary

- Read the linked freee document and existing Notion pages before planning changes.
- Never infer a Notion target from a document number alone.
- Do not create document headers or hard-delete pages.
- Ambiguous line identity and inconsistent totals stop before any write.
- Batch mode can pre-plan the whole snapshot and enforce no-op-only acceptance before calling a writer.
- Production credentials, approved operating scope, durable audit storage and the platform's execution/permission controls remain deployment responsibilities.

## Local checks

```sh
npm test
npm run scan
```

## Status

This candidate is not published. Its structure and isolated tests have been reviewed. No live API has been called from this folder.
