# Security status

Security fixes go into the latest published version of `@pixeljs/core` and `@pixeljs/create` (currently 0.0.4). Report vulnerabilities privately through GitHub's private vulnerability reporting: [github.com/alexandroit/pixeljs/security](https://github.com/alexandroit/pixeljs/security) → **Report a vulnerability**. Do not publish exploit details in a public issue.

The C core validates bounds, sizes, budgets, protocol records and generational resources, and rejects invalid batches atomically. The SDK validates JavaScript input and engine ownership, and bounds every asset download. Tests, sanitizers and fuzzing provide evidence for the covered cases, not proof that the engine is free of memory errors; the [architecture guide](docs/architecture.md#security-model) describes the security model.

Game JavaScript is trusted by its host application. This engine is not a sandbox for untrusted games. It has no account, telemetry or implicit game-data network service. Unexpected WASM traps abandon the affected instance; the host does not reenter a possibly corrupt context. The optional audio processor runs in its own WASM instance and its failures cannot pause or corrupt the visual engine.

Corruption, use-after-free, unbounded input handling or mismatched JS/WASM artifacts block a release until corrected and tested. Published npm versions carry provenance from the GitHub Actions release workflow; a package without provenance was not produced by that workflow.
