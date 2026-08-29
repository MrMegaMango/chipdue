# ChipDue

ChipDue is a privacy-first financial workspace for tracking bank and brokerage accounts, signup bonuses, investment performance, credit-card payments, and the deadlines that connect them. One Plaid connection can automatically sync eligible bank, brokerage, and credit-card accounts, while manual entry remains available for unsupported institutions and bonus details.

Choose one of two deployment modes:

- **Local mode** is the default. It binds to loopback, needs no login, and stores an encrypted SQLite database outside the source checkout.
- **Private cloud mode** is a multi-account Vercel deployment. Each Google identity gets an isolated ChipDue account; the original operator account can also retain password recovery. It stores application-encrypted records in Neon Postgres and keeps its decryption key in Vercel's Production environment.

> ChipDue is a reminder tool, not a payment service. Always verify amounts and dates with the card issuer, and keep issuer alerts or autopay as a backstop.

## Features

- Keep a private inventory of personal and business checking, savings, cash-management, and brokerage accounts.
- Track signup bonuses from opening through requirements, qualification, payout, and safe-to-close dates.
- Automatically refresh eligible bank and brokerage balances after a one-time Plaid connection and account-selection flow.
- See each Plaid-synced brokerage position, share count, current institution price, value, and holding cost basis while keeping simple account-level performance.
- Track statement balance, minimum due, current balance, due date, statement date, and autopay status.
- Automatically identify supported linked cards from Plaid’s official product name, populate their reward type, base earning rate, and bonus categories, and show estimated points, miles, or cash back beside eligible transactions. Manual overrides remain available for unmatched cards.
- Create isolated cloud accounts with Google sign-in without storing an email, profile, Google token, or refresh token.
- Let each cloud account encrypt and use its own Plaid Production credentials, so Plaid Items and plan allowances are not shared between users.
- Connect Plaid only when you explicitly choose to; manual mode never contacts Plaid.
- Encrypt account and bonus records, card payloads, transaction history, Plaid cursors, access tokens, Item IDs, and institution names with AES-256-GCM.
- Request Plaid Accounts, Investments, Liabilities, and up to 24 months of Transactions data—never identity or full account numbers.
- Add due dates through Google Calendar event drafts without balances, amounts, or card numbers; keep an iCalendar download as a fallback.
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
                                      +-> Google, only during optional sign-in

Git repository -> source code and synthetic tests only
```

Cloud encryption protects against a database-only disclosure. It is not zero-knowledge encryption: the running Vercel Function has the key so it can sync Plaid and render your records after login. Read [PRIVACY.md](PRIVACY.md) and the [threat model](docs/THREAT_MODEL.md) before entering real data.

## Requirements

- Node.js 22 or newer
- npm
- Git
- Optional local sync: a Plaid account
- Optional cloud hosting: personal Vercel and Neon accounts
- Optional Google sign-in: a Google Cloud project and Web OAuth client

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

Hosted mode supports isolated Google-backed accounts and fails closed unless all authentication, encryption, database, HTTPS, and exact-host settings are valid.

The deployment process uses:

- A dedicated, non-owner Neon runtime role with only required row permissions, reached through a direct, unpooled TLS URL
- A strong generated operator password or explicit Google-only authentication, plus a separate 256-bit encryption key
- Google sign-in for each user; a one-time setup token is retained only to attach a Google identity to pre-existing operator data
- Production-only Vercel secrets; preview deployments receive no real database or key
- An exact production-host allowlist that rejects generated and old deployment URLs
- Secure, HTTP-only, same-site sessions with server-side revocation and login throttling

Follow [the private Vercel deployment guide](docs/DEPLOY_VERCEL.md). Do not set `CARDDUE_ALLOW_REMOTE=1` as a substitute for cloud mode.

ChipDue rejects Neon `-pooler` URLs for both migration and runtime use. Running `cloud:migrate` for an existing role always rotates it to a distinct credential, terminates its sessions, and can briefly interrupt access; use `cloud:verify` for routine checks. Update the protected recovery record, local runtime URL, and Vercel `DATABASE_URL` only after migration and restricted-runtime verification succeed, then redeploy.

Neon currently describes its Free plan as having no time limit, while Vercel Hobby is free for personal, noncommercial use within quotas. Service terms can change. The code and local mode remain provider-independent and free.

Official references:

- [Neon pricing](https://neon.com/pricing)
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby)
- [Vercel deployment protection](https://vercel.com/docs/deployment-protection)

## Optional Google sign-in

Google authentication is opt-in and cloud-only. A validated Google identity creates a new isolated ChipDue account on first sign-in and reopens the same account thereafter. The default password mode reserves the existing operator data for the password account; linking Google from that authenticated account attaches the selected Google identity to it. Google-only bootstrap remains available for attaching a Google identity to pre-existing operator data without enabling a password.

1. Create a dedicated, non-personal monitored support alias or Google Group, then use it as Google Auth Platform's **User Support Email**. Google displays that address on the consent screen, which any visitor can reach; do not select a personal address or a group whose membership reveals one.
2. In Google Auth Platform, configure an External audience and create a **Web application** OAuth client.
3. Register exactly `https://YOUR_PRODUCTION_HOST/api/auth/google/callback` as its authorized redirect URI. Do not add preview or generated deployment hosts.
4. Add `CARDDUE_GOOGLE_CLIENT_ID` and `CARDDUE_GOOGLE_CLIENT_SECRET` to Vercel **Production only**; mark the secret as Sensitive. ChipDue stays disabled when both are absent and fails closed when only one is present.
5. Redeploy. Any user allowed by the Google OAuth app can now sign in and receive a separate ChipDue account.
6. In password mode, sign in with the password and choose **Link Google account** to attach Google to the original operator account. For an existing Google-only installation, follow [the bootstrap guide](docs/GOOGLE_ONLY_AUTH.md) to attach the original data before admitting other users.

