# Privacy policy

ChipDue is built around data minimization. Manual entry is fully functional without Plaid, and local mode remains available without a hosted database.

## Deployment modes

### Local mode

Local mode is the default. ChipDue runs as a loopback-only service for one trusted operating-system account. Its encrypted SQLite database and separate key file live in the platform application-data directory, outside the source checkout. The key file is created with owner-only permissions where the operating system supports them.

### Private cloud mode

Private cloud mode is an opt-in, multi-account deployment on Vercel backed by Neon Postgres. The production hostname is public on the internet, but ChipDue requires a valid password-backed operator session or Google identity before returning financial APIs. Each Google identity is mapped to one isolated ChipDue account; Google-only mode has no ChipDue password endpoint.

ChipDue encrypts account and bonus records, card payloads, enabled transaction history, Plaid transaction cursors, access tokens, Plaid Item IDs, institution names, and per-account Plaid credentials with AES-256-GCM inside the Vercel Function before sending them to Neon. Neon receives ciphertext plus limited operational metadata: opaque keyed identifiers, tenant UUIDs or keyed ownership references, record source and Plaid connection status, schema version, timestamps, authentication-config-bound keyed session-token hashes, keyed rate-limit buckets, short-lived keyed OAuth transaction markers, an opaque Google-only bootstrap claim state when used, and one keyed Google identity fingerprint per Google account. It never receives the raw setup token, Google subject, or email from ChipDue. This metadata can still reveal approximate user and record counts, activity times, and whether records came from manual entry or Plaid.

The hosted design is not zero-knowledge or end-to-end encryption. Vercel stores the production database URL, encryption key, and the selected authentication configuration: a password hash in password mode, or Google credentials plus a temporary bootstrap verifier during Google-only setup. The Function must decrypt records to display them or sync Plaid. A Neon-only database disclosure should not reveal the encrypted fields without the separate key; compromise of the Vercel project, runtime, owner account, or recovery material can expose them.

## Data ChipDue keeps

ChipDue stores only the fields required for the private financial workspace:

- A user-selected account nickname, optional institution, account type, personal or business classification, lifecycle status, and optional last four characters
- Optional account balance, brokerage cost basis or contributions, opening date, private notes, data source, and last-sync time
- A user-selected bonus name, optional linked account and institution, reward value, lifecycle status, requirements checklist, opening date, requirement deadline, expected or actual payout dates, safe-to-close date, and private notes
- A user-selected card nickname and optional issuer name
- Optional last four digits
- Statement balance, minimum payment, and current balance
- Statement date and next payment due date
- Autopay preference, source, and last-update time
- Optional rewards program name, reward type, base earning rate, cash-equivalent reward value, bonus category names, rates, Plaid category mappings, and whether the profile was automatically matched or manually overridden
- Reward estimates calculated by ChipDue from encrypted transaction amounts and either an automatically matched card profile or a manual override; these are not issuer-reported rewards
- Opaque identifiers needed to update or delete records
- For Plaid connections, encrypted access tokens, Item IDs, selected account details and balances, and optional investment holding cost basis
- For a user-configured Plaid integration, the encrypted client ID and Production secret for that user's Plaid team
- When transaction access is enabled, up to 24 months of encrypted card transactions, their pending/category fields, and the encrypted incremental-sync cursor
- For optional Google sign-in, a keyed one-way fingerprint of Google's issuer and stable subject

It does not store full account numbers, credentials entered into Plaid Link, identity profiles, addresses, locations, original bank descriptions, merchant logos, counterparties, security-level investment positions, or raw Plaid responses. Plaid responses are mapped immediately to the allowlisted account, card, and transaction fields, encrypted as application records, and then discarded.

When Google sign-in is enabled, ChipDue does not request or store the Google email, name, picture, profile, access token, ID token, or refresh token. A short-lived encrypted browser cookie carries the OAuth state, nonce, PKCE verifier, intent, expiry, and either the initiating ChipDue session or an opaque bootstrap-claim reference. The raw Google-only setup token is never stored in that cookie or in Neon. The cookie is cleared at callback; a validated one-time database marker is atomically consumed, while abandoned markers expire and are pruned.

A Google binding cannot be removed, replaced, or moved to another ChipDue account through the application in this release. Removing both Google OAuth environment variables and redeploying disables Google login but leaves opaque fingerprints in Neon backups and live metadata rows. A reviewed database recovery procedure is required to erase or replace a binding.

## Network activity

In local manual mode, ChipDue makes no application-level network requests after dependencies have been installed. Private cloud mode necessarily sends requests between the browser, Vercel, and Neon. Those providers process request or service metadata under their own policies even though Neon application records are ciphertext.

Plaid is optional in both modes. When you explicitly start Plaid Link:

- Your browser loads Plaid's Link SDK from `cdn.plaid.com`.
- Plaid and the selected financial institution handle authentication.
- A short-lived public token returns to the ChipDue server.
- The server exchanges it and requests Accounts, Investments, Liabilities, and up to 24 months of Transactions data from Plaid. Existing connections may require one **Manage accounts** pass to authorize accounts that were not selected originally.
- ChipDue maps selected checking, savings, cash-management, and brokerage accounts to encrypted account records. Balances refresh during scheduled and on-demand syncs; brokerage cost basis is included only when Plaid Investments returns complete holding data.
- ChipDue keeps only transaction date, display name, optional merchant, amount, currency, pending state, and category; it maps those fields into the encrypted card payload and discards the raw response.

