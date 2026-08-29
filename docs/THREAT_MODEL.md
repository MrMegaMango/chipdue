# Threat model

## Goal

Prevent ChipDue's source repository, Git history, CI, logs, browser storage, and normal runtime behavior from disclosing account, bonus, investment, card, or credential data.

ChipDue has a single-user local mode and a multi-account cloud mode. They do not share the same trust boundary.

## Architecture and trust boundaries

### Local mode

```text
Browser memory -> loopback SvelteKit server -> encrypted SQLite
                                              separate local key file
```

The operating-system account and browser are trusted. The service has no application login because non-loopback access is rejected by default. The encrypted database and key are both on the same computer; encryption primarily protects against accidental copying and repository leakage.

### Private cloud mode

```text
Browser memory -> Vercel edge and authenticated Function -> ciphertext in Neon
                                      |
                                      +-> Plaid when configured and invoked
                                      +-> E*TRADE when configured and its data is requested
                                      +-> Yahoo Finance when estimated history is built
                                      +-> Google during optional authentication

Offline recovery material -> AES key and runtime DB password
                         +-> password/hash in password mode
                         +-> temporary token/verifier during Google-only bootstrap
```

The Vercel Function is inside the confidentiality boundary. It receives the AES key and decrypts records after authentication. Neon is outside that plaintext boundary: it stores encrypted payloads and limited operational metadata. A database-only attacker should not recover encrypted fields, but a Vercel runtime or owner-account attacker can obtain the key and data.

The hosted model has one production hostname, one Vercel project, and one Neon production database. A password, when configured, opens only the pre-existing operator tenant. Each validated Google identity maps to a separate random tenant and tenant-bound session. Shared financial rows carry an indexed, opaque keyed tenant reference used by every normal SQL read and mutation, while encrypted payloads and Plaid Item references provide a second ownership check. There is no account sharing, delegated access, administrator data UI, or public API client. Preview builds are nonfunctional for real data because they receive no cloud, Google, bootstrap, or Plaid secrets.

## Assets

- Account and card nicknames, optional institution/issuer names and suffixes, current and historical brokerage balances, net contributions, brokerage cost basis, dates, autopay settings, and enabled transaction history
- Plaid access tokens, Item IDs, transaction cursors, institution names, and derived account references
- E*TRADE consumer credentials, request and access tokens, open orders held in browser memory, and encrypted reconstructed history
- The cloud AES key, mode-specific password hash or temporary bootstrap token/verifier, session and OAuth transaction cookies, and recovery bundles
- Neon runtime and migration database credentials
- Optional Google OAuth client secret and linked-identity fingerprint
- The Google OAuth consent screen's public support contact and branding metadata
- Optional installation-level Plaid credentials and encrypted per-tenant Plaid and E*TRADE credentials and tokens
- Backups, calendar exports, logs, screenshots, and browser memory containing rendered data

## In-scope threats

- Accidental commits of credentials, databases, exports, logs, screenshots, and personal metadata
- Client-side exposure of server credentials or provider tokens
- Excessive collection or retention from Plaid or E*TRADE responses, or unintended disclosure to the historical-price service
- Public-internet password guessing where enabled, bootstrap-token theft/racing, session theft, host-header abuse, and cross-origin requests
- Cross-tenant reads, writes, deletes, provider requests, or use of another tenant's provider credentials
- Google account substitution, authorization-response mix-up, callback CSRF, code interception, and replay
- Accidental publication of the owner's personal email or identity through Google OAuth consent branding
- Preview, pull-request, build, or CI code gaining production secrets
- Disclosure of a Neon database, branch, restore point, or backup without the Vercel key
- Excessive Neon privileges or accidental use of an owner-capable runtime connection
- Owner migration credentials persisting in Vercel, CI, a command line, or shell history
- Leakage through Vercel logs, URLs, provider diagnostics, CDN caches, or generated deployment output
- Casual LAN exposure of local mode
- Sensitive browser caching or persistent browser storage
- Leaks through test fixtures, diagnostics, CI artifacts, and Git author metadata
- Loss of the AES key, database, or recovery material

