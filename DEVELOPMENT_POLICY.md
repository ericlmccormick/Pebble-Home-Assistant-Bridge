# Source-of-truth and release policy

GitHub is the source of truth for this Pebble project. Never treat a disposable
scratch directory or a compiled PBW as the only copy of working source code.

For every code change:
1. Work on a named GitHub branch and commit code, tests, metadata, and assets.
2. Push commits to the repository before sharing a test PBW.
3. Run regression tests, compile for supported Pebble platforms, and verify
   the exact commit SHA built by GitHub Actions.
4. Publish the test PBW as a directly downloadable GitHub Release asset
   (not an Actions artifact ZIP) and include the commit SHA alongside its URL.
5. Release to main only after the tested branch passes build and behavior checks.
6. Do not declare work complete if its source is only in temporary storage.

Touch devices must retain button fallback. Device states must be refreshed
after commands before showing that the requested state has taken effect.
