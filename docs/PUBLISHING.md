# Safe publishing checklist

Run this checklist before making any repository public or pushing a release.

## Repository and history

1. Confirm the repository-local author uses a GitHub noreply address and commit signing is not attaching an unintended identity.
2. Run `npm run privacy:init`, then add institution names, account suffixes, hostnames, identifiers, and other private strings to the ignored `.privacy-denylist`. Never print or commit the denylist.
3. Review `git status --short --ignored`, every staged filename, and every staged diff. Treat unfamiliar generated files as a stop condition.
4. Run `npm run ci` with no credentials present. It must pass the privacy audit, formatting, lint, type checks, tests, and both build targets.
5. Run `gitleaks git . --redact` against all refs and complete history.
6. Inspect all authors with `git log --all --format='%an <%ae>'`; do not paste its output into an issue, chat, or build log.
7. Reject unexpected symlinks, submodules, large objects, and binary Git objects.
8. Confirm no `.env`, Vercel metadata directory, recovery bundle, database, WAL/SHM file, export, backup, trace, HAR file, screenshot, source map, certificate, private key, or real fixture is tracked anywhere in history.
9. Search documentation, examples, tests, issue templates, package metadata, lockfiles, and generated client/server output for real usernames, paths, email addresses, hosts, database endpoints, project IDs, and provider identifiers.
10. Build and test a clean clone with no environment variables or credentials. Local mode must remain the default; a Vercel build without cloud secrets must not embed or print them.

## Cloud-specific publication checks

1. Keep the recovery bundle and every temporary migration environment file outside every Git checkout, synced source folder, CI workspace, and Vercel project.
2. Confirm source and documentation contain environment-variable names and invalid placeholders only. They must not contain a usable connection string, password hash, AES key, Plaid credential, session token, or production hostname.
3. Inspect generated browser assets and source maps for server environment values. No financial data or credential may use a `PUBLIC_` or `VITE_` variable.
4. Verify Preview and Development have no Neon, CardDue authentication, AES, migration, or Plaid secrets. Pull requests and previews must build without access to real data.
5. Confirm the owner-capable Neon migration URL is absent from Vercel, GitHub Actions, repository secrets, local checked-out files, and shell history. Only the restricted runtime URL belongs in Vercel Production.
6. Confirm no workflow uploads databases, logs, screenshots, environment snapshots, Vercel output, or other private artifacts.
7. Review dependency and workflow changes for install scripts, unexpected network activity, artifact upload, or environment-variable access before allowing a build to receive any secret.

## GitHub and release settings

1. Enable secret scanning, push protection, Dependabot alerts and updates, private vulnerability reporting, and branch protection for the default branch where the plan supports them.
2. Give Actions the minimum repository permissions and pin third-party actions to reviewed immutable commits.
3. Do not add production deployment secrets to GitHub merely to run tests. Tests and release builds use synthetic data.
4. Review collaborators, installed GitHub Apps, deploy keys, webhooks, environments, pages, packages, releases, and artifacts. Remove anything not required.
5. Review the rendered README, privacy policy, security policy, threat model, and deployment guide. They must distinguish local and hosted trust boundaries and must not promise zero-knowledge encryption, guaranteed provider retention, or automated payments.
6. Publish only source and synthetic assets. Do not attach a live backup, calendar file, runtime log, configuration export, recovery bundle, or screenshot containing a real dashboard.

Follow [DEPLOY_VERCEL.md](DEPLOY_VERCEL.md) separately before connecting a public production deployment to real data. Repository publication does not validate the deployed project's secret scopes, role privileges, DNS, or authentication behavior.

If sensitive data entered any commit, revoke credentials first. Rewrite history before publishing, then repeat every audit from a clean clone. History rewriting cannot remove copies that another person has already cloned or forked.