ChipDue requests only the `openid` scope. It validates Google's signed ID token, binds the stable issuer-and-subject pair through a keyed one-way fingerprint, and immediately discards Google's ID and access tokens. It does not request or store the Google email, name, picture, profile, or refresh token. Google still observes the sign-in, IP address, time, ChipDue hostname, and configured public support contact.

Google bindings are intentionally immutable in this release: the dashboard cannot unlink an identity or move it to another ChipDue account. In password mode, removing both Google variables and redeploying disables Google while the operator password remains available. In Google-only mode, removing them deliberately makes the application fail closed with `503`; there is no password fallback.

Google currently exempts apps that use only basic Sign in with Google scopes from Testing-mode test-user warnings and seven-day authorization expiry. A personal client on a generated `vercel.app` hostname can therefore remain functional without a paid domain, but that shared hostname cannot satisfy Google's owned-domain brand-verification path. Provider rules can change; a custom domain is needed for verified production branding, not for ChipDue's personal-use flow.

Official references:

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google Auth Platform audiences](https://support.google.com/cloud/answer/15549945)
- [Google OAuth branding and support email](https://support.google.com/cloud/answer/15549049)
- [Google brand and domain verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)

## Optional Plaid setup

1. Create your own Plaid Dashboard team and confirm the available plan for your region and account.
2. In a hosted ChipDue account, choose **Set up Plaid** and enter that team's client ID and **Production** secret. ChipDue verifies and encrypts both values for only that account; it never returns them to the browser.
3. For local development, `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` in `.env.local` remain supported. Installation-level credentials are available only to the local or original operator account, never to newly created Google accounts.
4. Never add a `PUBLIC_` or `VITE_` prefix to a secret. Each user is responsible for their Plaid account, plan, allowed redirect URI, and terms.
5. Choose **Connect Plaid** and select the accounts you want to share. For an existing connection, choose **Manage accounts** once to add accounts that were not previously selected.

Plaid plan access, institution coverage, and pricing differ by product and can change. Accounts and balances are the baseline; brokerage holdings/cost basis require Investments coverage, and detailed card payment fields require Liabilities. An Item is one institution login and can contain multiple bank, brokerage, and card accounts. ChipDue always retains manual mode as a fallback.

Official references:

- [Plaid billing](https://plaid.com/docs/account/billing/)
- [Plaid Accounts](https://plaid.com/docs/api/accounts/)
- [Plaid Investments](https://plaid.com/docs/investments/)
- [Plaid Liabilities](https://plaid.com/docs/liabilities/)
- [Plaid Transactions](https://plaid.com/docs/transactions/)
- [Plaid Link security flow](https://plaid.com/docs/link/)

## Where private data lives

In local mode, ChipDue uses the platform application-data directory:

- Linux/WSL: `$XDG_DATA_HOME/carddue`, or `~/.local/share/carddue`
- macOS: `~/Library/Application Support/CardDue`
- Windows: `%LOCALAPPDATA%\CardDue`

These legacy `carddue`/`CardDue` storage names intentionally remain stable after the ChipDue
product rename so existing encrypted databases and keys continue to open without a migration.
The same compatibility rule applies to `CARDDUE_*` environment variables, `carddue_*` database
objects and runtime roles, host-only cookie names, calendar UID domains, and cryptographic context
strings. Changing those identifiers in place could orphan encrypted data or invalidate live state.

In cloud mode, Neon stores encrypted application rows plus non-sensitive operational metadata, account ownership references, keyed session/rate-limit identifiers, an opaque bootstrap claim state when used, keyed Google issuer-and-subject fingerprints, and encrypted per-account Plaid credentials. Vercel stores the database URL, encryption key, mode-specific authentication values, and Google client secret as sensitive Production environment variables. Keep generated recovery and temporary bootstrap bundles outside every Git checkout with owner-only permissions.

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

See [CONTRIBUTING.md](CONTRIBUTING.md), the [publishing checklist](docs/PUBLISHING.md), and [third-party notices](THIRD_PARTY_NOTICES.md). Never copy a live Plaid or Google response into a fixture, issue, pull request, screenshot, or log - even after attempting to redact it.

## License

[MIT](LICENSE)
