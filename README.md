# npm-recipe-kitchen

PoC for safe npm package on-boarding through auditable recipe bundles.

1. A package enters the request queue.
2. A human investigator drafts a local recipe bundle (manifest, build, smoke test, evidence).
3. The bundle is reviewed by a second human.
4. On approval, the recipe is promoted via an explicit mock-promotion step.
5. Compliance checks and queue priorities are recomputed against the updated catalog.
6. Recipe merge does not imply package availability — promotion and compliance are separate gates.
