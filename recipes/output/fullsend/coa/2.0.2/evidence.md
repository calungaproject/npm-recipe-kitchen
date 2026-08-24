Package identity: coa@2.0.2
Native tier: A

Source repository: https://github.com/veged/coa
Version tag: v2.0.2
Pinned commit: e891bbf583a4e22395f877bfd03dd2ff64bdc73b

Evidence:
- [artifact-integrity] tarball verified against dist.integrity (sha512-q5/jG+YQnSy4nRTV4F7lPepBJZ8qBNJJDBuJdoejDyLXgmL7IEo+Le2JDZudFTFt7mrCqIRaSjws4ygRCTCAXA==)
- [tag-resolution] v2.0.2 (annotated) resolves to commit e891bbf583a4e22395f877bfd03dd2ff64bdc73b
- [pack-test] npm pack --ignore-scripts from e891bbf583a4e22395f877bfd03dd2ff64bdc73b produced coa-2.0.2.tgz with the expected entrypoints
- [classification] Package classified as tier A: pure JavaScript, no build step, no native dependencies

Could not verify:
- npm provenance attestation present but not cryptographically verified
- Source association is tag_only (tag->commit only); tarball build provenance not verified