## Assumptions

- Local mode runs under one trusted operating-system account on a trusted computer.
- Cloud mode is used only on the exact configured HTTPS hostname.
- Infrastructure operators secure GitHub, Vercel, Neon, Google OAuth configuration, and recovery storage; each user secures their own Google, Plaid, and E*TRADE accounts with unique credentials and MFA.
- Vercel is trusted to execute the application and protect Production environment variables. Neon is trusted for database availability and platform controls but is not entrusted with plaintext application fields.
- npm, Vercel, Neon, and optional Google, Plaid, E*TRADE, and Yahoo Finance integrations are trusted dependencies or processors within their documented roles.
- Production secrets are never assigned to Preview or Development, and untrusted changes are never deployed with them.
- The dedicated Neon runtime role was created directly with SQL, not through Neon Console, CLI, or API role creation that grants `neon_superuser` membership. Provisioning verifies that it has no memberships, administrative attributes, effective DDL, or access outside ChipDue's compatibility-stable `carddue_*` tables.
- The user verifies payment details with the card issuer.

## Controls

| Risk                                     | Control                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime files enter Git                  | Local data and cloud recovery material live outside the checkout; broad ignore rules; filename, content, and full-history scanning                                                                                                                                                                          |
| Git identity reveals a private email     | Repository-local noreply identity and privacy checks                                                                                                                                                                                                                                                        |
| Production secrets reach a preview       | Every secret is scoped to Vercel Production; previews receive no real database, AES key, auth verifier, Google secret, or Plaid credentials                                                                                                                                                                 |
| A client bundle contains credentials     | Server-only modules and environment access; no credential uses a `PUBLIC_` or `VITE_` prefix; generated bundles are inspected                                                                                                                                                                               |
| Neon is disclosed                        | AES-256-GCM payload encryption with random nonces and purpose/record-bound authenticated data; key remains in Vercel and offline recovery storage                                                                                                                                                           |
| Neon metadata reveals too much           | Plaintext schema is limited to opaque keyed IDs, source/status, schema version, and operational timestamps; raw financial fields stay in encrypted payloads                                                                                                                                                 |
| Runtime DB credentials can change schema | Cold-start identity, role, exact privilege, public/column grant, unrelated-access, and schema-catalog verification; explicit DML only for compatibility-stable `carddue_*` tables                                                                                                                           |
| Migration authority reaches the app      | Owner migration URL exists only in a temporary protected local environment and is never configured in Vercel or CI                                                                                                                                                                                          |
| Public requests bypass authentication    | Every private cloud API is authorized server-side; sessions are random, stored only as keyed hashes, auth-config-bound, expiring, revocable, Secure, HTTP-only, and SameSite Strict                                                                                                                         |
| One user reads or changes another's data | Session tenant IDs are propagated through request-local context; indexed keyed ownership references constrain normal SQL reads and mutations before ciphertext is loaded; encrypted payload and Plaid Item ownership are checked again; isolation tests cover the database boundary and cross-tenant access |
| Password guessing                        | Password mode uses a memory-hard hash, generic failures, persistent keyed rate-limit buckets, and a bounded lockout window                                                                                                                                                                                  |
| Google identity is mapped incorrectly    | Normal sign-in uses a keyed issuer/subject fingerprint with an immutable tenant mapping; operator linking requires an exact ChipDue session; legacy bootstrap requires a one-start 256-bit token                                                                                                            |
| OAuth callback is injected or replayed   | Exact redirect and response issuer; PKCE S256; random nonce/state; encrypted short-lived host-only cookie; atomic one-time server marker; strict claim and subject checks                                                                                                                                   |
| Google identity leaks through storage    | Only a master-keyed fingerprint of normalized issuer and `sub` is stored; email/profile/provider tokens are neither requested nor retained                                                                                                                                                                  |
| OAuth branding identifies the owner      | Use a dedicated non-personal monitored support alias/group with private membership; review the publicly reachable consent screen before linking                                                                                                                                                             |
| Host-header or stale deployment access   | Exact lower-case production authority allowlist; generated, preview, old, and unexpected hosts fail closed                                                                                                                                                                                                  |
| Transport downgrade                      | Cloud requests require HTTPS as reported by the Vercel proxy; Vercel terminates public TLS; Neon URLs must require TLS                                                                                                                                                                                      |
| Cross-site mutation                      | Exact Origin validation, Fetch Metadata rejection, same-origin requests, JSON-only bounded bodies, and no CORS                                                                                                                                                                                              |
| Browser or CDN retains data              | Global `no-store` responses; no localStorage, sessionStorage, IndexedDB, service worker, or user-data prerendering                                                                                                                                                                                          |
| Raw provider data expands exposure       | Google uses `openid` only and tokens are discarded; Plaid fields are allowlisted and encrypted; E*TRADE responses are allowlisted and discarded after use; orders remain only in browser memory; reconstructed points are encrypted; raw responses are not logged                                           |
| Price lookup leaks financial context     | Yahoo Finance receives only one allowlisted ticker and date range per request, without account identifiers, quantities, balances, or transaction details                                                                                                                                                    |
| Logs reveal secrets or records           | Sanitized error envelopes; no intentional request bodies, cookies, query parameters, SQL values, decrypted fields, or raw provider errors in logs                                                                                                                                                           |
| CI or releases publish private artifacts | Synthetic fixtures, no production secrets, no private artifact upload, privacy scan, clean build, full-history scan, and mandatory verified Vercel build wrapper                                                                                                                                            |
| Calendar action expands disclosure       | Google drafts require an explicit per-event click and omit balances, amounts, and card numbers; authenticated `.ics` files omit amounts and are documented as private                                                                                                                                       |
| Local service becomes network-accessible | Development and production commands bind to loopback; raw authorities are validated; remote override is explicitly unsupported as a security boundary                                                                                                                                                       |
| Backup or key is lost                    | Offline recovery bundle plus independent encrypted database backup; restore is tested away from production                                                                                                                                                                                                  |

