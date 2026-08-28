# Contributing

Thank you for helping improve ChipDue. Privacy failures are treated as security bugs.

## Before making changes

```sh
npm ci
git config core.hooksPath .githooks
npm run privacy:init
```

Configure a GitHub noreply address for commits. Git embeds the author name and email permanently in each commit.

## Data rules

- Use handwritten, obviously synthetic test data.
- Never copy or sanitize a real Google or Plaid response for a fixture.
- Never attach statements, screenshots, HAR files, traces, databases, exports, or environment files.
- Do not add analytics, telemetry, remote fonts, webhook relays, or browser persistence without a threat-model update.
- Add no new Plaid product unless the privacy benefit and additional data collection are documented and approved.
- Keep all Google and Plaid token or API calls in server-only modules.
- Keep dependency lifecycle scripts disabled in `.npmrc`; enabling one requires a supply-chain review.

## Required checks

```sh
npm run ci
gitleaks git . --redact
```

The privacy check intentionally prints only filenames and rule identifiers—not the matching content.

## Pull requests

Explain any new data field, network request, dependency, file output, or logging behavior. Pull requests from forks receive no production credentials, and tests must succeed without Google or Plaid configuration.
