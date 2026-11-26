# Setup (preview)

1. Copy `config.example.json` to a machine-local configuration file covered by `.gitignore`.
2. Set your freee company scope, Notion data sources, property map and the exact operations allowed for that deployment.
3. Supply API tokens through the host credential store or a token-provider callback. Never place a token in configuration committed to Git.
4. Run the fake test suite and review a read-only data-source inventory.
5. Verify registered identity using `(company, document type, freee ID)`; document number is an additional consistency check only.
6. Validate totals, line identity, parent relations and allowed properties before enabling the writer.
7. Keep the production writer off until the operator has configured and accepted the scope in the host's normal permission flow.

The preview library does not register a Windows scheduled task or perform live service operations. Deployment-specific audit storage and the authoritative permission/approval mechanism must be supplied by the host application.
