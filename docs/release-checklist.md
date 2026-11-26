# Public release checklist (preview)

- Review the exact file list and new history; never import project history.
- Confirm the secret/data scan is clear and inspect all scanner exceptions manually.
- Confirm fixtures are synthetic, with no real IDs, names, emails, amounts, logs, SQLite or exports.
- MIT license and copyright notice are set to `Copyright (c) 2026 Oshino`; verify this exact notice is retained in the release archive.
- Review `THIRD-PARTY-NOTICES.md` and package metadata; add notices if dependencies or external source are introduced later.
- Review README, setup and safety limits.
- Run `npm test` and `npm run scan` from a clean checkout.
- Only after owner review, create the Public repository and publish the reviewed commit.