In cloud mode, users may enter their own Plaid client ID and Production secret. ChipDue validates those credentials directly with Plaid, encrypts them on the server, and never returns them to the browser. Each ChipDue account uses only its own Plaid team, Items, and plan allowance. The deployment operator and running Vercel Function can decrypt these values; this is not a zero-knowledge secret vault. Each user is independently responsible for their Plaid account, plan, redirect settings, and terms.

Google authentication enables multi-account cloud access. A first ordinary sign-in creates an isolated ChipDue account. Password mode can instead link one Google identity to the original operator account; Google-only bootstrap serves the same purpose for pre-existing operator data without a password fallback. During each Google flow, the browser contacts Google and Google necessarily receives network and service metadata such as the IP address, time, requested `openid` scope, and ChipDue hostname. Google's consent screen also displays the User Support Email configured by the deployer and is reachable through the public login start; use a dedicated non-personal monitored alias or group whose membership is private. Google returns a short-lived authorization code to ChipDue's exact callback. The server exchanges and validates it, keeps only a keyed issuer-and-subject fingerprint and random tenant identifier, issues ChipDue's own opaque tenant-bound session, and discards the provider tokens.

The ChipDue application contains no analytics, advertising, telemetry, crash-reporting SDK, remote font, or webhook relay. It does not load Google JavaScript; the optional flow is an ordinary full-page redirect. Hosting and identity providers may retain infrastructure or authentication logs according to their plans and policies.

## Logs, caches, and browser storage

ChipDue does not intentionally log request or response bodies, cookies, tokens, account identifiers, card fields, database parameters, or raw provider errors. Financial data remains in browser memory only; the application does not use `localStorage`, `sessionStorage`, or IndexedDB for it.

Dashboard and API responses use `Cache-Control: no-store`. Local mode rejects non-loopback hosts by default. Cloud mode rejects any host not on its exact allowlist, rejects non-HTTPS forwarded requests, requires same-origin changes, and does not enable cross-origin API access.

## Recovery and backups

The cloud secret generator writes a recovery bundle to a caller-selected private path outside every Git checkout. It contains the initial password-mode login value and hash, AES key, and restricted database-role password. Google-only deployments leave the password values unconfigured and use a separate temporary bootstrap bundle. Treat either complete bundle as authentication or financial access: keep it in encrypted offline storage, never upload it to the repository or a CI artifact, and never give it to a preview deployment.

Neon backups and point-in-time recovery contain ChipDue ciphertext and metadata. They remain dependent on the separate AES key. Conversely, the recovery bundle cannot reconstruct a lost database. Keep independently protected copies of both and periodically test a restore without using production.

Losing the AES key makes existing encrypted account, bonus, card, and Plaid records unrecoverable. Replacing `CARDDUE_MASTER_KEY` does not rotate existing ciphertext; this release has no automatic bulk re-encryption workflow. Provider free-tier retention and availability are not permanent guarantees.

## Calendar exports

Calendar files omit monetary amounts by default. Cloud exports require an authenticated session, but the downloaded file becomes independent of ChipDue. If you include amounts or import the file into a cloud calendar, that calendar provider receives those values. Treat every `.ics` file as private financial data.

## Limits of protection

- A compromised operating system, browser, browser extension, Vercel runtime, Vercel account, or recovery bundle can access data ChipDue is able to display.
- A compromised linked Google account can authenticate to ChipDue. Protect it with phishing-resistant MFA. Password mode retains an independent recovery password; Google-only mode deliberately does not.
- Local encryption mainly reduces accidental disclosure and repository leakage because the key and database reside on the same computer.
- Cloud application encryption protects against a database-only disclosure, not a simultaneous Vercel runtime and database compromise.
- Plaid and connected institutions process information under their own terms and privacy policies.
- Account balances, holdings, liability fields, and transactions can be delayed, missing, modified, or incorrect. ChipDue never initiates or guarantees a payment or trade.
- Vercel, Neon, Google, Plaid, and their free-tier terms or identity policies can change. Local manual mode remains provider-independent.

## Delete your data

If Plaid is connected, disconnect each Item inside ChipDue first so the application can call Plaid's `/item/remove` endpoint. Then remove the associated ChipDue records.

For local mode, stop ChipDue and delete its platform application-data directory to erase the remaining database and local key.

For private cloud mode, deleting records removes them from the live Neon tables but may not immediately remove historical Neon restore points or provider backups. This release does not provide whole-account or Google-binding deletion in the dashboard; contact the deployment operator for a reviewed database deletion if the entire account and its encrypted Plaid configuration must be removed. To retire the whole instance, also delete every Neon branch and project, remove Vercel production environment variables and deployments, remove ChipDue from linked Google accounts' third-party connections, revoke Plaid Items and credentials, and destroy every recovery bundle and independent backup. Provider-retained logs or backups expire under the provider's retention policy rather than through ChipDue.

Deleting a Plaid Item does not necessarily restore a plan's lifetime Item allowance.
