# Privacy policy

CardDue is built around data minimization. Manual entry is fully functional without Plaid, and local mode remains available without a hosted database.

## Deployment modes

### Local mode

Local mode is the default. CardDue runs as a loopback-only service for one trusted operating-system account. Its encrypted SQLite database and separate key file live in the platform application-data directory, outside the source checkout. The key file is created with owner-only permissions where the operating system supports them.

### Private cloud mode

Private cloud mode is an opt-in, single-owner deployment on Vercel backed by Neon Postgres. It is not a shared account, family service, public SaaS, or multi-user authorization model. The production hostname is public on the internet, but CardDue requires the configured password or the one explicitly bound Google identity before returning financial APIs. Explicit Google-only mode has no CardDue password endpoint.

CardDue encrypts card payloads, Plaid access tokens, Plaid Item IDs, and institution names with AES-256-GCM inside the Vercel Function before sending them to Neon. Neon receives ciphertext plus limited operational metadata: opaque keyed identifiers, record source and status, schema version, timestamps, authentication-config-bound keyed session-token hashes, keyed rate-limit buckets, short-lived keyed OAuth transaction markers, an opaque Google-only bootstrap claim state when used, and—if Google is linked—one keyed Google identity fingerprint. It never receives the raw setup token, Google subject, or email from CardDue. This metadata can still reveal approximate record counts, activity times, and whether records came from manual entry or Plaid.

The hosted design is not zero-knowledge or end-to-end encryption. Vercel stores the production database URL, encryption key, and the selected authentication configuration: a password hash in password mode, or Google credentials plus a temporary bootstrap verifier during Google-only setup. The Function must decrypt records to display them or sync Plaid. A Neon-only database disclosure should not reveal the encrypted fields without the separate key; compromise of the Vercel project, runtime, owner account, or recovery material can expose them.

## Data CardDue keeps

CardDue stores only the fields required for reminders:

- A user-selected card nickname and optional issuer name
- Optional last four digits
- Statement balance, minimum payment, and current balance
- Statement date and next payment due date
- Autopay preference, source, and last-update time
- Opaque identifiers needed to update or delete records
- For Plaid connections, encrypted access tokens and Item IDs
- For optional Google sign-in, a keyed one-way fingerprint of Google's issuer and stable subject

It does not store full account numbers, credentials entered into Plaid Link, identity profiles, addresses, transaction history, or raw Plaid responses. Plaid responses are mapped immediately to the allowlisted reminder fields and then discarded.

When Google sign-in is enabled, CardDue does not request or store the Google email, name, picture, profile, access token, ID token, or refresh token. A short-lived encrypted browser cookie carries the OAuth state, nonce, PKCE verifier, intent, expiry, and either the initiating CardDue session or an opaque bootstrap-claim reference. The raw Google-only setup token is never stored in that cookie or in Neon. The cookie is cleared at callback; a validated one-time database marker is atomically consumed, while abandoned markers expire and are pruned.

The linked fingerprint cannot be removed or replaced through the application in this release. Removing both Google OAuth environment variables and redeploying disables Google login but leaves that opaque fingerprint in Neon backups and the live metadata row. A reviewed database recovery procedure is required to erase or replace the binding.

## Network activity

In local manual mode, CardDue makes no application-level network requests after dependencies have been installed. Private cloud mode necessarily sends requests between the browser, Vercel, and Neon. Those providers process request or service metadata under their own policies even though Neon application records are ciphertext.

Plaid is optional in both modes. When you explicitly start Plaid Link:

- Your browser loads Plaid's Link SDK from `cdn.plaid.com`.
- Plaid and the selected financial institution handle authentication.
- A short-lived public token returns to the CardDue server.
- The server exchanges it and requests only Liabilities data from Plaid.
- CardDue maps the response to its minimal fields and discards the raw payload.

