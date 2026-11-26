# Public release checklist (preview)

- Review the exact file list and new history; never import project history.
- Confirm the secret/data scan is clear and inspect all scanner exceptions manually.
- Confirm fixtures are synthetic, with no real IDs, names, emails, amounts, logs, SQLite or exports.
- Review MIT text and copyright owner before replacing `LICENSE.preview` with `LICENSE`.
- Review README, setup and safety limits.
- Run `npm test` and `npm run scan` from a clean checkout.
- Only after owner review, create the Public repository and publish the reviewed commit.
