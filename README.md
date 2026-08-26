# CardDue

CardDue is a private, local-first dashboard for tracking credit-card statement balances, minimum payments, and due dates. It works entirely in manual mode and can optionally sync the same fields through Plaid Liabilities.

The application is designed to run on one computer and bind only to the loopback interface. It has no analytics, advertising, cloud database, account system, or transaction tracking.

> CardDue is a reminder tool, not a payment service. Always verify amounts and dates with the card issuer, and keep issuer alerts or autopay as a backstop.

## Features

- Track statement balance, minimum due, current balance, due date, statement date, and autopay status.
- Connect Plaid only when you explicitly choose to; manual mode never contacts Plaid.
- Store the SQLite database and encryption key outside the Git checkout.
- Encrypt long-lived Plaid access tokens and Item IDs with AES-256-GCM.
- Request only Plaid Liabilities—never transaction history, identity, or account numbers.
- Export due dates as an iCalendar file, with amounts omitted by default.
- Run automated checks for secrets, personal paths, email addresses, card numbers, and private files before every commit.

## Privacy architecture

```text
Browser memory
    │ same-origin requests on loopback
    ▼
Local SvelteKit server
    ├── encrypted credentials + minimal SQLite records outside the repository
    └── Plaid API, only when configured and explicitly used

Git repository
    └── source code and synthetic tests only
```

Read [PRIVACY.md](PRIVACY.md) and the [threat model](docs/THREAT_MODEL.md) before connecting a real account.

## Requirements

- Node.js 22 or newer
- npm
- Git
- Optional: a Plaid account eligible for its free Trial plan

## Start in manual mode

```sh
npm ci
npm run privacy:init
npm run dev
```

Open `http://127.0.0.1:5173`. No credentials are needed for manual mode.

For a production-style local build:

```sh
npm run build
npm start
```

The production server listens on `127.0.0.1:4173` by default.

## Optional Plaid setup

1. Create a Plaid Dashboard team and confirm that the Trial plan is available for your region and account.
2. Copy `.env.example` to `.env.local`.
3. Add your Plaid client ID and secret to `.env.local`; never add a `PUBLIC_` or `VITE_` prefix.
4. Keep `PLAID_ENV=sandbox` until the complete local flow is tested.
5. Restart CardDue, then choose **Connect with Plaid**.

Plaid's current Trial plan supports real data and Liabilities for up to ten lifetime Production Items. An Item is one institution login and can contain multiple cards. Removing an Item does not restore the slot. Plaid does not state an expiration, but its terms can change, so CardDue always retains a provider-independent manual mode.

Official references:

- [Plaid Trial-plan billing](https://plaid.com/docs/account/billing/)
- [Plaid Liabilities](https://plaid.com/docs/liabilities/)
- [Plaid Link security flow](https://plaid.com/docs/link/)

## Where private data lives

CardDue chooses the platform application-data directory by default:

- Linux/WSL: `$XDG_DATA_HOME/carddue`, or `~/.local/share/carddue`
- macOS: `~/Library/Application Support/CardDue`
- Windows: `%LOCALAPPDATA%\CardDue`

The repository ignores common database, environment, export, log, trace, certificate, and backup formats as a second layer of protection. CardDue should refuse a custom data path that resolves inside a Git worktree.

On Linux or macOS, an existing custom data directory must already be owner-only (for example, mode `0700`). Broad locations such as the filesystem root, home directory, or system temporary directory are rejected.

## Development

```sh
npm run ci
```

This runs the privacy audit, formatting and lint checks, type checks, unit tests, and a production build. Install the repository hooks before contributing:

```sh
git config core.hooksPath .githooks
npm run privacy:init
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [publishing checklist](docs/PUBLISHING.md). Never copy a live Plaid response into a fixture, issue, pull request, screenshot, or log—even after attempting to redact it.

## License

[MIT](LICENSE)
