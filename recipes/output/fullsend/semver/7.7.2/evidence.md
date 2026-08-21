Package identity: semver@7.7.2
Native tier: A

Source repository: https://github.com/npm/node-semver
Version tag: v7.7.2
Pinned commit: 281055e7716ef0415a8826972471331989ede58c

Evidence:
- [source-inspection] No build, prepare, prepack, or prepublishOnly script in package.json
- [pack-test] npm pack --ignore-scripts produces semver-7.7.2.tgz with package/package.json, package/index.js, package/bin/semver.js
- [provenance] SLSA v1 provenance attestation present on npm
- [tag-match] Tag v7.7.2 resolves to commit 281055e7716ef0415a8826972471331989ede58c

Could not verify:
- SLSA attestation signature chain not independently verified
