Package identity: debug@4.3.7
Native tier: A

Source repository: https://github.com/debug-js/debug
Version tag: 4.3.7
Pinned commit: bc60914816e5e45a5fff1cd638410438fc317521

Evidence:
- [artifact-integrity] tarball verified against dist.integrity (sha512-Er2nc/H7RrMXZBFCEim6TCmMk02Z8vLC2Rbi1KEBggpo0fS6l0S1nnapwmIi3yW/+GOJap1Krg4w0Hg80oCqgQ==)
- [tag-resolution] 4.3.7 (annotated) resolves to commit bc60914816e5e45a5fff1cd638410438fc317521
- [pack-test] npm pack --ignore-scripts from bc60914816e5e45a5fff1cd638410438fc317521 produced debug-4.3.7.tgz with the expected entrypoints
- [template-classification] Pure JavaScript package with no build steps, no lifecycle scripts, and no native dependencies; eligible for tier-a-npm-pack-no-build-v1

Could not verify:
- npm provenance attestation present but not cryptographically verified
- Source association is tag_only (tag->commit only); tarball build provenance not verified
