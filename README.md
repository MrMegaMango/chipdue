# CardDue

CardDue is a privacy-first dashboard for tracking credit-card statement balances, minimum payments, and due dates. It works entirely in manual mode and can optionally sync the same limited fields through Plaid Liabilities.

Choose one of two deployment modes:

- **Local mode** is the default. It binds to loopback, needs no login, and stores an encrypted SQLite database outside the source checkout.
- **Private cloud mode** is a single-owner Vercel deployment. It requires a password, stores only application-encrypted records in Neon Postgres, and keeps its decryption key in Vercel's Production environment.

> CardDue is a reminder tool, not a payment service. Always verify amounts and dates with the card issuer, and keep issuer alerts or autopay as a backstop.

## Features

- Track statement balance, minimum due, current balance, due date, statement date, and autopay status.
- Connect Plaid only when you explicitly choose to; manual mode never contacts Plaid.
- Encrypt card payloads, Plaid access tokens, Item IDs, and institution names with AES-256-GCM.
- Request only Plaid Liabilities - never transaction history, identity, or full account numbers.
- Export due dates as an iCalendar file, with amounts omitted by default.
- Keep financial data out of browser persistence, logs, source code, CI, and Git history.
- Run privacy and full-history secret checks before every push.

## Privacy architecture

```text
Local mode
Browser memory -> loopback SvelteKit server -> encrypted local SQLite

Private cloud mode
Browser memory -> authenticated Vercel Function -> encrypted Neon Postgres rows
                                      |
                                      +-> Plaid, only when configured and used

Git repository -> source code and synthetic tests only
```

Cloud encryption protects against a database-only disclosure. It is not zero-knowledge encryption: the running Vercel Function has the key so it can sync Plaid and render your records after login. Read [PRIVACY.md](PRIVACY.md) and the [threat model](docs/THREAT_MODEL.md) before entering real data.

## Requirements

- Node.js 22 or newer
- npm
- Git
- Optional local sync: a Plaid account
- Optional cloud hosting: personal Vercel and Neon accounts

## Start locally

```sh
npm ci
npm run privacy:init
npm run dev
```

Open `http://127.0.0.1:5173`. No credentials are needed for local manual mode.

For a production-style local build:

```sh
npm run build
npm start
```

The production server listens on `127.0.0.1:4173` by default.

## Deploy a private cloud instance

Hosted mode is deliberately single-owner. It fails closed unless all authentication, encryption, database, HTTPS, and exact-host settings are valid.

The deployment process uses:

- A dedicated, non-owner Neon runtime role with only required row permissions, reached through a direct, unpooled TLS URL
- A strong generated login password and separate 256-bit encryption key
- Production-only Vercel secrets; preview deployments receive no real database or key
- An exact production-host allowlist that rejects generated and old deployment URLs
- Secure, HTTP-only, same-site sessions with server-side revocation and login throttling

Follow [the private Vercel deployment guide](docs/DEPLOY_VERCEL.md). Do not set `CARDDUE_ALLOW_REMOTE=1` as a substitute for cloud mode.

CardDue rejects Neon `-pooler` URLs for both migration and runtime use. Running `cloud:migrate` for an existing role always rotates it to a distinct credential, terminates its sessions, and can briefly interrupt access; use `cloud:verify` for routine checks. Update the protected recovery record, local runtime URL, and Vercel `DATABASE_URL` only after migration and restricted-runtime verification succeed, then redeploy.

Neon currently describes its Free plan as having no time limit, while Vercel Hobby is free for personal, noncommercial use within quotas. Service terms can change. The code and local mode remain provider-independent and free.

Official references:

- [Neon pricing](https://neon.com/pricing)
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby)
- [Vercel deployment protection](https://vercel.com/docs/deployment-protection)

## Optional Plaid setup

1. Create a Plaid Dashboard team and confirm the available plan for your region and account.
2. Add `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` to `.env.local` for local use or Vercel's Production environment for hosted use.
3. Never add a `PUBLIC_` or `VITE_` prefix to a secret.
4. Keep `PLAID_ENV=sandbox` until the complete flow is tested.
5. Restart or redeploy CardDue, then choose **Connect with Plaid**.

Plaid's Trial plan currently supports real data and Liabilities for a limited number of lifetime Production Items. An Item is one institution login and can contain multiple cards. Provider terms can change, so CardDue always retains manual mode.

Official references:

- [Plaid billing](https://plaid.com/docs/account/billing/)
- [Plaid Liabilities](https://plaid.com/docs/liabilities/)
- [Plaid Link security flow](https://plaid.com/docs/link/)

## Where private data lives

In local mode, CardDue uses the platform application-data directory:

- Linux/WSL: `$XDG_DATA_HOME/carddue`, or `~/.local/share/carddue`
- macOS: `~/Library/Application Support/CardDue`
- Windows: `%LOCALAPPDATA%\CardDue`

In cloud mode, Neon stores encrypted application rows plus non-sensitive operational metadata and hashed session/rate-limit identifiers. Vercel stores the database URL, password hash, and encryption key as sensitive Production environment variables. Keep the generated recovery bundle outside every Git checkout with owner-only permissions.

The repository ignores common database, environment, export, log, trace, certificate, and backup formats as a second layer of protection. The privacy scanner rejects secrets, personal paths, card numbers, and likely private artifacts. Every Vercel build path uses a committed verified wrapper that refuses checkout environment files and fails if output contains a private-home directory, database, credential-like artifact, source map, private path, configured secret, compact token, or private-key material.

## Development

```sh
npm run ci
```

This runs the privacy audit, formatting and lint checks, type checks, unit tests, and both production build paths. Install the repository hooks before contributing:

```sh
git config core.hooksPath .githooks
npm run privacy:init
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [publishing checklist](docs/PUBLISHING.md). Never copy a live Plaid response into a fixture, issue, pull request, screenshot, or log - even after attempting to redact it.

## License

[MIT](LICENSE)
