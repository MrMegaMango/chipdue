# Safe publishing checklist

Run this checklist before making any repository public or pushing a release.

1. Confirm the repository-local author uses a GitHub noreply address and commit signing is not attaching an unintended identity.
2. Run `npm run privacy:init`, then add any institution names, account suffixes, identifiers, and other private strings to the ignored `.privacy-denylist`.
3. Review `git status --short --ignored` and every staged filename.
4. Run `npm run ci`.
5. Run `gitleaks git . --redact` against the complete history.
6. Inspect all authors with `git log --all --format='%an <%ae>'`; do not paste the output into an issue or chat.
7. Reject unexpected symlinks and binary Git objects.
8. Confirm no `.env`, database, WAL/SHM file, export, backup, trace, HAR file, screenshot, source map, or real fixture is tracked.
9. Build and test a clean clone with no credentials.
10. Enable GitHub secret scanning and push protection before adding optional repository secrets.

If sensitive data entered any commit, revoke credentials first. Rewrite history before publishing, then repeat every audit from a clean clone. History rewriting cannot remove copies that another person has already cloned or forked.