## Residual risk and explicit limitations

- Malware or an attacker controlling the local operating-system account
- A compromised browser extension
- A compromised Vercel owner account, Function runtime, build supplied with Production secrets, or recovery bundle; each can access the cloud AES key
- Simultaneous compromise of Neon ciphertext and the Vercel or recovery copy of the AES key
- Compromise, malicious behavior, outage, suspension, or retention failures by Vercel, Neon, Google, Plaid, E*TRADE, Yahoo Finance, or a connected institution
- A compromised Google account authenticating to its bound ChipDue tenant; the original password tenant may retain an independent recovery password, while Google-only users do not
- An unlocked browser with an active Google session can reuse ambient Google SSO after ChipDue logout; shared-device containment also requires signing out of Google and locking the browser or operating-system profile
- No in-application whole-account deletion, Google unlink, or rebind flow; these require a reviewed database operation and explicit session invalidation
- Immediate deletion from provider restore points, infrastructure logs, or already-created independent backups
- Recovery after losing both the Neon data and all backups, or after losing every copy of the AES key
- Transparent master-key rotation; changing the configured key makes existing ciphertext unreadable
- Account sharing, delegated administration, public APIs, LAN-hosted local mode, or production use on arbitrary preview URLs
- Tenant isolation is application-enforced rather than PostgreSQL row-level security; a future query that omits the required keyed SQL predicate and the independent decode/access check could create cross-tenant exposure or deletion
- Strong denial-of-service protection beyond application login throttling and provider limits
- A stolen restricted database credential can delete rows, change unencrypted operational fields, or replay an older valid ciphertext for the same record; record-bound authentication prevents cross-record swaps but does not provide freshness
- Initiating or guaranteeing credit-card payments

## Changes that require a new review

Revisit this model before adding account sharing, an administrator data UI, another authentication provider, webhook, analytics or error-reporting service, public API, second production hostname, non-Vercel host, non-Neon database, client-side persistence, another background job, automatic email/calendar delivery, production preview data, or another party with infrastructure access. Changing the encryption envelope or key requires a tested migration and rollback design before deployment.