Google authentication is optional in private cloud mode. Password mode first links it only from an existing CardDue session. Google-only mode instead uses a temporary high-entropy operator setup token and has no password fallback. During each Google flow, the browser contacts Google and Google necessarily receives network and service metadata such as the IP address, time, requested `openid` scope, and CardDue hostname. Google's consent screen also displays the User Support Email configured by the deployer and is reachable through the public login start; use a dedicated non-personal monitored alias or group whose membership is private. Google returns a short-lived authorization code to CardDue's exact callback. The server exchanges and validates it, keeps only a keyed issuer-and-subject fingerprint for the linked owner, issues CardDue's own opaque session, and discards the provider tokens.

The CardDue application contains no analytics, advertising, telemetry, crash-reporting SDK, remote font, or webhook relay. It does not load Google JavaScript; the optional flow is an ordinary full-page redirect. Hosting and identity providers may retain infrastructure or authentication logs according to their plans and policies.

## Logs, caches, and browser storage

CardDue does not intentionally log request or response bodies, cookies, tokens, account identifiers, card fields, database parameters, or raw provider errors. Financial data remains in browser memory only; the application does not use `localStorage`, `sessionStorage`, or IndexedDB for it.

Dashboard and API responses use `Cache-Control: no-store`. Local mode rejects non-loopback hosts by default. Cloud mode rejects any host not on its exact allowlist, rejects non-HTTPS forwarded requests, requires same-origin changes, and does not enable cross-origin API access.

## Recovery and backups

The cloud secret generator writes a recovery bundle to a caller-selected private path outside every Git checkout. It contains the initial password-mode login value and hash, AES key, and restricted database-role password. Google-only deployments leave the password values unconfigured and use a separate temporary bootstrap bundle. Treat either complete bundle as authentication or financial access: keep it in encrypted offline storage, never upload it to the repository or a CI artifact, and never give it to a preview deployment.

Neon backups and point-in-time recovery contain CardDue ciphertext and metadata. They remain dependent on the separate AES key. Conversely, the recovery bundle cannot reconstruct a lost database. Keep independently protected copies of both and periodically test a restore without using production.

Losing the AES key makes existing encrypted card and Plaid records unrecoverable. Replacing `CARDDUE_MASTER_KEY` does not rotate existing ciphertext; this release has no automatic bulk re-encryption workflow. Provider free-tier retention and availability are not permanent guarantees.

## Calendar exports

Calendar files omit monetary amounts by default. Cloud exports require an authenticated session, but the downloaded file becomes independent of CardDue. If you include amounts or import the file into a cloud calendar, that calendar provider receives those values. Treat every `.ics` file as private financial data.

## Limits of protection

- A compromised operating system, browser, browser extension, Vercel runtime, Vercel account, or recovery bundle can access data CardDue is able to display.
- A compromised linked Google account can authenticate to CardDue. Protect it with phishing-resistant MFA. Password mode retains an independent recovery password; Google-only mode deliberately does not.
- Local encryption mainly reduces accidental disclosure and repository leakage because the key and database reside on the same computer.
- Cloud application encryption protects against a database-only disclosure, not a simultaneous Vercel runtime and database compromise.
- Plaid and connected institutions process information under their own terms and privacy policies.
- Liability fields can be delayed, missing, or incorrect. CardDue never initiates or guarantees a payment.
- Vercel, Neon, Google, Plaid, and their free-tier terms or identity policies can change. Local manual mode remains provider-independent.

## Delete your data

If Plaid is connected, disconnect each Item inside CardDue first so the application can call Plaid's `/item/remove` endpoint. Then remove the associated CardDue records.

For local mode, stop CardDue and delete its platform application-data directory to erase the remaining database and local key.

For private cloud mode, deleting records removes them from the live Neon tables but may not immediately remove historical Neon restore points or provider backups. To retire the whole instance, also delete every Neon branch and project, remove Vercel production environment variables and deployments, remove CardDue from the linked Google account's third-party connections, revoke Plaid Items and credentials, and destroy every recovery bundle and independent backup. Provider-retained logs or backups expire under the provider's retention policy rather than through CardDue.

Deleting a Plaid Item does not necessarily restore a plan's lifetime Item allowance.
