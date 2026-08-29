# Security policy

## Reporting a vulnerability

Use GitHub's private security-advisory feature for vulnerabilities. Do not open a public issue containing credentials, financial records, institution names, account suffixes, private paths, screenshots, request traces, or raw API payloads.

If a secret has already been exposed, revoke or rotate it before doing anything else. Removing it from the latest commit is not sufficient because Git history and existing clones retain old objects.

## Supported version

Security fixes target the current `main` branch until versioned releases are introduced.

## Security boundaries

ChipDue supports a single-user local mode and a multi-account private cloud mode.

### Local mode

Local mode is intended for one trusted operating-system account. It binds to loopback and intentionally has no login layer. Do not expose local mode to a LAN, reverse proxy, public hostname, shared computer, or hosted platform. `CARDDUE_ALLOW_REMOTE=1` is an expert escape hatch, not a secure substitute for cloud mode.

### Private cloud mode

Private cloud mode supports isolated Google-backed accounts on Vercel with one Neon production database. Vercel's production domain is internet-accessible, so the server enforces an exact host allowlist, HTTPS, revocable tenant-bound sessions, login throttling, same-origin mutations, restricted content types, and no-store responses. Static page assets and the login shell may be public; financial APIs require a valid ChipDue session.

An ordinary validated Google sign-in creates an isolated account on first use. Password mode links a Google identity to the original operator account only from an already authenticated ChipDue session and binds the callback to that exact session. Google-only bootstrap has no password endpoint and exists to attach a Google identity to pre-existing operator data; it uses a locally generated 256-bit token accepted for one start, while Vercel configuration holds only the temporary verifier. ChipDue binds Google's validated issuer and `sub`, not an email address, using a master-keyed one-way fingerprint. The authorization-code flow uses PKCE S256, random one-time state and nonce values, a short-lived encrypted `__Host-` transaction cookie, an exact canonical callback, and Google's signed RS256 ID token. Provider tokens and profile claims are not retained. See [the Google-only guide](docs/GOOGLE_ONLY_AUTH.md) before migrating pre-existing data without password recovery.

A Google-to-ChipDue account binding is immutable through the application in this release; there is no unlink, move, or rebind UI. In password mode, removing both Google OAuth variables and redeploying disables Google login without erasing stored fingerprints. Google-only mode requires both variables, so removing them deliberately makes the whole application fail closed with `503` until a reviewed recovery configuration is deployed. Any identity reset requires explicit session invalidation and a separately reviewed database operation.

Google displays the OAuth User Support Email on a consent screen reachable from the public login start. Configure a dedicated non-personal monitored alias or Google Group, keep group membership private, and review the complete consent screen before linking. A personal support address is a public identity disclosure even though ChipDue itself never stores it.

Tenant isolation is enforced in the application by a random tenant ID bound into each session and an opaque keyed tenant reference on every shared financial row. Normal Neon reads and mutations require that indexed reference in SQL before ciphertext is returned, then independently verify ownership inside the encrypted payload or Plaid Item reference. The shared Neon schema does not use row-level security, so every new data path must preserve both checks. Do not expose a second hostname casually, disable the request guards, or rely on Vercel Deployment Protection as the production login.

The Neon runtime connection must use a direct, unpooled TLS URL and a dedicated, non-owner role with no role memberships, administrative attributes, settings, effective DDL, grant options, public privilege leakage, or access beyond ChipDue's compatibility-stable `carddue_*` tables. The application verifies that identity, privilege boundary, exact schema catalog, and version before use. An owner-capable direct, unpooled TLS migration URL is used only from a trusted local environment for explicit schema migrations. Neither URL may use a Neon hostname ending in `-pooler`, and the migration URL must never be added to Vercel, GitHub, CI, or a deployment preview.

## Secret handling

Infrastructure credentials are server-only and Production-only Vercel environment variables. Mark the database URL, AES key, password hash or temporary Google bootstrap verifier, Google client secret, and optional installation-level Plaid credentials as Sensitive. User-supplied Plaid and E*TRADE credentials are accepted only in authenticated, same-origin JSON requests and stored as server-encrypted database values. Preview and Development environments must receive no production database, key, password hash, bootstrap verifier, Google secret, migration URL, recovery bundle, or real provider credential.

Google secrets, saved Plaid and E*TRADE secrets, and provider tokens must never be returned to the browser. A user enters a provider secret in a password-type field and the Function necessarily processes that encrypted HTTPS body before encrypting it at rest; ChipDue does not log or echo it. The Google-only setup token follows the same handling constraints. Never place any credential in a variable beginning with `PUBLIC_` or `VITE_`, in a URL, or directly in a shell command.

An existing-role migration requires the protected old/current database password and a distinct desired replacement. Fresh-role creation uses a locally derived SCRAM verifier, but an existing-role rotation binds the desired plaintext only into a transaction-local setting, forces SCRAM password encryption, and performs a fixed dynamic self-password change without putting the value in SQL text or output. An owner-only catalog check returns only a boolean SCRAM confirmation. Neon necessarily sees the bind and remains trusted for authentication, bind and database processing, catalog results, and storage. Do not update the deployed runtime URL or recovery record until the migration has proved the new login, the old credential's authentication rejection, termination with zero remaining direct role backends, and the exact role and catalog boundary. Rejection requires SQLSTATE `28P01`; when the pinned Neon driver omits SQLSTATE, only its observed exact `NeonDbError` shape (an own empty `code` and the exact role-specific authentication message) is accepted. Any provider or driver change fails closed.

Application encryption limits a Neon-only disclosure, but the running Vercel Function has the AES key and can decrypt records. It does not protect against compromise of Vercel runtime access, the Vercel owner account, or the recovery bundle. Loss of the AES key makes encrypted records permanently unreadable.

## Operational responsibilities

- Enable phishing-resistant MFA where available for GitHub, Vercel, Neon, Google, each user's Plaid and E*TRADE accounts, and the password manager holding the recovery bundle.
- Keep production secrets out of pull-request and preview builds, logs, screenshots, tickets, and support transcripts.
- Run the publishing and deployment verification checklists before publishing code or entering real data.
- Maintain an encrypted off-provider backup and test restoration. Neon restore history alone is not a durable recovery plan.
- Disconnect Plaid Items before destroying the database so ChipDue can revoke their access tokens.
- Disconnect E*TRADE and forget its stored credentials before destroying the database.
- Treat a leaked database URL, AES key, login password, session or OAuth transaction cookie, Google client secret, Google bootstrap token, verifier or bundle, Plaid or E*TRADE credential or token, or recovery bundle as an incident and rotate or revoke every affected credential before public discussion. If bootstrap has not completed, replace the verifier with a fresh protected bundle and redeploy before any setup attempt; remove or host-deny every deployment retaining the exposed verifier.

Review [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the complete boundary and assumptions.
