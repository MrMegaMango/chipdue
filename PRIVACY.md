# Privacy policy

CardDue is built around data minimization. Manual entry is fully functional without Plaid, and local mode remains available without a hosted database.

## Deployment modes

### Local mode

Local mode is the default. CardDue runs as a loopback-only service for one trusted operating-system account. Its encrypted SQLite database and separate key file live in the platform application-data directory, outside the source checkout. The key file is created with owner-only permissions where the operating system supports them.

### Private cloud mode

Private cloud mode is an opt-in, single-owner deployment on Vercel backed by Neon Postgres. It is not a shared account, family service, public SaaS, or multi-user authorization model. The production hostname is public on the internet, but CardDue requires its owner password before returning financial APIs.

CardDue encrypts card payloads, Plaid access tokens, Plaid Item IDs, and institution names with AES-256-GCM inside the Vercel Function before sending them to Neon. Neon receives ciphertext plus limited operational metadata: opaque keyed identifiers, record source and status, schema version, timestamps, password-bound session-token hashes, and keyed rate-limit buckets. This metadata can still reveal approximate record counts, activity times, and whether records came from manual entry or Plaid.

The hosted design is not zero-knowledge or end-to-end encryption. Vercel stores the production database URL, encryption key, and password hash and supplies them to the running Function. That Function must decrypt records to display them or sync Plaid. A Neon-only database disclosure should not reveal the encrypted fields without the separate key; compromise of the Vercel project, runtime, owner account, or recovery bundle can expose them.

## Data CardDue keeps

CardDue stores only the fields required for reminders:

- A user-selected card nickname and optional issuer name
- Optional last four digits
- Statement balance, minimum payment, and current balance
- Statement date and next payment due date
- Autopay preference, source, and last-update time
- Opaque identifiers needed to update or delete records
- For Plaid connections, encrypted access tokens and Item IDs

It does not store full account numbers, credentials entered into Plaid Link, identity profiles, addresses, transaction history, or raw Plaid responses. Plaid responses are mapped immediately to the allowlisted reminder fields and then discarded.

## Network activity

In local manual mode, CardDue makes no application-level network requests after dependencies have been installed. Private cloud mode necessarily sends requests between the browser, Vercel, and Neon. Those providers process request or service metadata under their own policies even though Neon application records are ciphertext.

Plaid is optional in both modes. When you explicitly start Plaid Link:

- Your browser loads Plaid's Link SDK from `cdn.plaid.com`.
- Plaid and the selected financial institution handle authentication.
- A short-lived public token returns to the CardDue server.
- The server exchanges it and requests only Liabilities data from Plaid.
- CardDue maps the response to its minimal fields and discards the raw payload.

The CardDue application contains no analytics, advertising, telemetry, crash-reporting SDK, remote font, or webhook relay. Hosting providers may retain infrastructure logs according to their plans and policies.

## Logs, caches, and browser storage

CardDue does not intentionally log request or response bodies, cookies, tokens, account identifiers, card fields, database parameters, or raw provider errors. Financial data remains in browser memory only; the application does not use `localStorage`, `sessionStorage`, or IndexedDB for it.

Dashboard and API responses use `Cache-Control: no-store`. Local mode rejects non-loopback hosts by default. Cloud mode rejects any host not on its exact allowlist, rejects non-HTTPS forwarded requests, requires same-origin changes, and does not enable cross-origin API access.

## Recovery and backups

The cloud secret generator writes a recovery bundle to a caller-selected private path outside every Git checkout. It contains the initial login password, AES key, password hash, and restricted database-role password. Treat the complete bundle as plaintext financial access: keep it in encrypted offline storage, never upload it to the repository or a CI artifact, and never give it to a preview deployment.

Neon backups and point-in-time recovery contain CardDue ciphertext and metadata. They remain dependent on the separate AES key. Conversely, the recovery bundle cannot reconstruct a lost database. Keep independently protected copies of both and periodically test a restore without using production.

Losing the AES key makes existing encrypted card and Plaid records unrecoverable. Replacing `CARDDUE_MASTER_KEY` does not rotate existing ciphertext; this release has no automatic bulk re-encryption workflow. Provider free-tier retention and availability are not permanent guarantees.

## Calendar exports

Calendar files omit monetary amounts by default. Cloud exports require an authenticated session, but the downloaded file becomes independent of CardDue. If you include amounts or import the file into a cloud calendar, that calendar provider receives those values. Treat every `.ics` file as private financial data.

## Limits of protection

- A compromised operating system, browser, browser extension, Vercel runtime, Vercel account, or recovery bundle can access data CardDue is able to display.
- Local encryption mainly reduces accidental disclosure and repository leakage because the key and database reside on the same computer.
- Cloud application encryption protects against a database-only disclosure, not a simultaneous Vercel runtime and database compromise.
- Plaid and connected institutions process information under their own terms and privacy policies.
- Liability fields can be delayed, missing, or incorrect. CardDue never initiates or guarantees a payment.
- Vercel, Neon, Plaid, and their free-tier terms can change. Local manual mode remains provider-independent.

## Delete your data

If Plaid is connected, disconnect each Item inside CardDue first so the application can call Plaid's `/item/remove` endpoint. Then remove the associated CardDue records.

For local mode, stop CardDue and delete its platform application-data directory to erase the remaining database and local key.

For private cloud mode, deleting records removes them from the live Neon tables but may not immediately remove historical Neon restore points or provider backups. To retire the whole instance, also delete every Neon branch and project, remove Vercel production environment variables and deployments, revoke Plaid Items and credentials, and destroy every recovery bundle and independent backup. Provider-retained logs or backups expire under the provider's retention policy rather than through CardDue.

Deleting a Plaid Item does not necessarily restore a plan's lifetime Item allowance.
