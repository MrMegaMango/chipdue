# Deploy a private Vercel instance

This guide deploys ChipDue's hosted topology: one reviewed Vercel production project, one exact production hostname, and one Neon production database serving isolated Google-backed accounts. The production URL is reachable from the internet. ChipDue's authentication, tenant checks, and server-side request guards protect the records; obscurity and Vercel preview protection do not.

Use [local mode](../README.md#start-locally) instead if you do not want Vercel to hold the decryption key or do not want an internet-facing login.

## Security model

- The browser sends authenticated requests to a Vercel Function over HTTPS.
- The Function holds the AES key and decrypts records after login.
- Neon stores AES-256-GCM ciphertext plus limited operational metadata.
- The Neon runtime role connects through a direct, unpooled TLS URL. It can read and change ChipDue's compatibility-stable `carddue_*` table rows but cannot migrate the schema.
- An owner-capable direct, unpooled Neon TLS URL is used only for explicit migration from a trusted local environment.
- Vercel Preview and Development receive no real database, key, authentication verifier, recovery bundle, Google secret, or Plaid credentials.
- Google is optional for the original password-backed operator account and is required to create additional accounts. Sign-in shares no financial fields; the separate Calendar action sends only a user-selected card nickname and due date.
- Plaid is optional. Each user can supply an independent Plaid Production team from the dashboard; manual entry works without Plaid.

This design limits a Neon-only disclosure. It does not protect data from someone who controls the Vercel project, production build, Function runtime, owner session, or recovery bundle.

Neon remains inside the trusted service boundary. Fresh-role creation uses a locally derived SCRAM verifier. Existing-role rotation sends the desired plaintext only as a bound value for a transaction-local setting, never as SQL text or command output. Neon necessarily sees that bind and still processes authentication, database operations, catalogs, and stored data.

## Before provisioning

1. Read [PRIVACY.md](../PRIVACY.md), [SECURITY.md](../SECURITY.md), and [THREAT_MODEL.md](THREAT_MODEL.md).
2. Run the complete [publishing checklist](PUBLISHING.md) and `npm run ci` from a credential-free checkout.
3. Protect GitHub, Vercel, Neon, Google, the password manager, and optional Plaid account with unique credentials and phishing-resistant MFA where available.
4. Restrict infrastructure project membership to trusted operators. End users need only a ChipDue session and never receive Vercel or Neon access. Review installed GitHub and Vercel integrations before any production build receives secrets.
5. Choose a Neon region near the Vercel Function region configured in `vite.config.ts`. Cross-region traffic adds latency and expands operational dependencies.
6. Prepare encrypted offline storage for the recovery bundle and a separate encrypted location for database backups. Neither location may be inside or symlinked into a Git checkout, cloud-synced source tree, CI workspace, or Vercel project.

Do not put a credential directly in a command argument, URL copied into shell history, issue, chat, screenshot, or documentation. Use password prompts, provider dashboards, or a protected temporary environment file. Do not use `vercel env pull` for this project.

## 1. Generate and protect recovery material

Run the repository's `cloud:secrets` script with its required `--output` argument pointing to an absolute path in the prepared private directory. A safe invocation supplies only a path variable on the command line:

```sh
npm run cloud:secrets -- --output "$ABSOLUTE_PRIVATE_OUTPUT_PATH"
```

The script refuses relative paths, linked ancestors, Git worktrees, existing output files, and insecure existing directories on POSIX systems. It creates a new owner-only file and prints no generated value.

The JSON bundle contains four independent fields:

- `loginPassword`: enter this only in ChipDue's login form in password mode; Google-only mode does not configure or accept it.
- `masterKey`: configure this as `CARDDUE_MASTER_KEY` in Vercel Production.
- `ownerPasswordHash`: configure this as `CARDDUE_OWNER_PASSWORD_HASH` only in password mode. Keep it out of Google-only Vercel configuration.
- `databaseRolePassword`: give this to the migration process as `CARDDUE_DATABASE_PASSWORD` and use it inside the restricted runtime `DATABASE_URL`.

Do not upload the entire bundle to Vercel. Keep an encrypted offline copy after the deployment is verified. Anyone with the bundle and a database copy can decrypt records and impersonate the owner. Losing every copy of `masterKey` makes existing data unrecoverable.

## 2. Create the Neon project

Create one production Neon project directly. Do not enable automatic production-data branches for Vercel previews. Record the database name privately. Every ChipDue database URL must use Neon's direct, unpooled endpoint and exactly one `sslmode=require` or `sslmode=verify-full` parameter. A hostname whose endpoint label ends in `-pooler` is rejected even when it requires TLS; do not use a pooled URL for migration, verification, or runtime traffic.

Neon roles created through its Console role-creation control, CLI, or API can inherit `neon_superuser`. Do not create the ChipDue runtime role with any of them. The reviewed ChipDue migration connects through the separate owner URL and creates or rotates the role directly with restricted SQL. It then verifies the result before granting table access.

Keep two distinct direct, unpooled TLS connection strings:

- The owner-capable URL is `CARDDUE_MIGRATION_DATABASE_URL`. It is temporary local migration authority and never enters Vercel.
- The role-specific URL for `carddue_runtime`, constructed after migration with `databaseRolePassword`, is `DATABASE_URL`. It is the only database URL given to the application.

Do not substitute the Neon owner connection string for `DATABASE_URL`, even briefly. Do not convert either URL to its `-pooler` variant.

## 3. Provision the schema

Create a temporary environment file outside the checkout with owner-only filesystem permissions. For first-time provisioning of a role that does not exist, put only these process values in it:

- `CARDDUE_MIGRATION_DATABASE_URL`: the direct, unpooled Neon owner URL requiring TLS
- `CARDDUE_DATABASE_ROLE`: a new lowercase role such as `carddue_runtime`
- `CARDDUE_DATABASE_PASSWORD`: the desired generated `databaseRolePassword` from the recovery bundle

When the named role already exists, the protected migration process requires both password values in addition to the owner URL and role:

- `CARDDUE_CURRENT_DATABASE_PASSWORD`: the generated 256-bit base64url password accepted by the runtime role before migration
- `CARDDUE_DATABASE_PASSWORD`: a fresh generated 256-bit base64url password desired after migration; it must be different from the current value

Treat these as old/current and new/desired credentials, respectively. Do not overwrite the deployed `DATABASE_URL` or recovery record with the desired value before the migration and verification gates succeed. The migration refuses an existing role that does not already satisfy the restricted preflight boundary.

The role name must begin with `carddue_`, contain only lowercase letters, digits, and underscores, and must not contain `owner`. Do not pre-create it through Neon Console, CLI, or API.

If a password manager or other trusted secret runner injects the required values into only the migration child process, run the supported package entry point:

```sh
npm run cloud:migrate
```

With the protected environment file described above, invoke the same migration script by having Node read the file, so the owner URL does not appear in command history:

```sh
node --env-file="$PRIVATE_MIGRATION_ENV_PATH" scripts/migrate-cloud.mjs
```

For a fresh role, the migration derives a PostgreSQL SCRAM verifier locally and creates the restricted role with that verifier. For an existing role, it does not send a precomputed verifier. After the current credential proves the exact runtime identity, the migration sends the desired plaintext only as a bind into a transaction-local setting, forces `password_encryption` to `scram-sha-256` in that transaction, performs the fixed dynamic self-password `ALTER ROLE` for the already verified role, and clears the setting. The migration never interpolates the desired plaintext into SQL, prints it, or writes a credential file. This is query and log minimization, not protection from the provider: Neon necessarily sees the bound value and remains trusted for connection authentication, bind and database processing, and catalog results.

`npm run cloud:migrate` always performs a distinct credential rotation when the runtime role already exists. It terminates that role's database sessions and can briefly interrupt application access. It is not a routine health check: use `npm run cloud:verify` for that. After every successful existing-role migration, update the protected recovery record, local runtime URL, and Vercel `DATABASE_URL` to the new credential, then redeploy; leaving any one of them unchanged leaves it unable to connect.

An existing-role rotation is accepted only after a direct login with the desired credential resolves to the exact runtime role and a direct login with the old credential is specifically rejected. PostgreSQL SQLSTATE `28P01` is the primary proof. The pinned Neon driver can omit SQLSTATE; in that case the migration accepts only its observed exact `NeonDbError` shape: an own empty `code` and the exact role-specific authentication-failure message. Any near match, network failure, other SQLSTATE, or future provider/driver shape fails closed. Confirm the rejection independently with a direct `psql` connection during a production credential rotation. Every migration terminates the role's other direct database backends and requires every termination to succeed with zero matching backends remaining. An owner-only catalog query returns only a boolean confirming that PostgreSQL stored SCRAM authentication material; it does not return the verifier. The migration then verifies the exact restricted role boundary and exact schema catalog before recording the schema version. It fails closed on memberships, ownership, inheritance, administrative flags, role or database settings, unrelated relation, sequence, or function access, effective DDL, grant options, public grants, or unexpected table and column privileges. A partial, drifted, or future schema is refused rather than relabeled. The metadata table intentionally lacks runtime `DELETE`; mutable application tables receive `SELECT`, `INSERT`, `UPDATE`, and `DELETE` only.

After a successful migration:

1. Confirm the migration exits successfully and reports the expected schema version and restricted role. For an existing role, this success includes the desired-login, exact old-credential authentication rejection described above, backend termination, zero-remaining-backend, exact-role, and exact-catalog gates above. Independently confirm the old credential is rejected by a direct `psql` connection without putting it in command arguments or output.
2. Construct the restricted direct runtime URL with the desired password as described below. Place only `DATABASE_URL` in a second owner-only temporary environment file and run `node --env-file="$PRIVATE_RUNTIME_ENV_PATH" scripts/verify-cloud-runtime.mjs`.
3. Confirm runtime verification logs in as the restricted role and reports the expected schema version without revealing the role or URL. This independently rechecks the exact identity, privilege boundary, and catalog through the runtime credential.
4. For an existing deployment, only after steps 1 through 3 succeed, replace the protected production `DATABASE_URL` and the offline recovery record's `databaseRolePassword` with the desired value. Redeploy before expecting the application to reconnect; the old credential and terminated sessions must remain unusable.
5. Remove both temporary environment files using an appropriate secure deletion or encrypted-volume workflow.
6. Confirm the owner URL and both migration-only password variables are absent from the repository, shell history, Vercel, GitHub, CI, editor history, and clipboard manager.
7. Retain the owner URL only in a password manager if future migrations require it.

Construct the runtime `DATABASE_URL` from the same direct, unpooled Neon host and database using `carddue_runtime`, `databaseRolePassword`, and exactly one `sslmode=require` or `sslmode=verify-full` parameter. The endpoint label must not end in `-pooler`. Do this only in a password manager or Vercel's protected field; do not assemble or print the URL in a shell command. Before database use, each production Function instance verifies that the URL, SQL `current_user`, and `session_user` name the same dedicated role; rechecks the complete non-owner privilege boundary; verifies the exact table, column, constraint, index, and safety catalog; and checks the schema version. It never runs DDL. Apply future schema migrations explicitly with reviewed code and the owner URL before deploying code that requires the new version.

## 4. Create the Vercel project without data

Import the reviewed repository into a personal Vercel project. Vercel Hobby is intended for personal, noncommercial use and its quotas and terms can change.

Configure:

- Node.js 22 or the version required by `package.json`
- Keep the committed `vercel.json` build command unchanged: `npm run build:vercel`
- No production override that weakens the adapter, security headers, or configured Function region
- Vercel Deployment Protection for Preview and generated deployment URLs where available

Allow the first credential-free build to complete. It is expected to have no usable private-cloud runtime because the fail-closed cloud configuration is not present. Choose one stable canonical production hostname: either the stable project production domain or one custom domain. Do not treat an immutable deployment URL as the canonical hostname.

Both the committed Vercel command and an ordinary `npm run build` when `VERCEL=1` enter the same reviewed wrapper. The wrapper refuses checkout `.env*` files other than a regular `.env.example`, runs the Vercel adapter, then verifies the completed output. It fails if dependency tracing copied a private-home directory, database, credential-like artifact, source map, private path, configured secret-like environment value, compact token, or private-key material. `vercel.json` is a second fail-closed layer; confirm the Vercel dashboard has not overridden its build command. Never configure a direct `vite build` command.

## 5. Add Production-only environment variables

Use the Vercel dashboard's protected input rather than CLI arguments. Scope every item below to **Production only**. Mark the database URL, AES key, password hash or bootstrap verifier, Google client secret, and Plaid credentials as **Sensitive**.

| Name                            | Value and rule                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CARDDUE_MODE`                  | Exactly `cloud`                                                                                 |
| `DATABASE_URL`                  | Restricted direct, unpooled `carddue_runtime` URL; exactly one supported TLS mode               |
| `CARDDUE_MASTER_KEY`            | `masterKey` from the recovery bundle                                                            |
| `CARDDUE_AUTH_MODE`             | Optional `password` default, or explicit `google`; never another value                          |
| `CARDDUE_OWNER_PASSWORD_HASH`   | Required only in password mode; forbidden in Google-only mode                                   |
| `CARDDUE_ALLOWED_HOSTS`         | The one canonical lowercase authority only; no scheme, path, wildcard, comma, or trailing slash |
| `CARDDUE_SESSION_TTL_HOURS`     | Optional integer from 1 through 720; default is 24                                              |
| `CARDDUE_ADMIN_EMAIL`           | Legacy optional recipient for the access-request endpoint                                       |
| `CARDDUE_GOOGLE_CLIENT_ID`      | Optional Google Web OAuth client ID; configure only together with its secret                    |
| `CARDDUE_GOOGLE_CLIENT_SECRET`  | Optional Google Web OAuth client secret; configure only together with its ID                    |
| `CARDDUE_GOOGLE_BOOTSTRAP_HASH` | Temporary Google-only first-owner verifier; remove immediately after successful setup           |
| `CRON_SECRET`                   | Random Sensitive value of at least 16 characters; required for scheduled Plaid synchronization  |

Never configure these in Vercel:

- `CARDDUE_MIGRATION_DATABASE_URL`
- `CARDDUE_DATABASE_ROLE`
- `CARDDUE_CURRENT_DATABASE_PASSWORD`
- `CARDDUE_DATABASE_PASSWORD` as a separate variable; its value is already the password component of restricted `DATABASE_URL`
- `CARDDUE_ALLOW_REMOTE`
- `loginPassword`
- The recovery bundle itself
- `googleBootstrapToken` or the Google bootstrap bundle

Do not give Preview or Development a synthetic copy of production secrets. In this design they get no ChipDue cloud variables at all, so a preview cannot connect to, decrypt, or imitate the real instance. The stable production hostname is allowlisted; generated, preview, old, and unexpected deployment hosts are intentionally rejected even if a deployment still exists.

Environment variables are available to production build and runtime code. Review the exact production commit, lockfile, dependencies, install scripts, and Vercel integrations before redeploying. A malicious production build can exfiltrate the same secrets as the running Function.

## 6. Optionally configure Google authentication

Skip this section if the password is the only desired login. ChipDue supports two mutually exclusive cloud authentication configurations: the default password mode can optionally link Google, while Google-only mode removes the password endpoint and uses Google for every login.

1. Create a dedicated, non-personal, monitored support alias or Google Group. If it is a group, hide its membership and restrict posting appropriately. Google requires a **User Support Email** and displays it on a consent screen that anyone can reach through the public login start; selecting a personal address would disclose it even though ChipDue never stores it.
2. Open Google Auth Platform in a dedicated Google Cloud project. Configure an External audience and request only the basic Sign in with Google identity scope used by ChipDue (`openid`). Select the dedicated address as User Support Email and keep developer-contact details private inside the provider account.
3. Create an OAuth client of type **Web application**.
4. Register exactly `https://YOUR_CANONICAL_HOST/api/auth/google/callback` as its authorized redirect URI. The scheme, case, host, path, port, and trailing slash must match exactly. Add no Preview, Development, wildcard, immutable-deployment, or alternate-host callback.
5. Put the client ID in `CARDDUE_GOOGLE_CLIENT_ID` and the client secret in `CARDDUE_GOOGLE_CLIENT_SECRET`, both Production-only. Mark the secret Sensitive. Never use `PUBLIC_` or `VITE_`, put the values in `.env*`, commit them, pass them in a command argument, or copy them into the recovery bundle.
6. For password mode, redeploy, sign in with the password, choose **Link Google account**, carefully complete the account chooser, then verify both login methods independently.
7. For Google-only mode, follow the complete generation, one-attempt bootstrap, immediate verifier decommission, and recovery procedure in [GOOGLE_ONLY_AUTH.md](GOOGLE_ONLY_AUTH.md). Do not improvise a first-visitor claim or place its setup token in a URL.

In password mode, both Google variables absent means disabled; exactly one present makes cloud configuration fail closed. Google-only mode requires both and forbids a configured owner-password hash. ChipDue uses authorization code plus PKCE S256, one-time state and nonce values, Google's signed ID token, and an encrypted short-lived host-only callback cookie. It stores only a master-keyed fingerprint of Google's normalized issuer and stable `sub`; it requests or retains no email, name, picture, profile, ID token, access token, or refresh token. Google still observes each authentication request, including its time, source IP, and the ChipDue hostname.

This release deliberately provides no unlink or rebind control. The first linked fingerprint is immutable through the application, even from another authenticated session. If that Google account is lost or compromised, remove both Google variables from Vercel Production and redeploy. Password mode stays available and can rotate its password to revoke sessions. Google-only mode instead makes the whole app fail closed with `503` until a reviewed recovery configuration is deployed; it has no password fallback. Follow [GOOGLE_ONLY_AUTH.md](GOOGLE_ONLY_AUTH.md), and never change only a database fingerprint because that does not revoke existing sessions.

Google's current Audience rules exempt projects using only basic Sign in with Google scopes from Testing-mode test-user warnings and seven-day authorization expiry. This keeps a personal instance on its generated `vercel.app` host functional without a paid domain. The shared Vercel domain cannot pass Google's owned-domain brand-verification process, however; use a stable custom domain if verified production branding is required. Recheck Google's rules before changing scopes or audience.

References: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Audience rules](https://support.google.com/cloud/answer/15549945), [OAuth branding and support email](https://support.google.com/cloud/answer/15549049), [brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), and [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/rfc9700).

## 7. Optionally configure Plaid

Skip this section for manual-only ChipDue. Plaid is not required for deployment or login.

Installation-level `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` remain optional for the original operator account. Do not configure them merely to support additional users: each user enters an independent Plaid client ID and Production secret inside their authenticated dashboard. ChipDue verifies and encrypts those values and never returns them to the browser. Users must separately configure the canonical ChipDue redirect URI in their Plaid team when required and remain responsible for Plaid access, pricing, and terms.

Never add Plaid credentials to Preview, Development, a browser-exposed variable, or the recovery bundle. The browser receives only Plaid's short-lived Link token. ChipDue asks for Accounts, Investments, Liabilities, and Transactions, maps only the documented account/card/activity fields, encrypts financial records, transaction history, the incremental cursor, and the long-lived access token server-side, and discards each raw response. Confirm the desired Plaid products are enabled before Production use; missing Investments or Liabilities coverage degrades gracefully to balances without holdings cost basis or detailed card-payment fields.

The committed Vercel schedule refreshes every Plaid connection, grouped under its owning account and Plaid credentials, during the 9 AM and 5 PM hours in `America/Los_Angeles`. Four once-daily UTC candidates keep those two Pacific windows correct across daylight-saving changes; the two inactive candidates exit before contacting Plaid. Each period is claimed atomically in `carddue_metadata`, so duplicate deliveries do not repeat a completed sync. Vercel supplies `Authorization: Bearer CRON_SECRET`; the endpoint also requires Vercel's Cron user agent and otherwise remains unavailable. On Vercel Hobby, an invocation can occur anywhere within the scheduled hour; Pro and Enterprise schedules have per-minute precision.

## 8. Deploy and verify before entering real data

Create a new production deployment after setting the variables. Changes to Vercel environment variables apply only to new deployments. Do not enter card data until all checks below pass.

### Network and host checks

- The canonical hostname serves only over HTTPS.
- The stable but noncanonical project hostname, immutable deployment URL, Preview URL, malformed Host, and any previous hostname receive a rejection and never data.
- HTTP is redirected by the platform and a request reported to the Function as non-HTTPS is rejected.
- Responses include no-store caching, a nonce-based Content Security Policy, framing denial, no-referrer, no-sniff, restrictive permissions, and no-index headers.
- No application API enables cross-origin access.

### Authentication and browser checks

- A logged-out request to every card, Plaid, manual sync, disconnect, update, and calendar API receives `401`; only health, authentication, and the separately secret-authenticated scheduled-sync endpoint bypass the browser session.
- In password mode, a wrong password returns a generic failure and repeated failures trigger throttling without revealing whether configuration or records exist. In Google-only mode every request method to the password-login route returns `404` before parsing a body or touching authentication storage.
- A successful login sets only the `__Host-carddue_session` cookie with Secure, HTTP-only, SameSite Strict, root-path semantics, and no Domain attribute.
- In password mode, a logged-out Google start cannot create or claim an owner, and a link start without the exact ChipDue session is rejected. In Google-only mode, only the one-time manually pasted setup token can create an initial OAuth transaction; the token never appears in a URL, cookie, database row, log, or provider request.
- Google linking sets only a short-lived encrypted `__Host-` transaction cookie with Secure, HTTP-only, SameSite Lax, root-path semantics, and no Domain attribute. State, nonce, PKCE, response issuer, ID-token signature/algorithm/issuer/audience/expiry, and the exact linked subject are validated; the one-time transaction cannot be replayed.
- Google's rendered consent screen contains no personal name, email, logo metadata, or link other than the deliberately created support alias and canonical ChipDue domain.
- Logging out before a pending password-mode link callback invalidates that link. Replacing or removing a Google-only bootstrap verifier invalidates its pending flow. Selecting a different Google account after an identity is linked returns a generic error and issues no session.
- After a successful link or bootstrap, Google login issues ChipDue's opaque server-side session. The password continues to work independently only in password mode.
- Mutations without the exact production Origin, with cross-site Fetch Metadata, or without JSON where JSON is required are rejected.
- Logout revokes the server-side session. Reloading and direct API requests remain logged out.
- ChipDue logout does not sign the browser out of Google. On a shared device, also sign out of Google and lock the operating-system or browser profile so ambient Google SSO cannot immediately create another ChipDue session.
- Browser storage contains no financial records in localStorage, sessionStorage, IndexedDB, Cache Storage, or a service worker. User data is absent from page URLs and history.

### Storage and disclosure checks

- Neon tables contain encrypted card payloads, encrypted Plaid secrets, and only keyed Google identity/bootstrap references—not plaintext nicknames, institutions, suffixes, balances, dates, setup tokens, provider tokens, Google email/profile, or raw responses.
- The runtime role and exact schema catalog pass both `cloud:verify` and the application's cold-start verification; the role can perform required row operations but cannot create, alter, or drop schema objects, grant privileges, assume another role, or access unrelated non-system schemas.
- Vercel build and runtime logs contain no request bodies, cookies, database URLs, SQL parameters, card values, Google or Plaid identifiers, provider tokens, raw provider errors, or recovery values.
- Generated browser assets contain none of the Production environment values.
- Preview and Development deployments remain unable to initialize cloud mode.

Use browser developer tools and provider dashboards locally for these checks. Do not save or share HAR files, screenshots, copied rows, logs, or environment exports containing real values.

## Backups and recovery

Neon point-in-time recovery is useful but is not the only backup. Provider retention is limited and plan-dependent.

1. Create periodic logical backups from a trusted environment without putting a database URL on the command line.
2. Store backups encrypted outside the repository, Vercel, and the Neon project being backed up.
3. Store the recovery bundle separately from the database backup so one storage disclosure does not provide both ciphertext and key.
4. Test restoration into an isolated, non-production Neon project that is not connected to Vercel.
5. Destroy the test database and any temporary secrets after recording only the nonsensitive result.

After any restore or database-credential incident, verify every due date and amount against the issuer before relying on ChipDue. A restricted database credential can still delete rows, change operational fields, or replay an older valid ciphertext for the same record even though it cannot decrypt fields or mint a keyed session.

A database backup without `masterKey` cannot restore readable records. The recovery bundle without a database backup cannot reconstruct lost rows. Changing `CARDDUE_MASTER_KEY` is not a rotation procedure; all existing ciphertext immediately becomes unreadable. Design and test a versioned re-encryption migration before any key change.

For Google-only mode, never restore the database to a pre-link or pre-consumption state while a reachable deployment retains the matching bootstrap verifier. Treat database state and deployed authentication environment as a pair: remove or host-deny stale deployments before restoring, and generate a fresh reviewed token and verifier for any authorized re-bootstrap.

## Updates, secret changes, and incidents

- Run `npm run ci`, repeat the publishing checklist, and review dependency changes before every production deploy.
- Run schema migrations with temporary owner authority before deploying code that requires the new schema. An existing-role migration requires the protected old/current password and a distinct desired password; never grant migration authority to the runtime.
- Environment changes require a new production deployment. Old deployments retain their old environment values; keep their hosts denied, remove unneeded deployments, and revoke the old provider credential after the replacement is verified.
- Changing `CARDDUE_OWNER_PASSWORD_HASH` in password mode invalidates sessions bound to the previous hash. Changing `CARDDUE_AUTH_MODE` also invalidates sessions from the other mode. Preserve the actual AES key during every authentication recovery.
- If the login password or session is exposed, revoke sessions and replace the password hash using a reviewed recovery procedure. Google-only mode has no login password.
- If the Google client secret is exposed, rotate it in Google and Vercel, redeploy, and remove old deployments. If the linked Google account is compromised, first remove both Google variables and redeploy. Password mode stays available and should replace its password hash to revoke sessions. Google-only mode intentionally becomes unavailable with `503` and must follow [the no-password recovery boundary](GOOGLE_ONLY_AUTH.md#recovery-and-identity-changes). Before changing the subject or returning to Google with the same client, either complete a successful fresh password-mode login that globally prunes old auth-config sessions, or delete every session row with owner authority and verify zero remain. A mode switch alone is insufficient.
- If the AES key or complete recovery bundle is exposed, assume every obtainable database copy and Plaid token can be decrypted. Disconnect Plaid, preserve evidence without copying private payloads, and perform a reviewed decrypt-and-re-encrypt migration or destroy the instance.
- If the owner migration URL is exposed, rotate it immediately and re-audit the runtime role and schema grants.

### Runtime database credential incident

If the runtime database URL is exposed, do not replace the AES key and do not overwrite the current runtime or recovery values first:

1. Retrieve the old/current role password from protected storage and generate a distinct replacement 256-bit base64url password.
2. In one owner-only migration environment outside the checkout, inject the direct owner URL and role together with `CARDDUE_CURRENT_DATABASE_PASSWORD` set to the old/current value and `CARDDUE_DATABASE_PASSWORD` set to the new/desired value. Do not put either value in Vercel as a standalone variable.
3. Run the reviewed migration. Require its direct new-credential login to succeed as the exact role, its old-credential login to meet the exact authentication-rejection contract above, all matching direct database backends to be terminated with zero remaining, and the exact role and catalog checks to pass. Independently confirm old-credential rejection with a direct `psql` connection.
4. Verify the new direct runtime URL separately with `scripts/verify-cloud-runtime.mjs`.
5. Only after all preceding checks succeed, replace Vercel's protected `DATABASE_URL` and the offline recovery record's `databaseRolePassword`, then redeploy and verify the new production instance. Remove the old credential and temporary files through the protected storage workflow.

Never use the secret generator's newly generated `masterKey` as an ad hoc replacement for an existing instance.

## Delete or retire the instance

1. While ChipDue and Plaid credentials still work, disconnect each Plaid Item so ChipDue calls Plaid's removal endpoint.
2. Delete live ChipDue records and verify no active session remains.
3. Remove ChipDue from the linked Google account's third-party connections and delete or rotate its OAuth client.
4. Remove the Vercel domain and production environment variables, then delete deployments and the project.
5. Delete every Neon branch and the Neon project. Historical restore points expire under Neon's retention rules rather than immediately through ChipDue.
6. Revoke Plaid credentials or delete the Plaid team if it is no longer used.
7. Destroy every recovery bundle, temporary migration file, database backup, calendar export, and local provider export according to its storage system's secure-deletion capabilities.
8. Remove saved credentials and recovery codes only after confirming no other service depends on them.

Provider infrastructure logs and backups may persist until their documented retention periods expire. ChipDue cannot accelerate provider-side deletion.
