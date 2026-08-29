# Google-only authentication

Google-only mode is an optional private-cloud configuration that removes ChipDue's password-login endpoint. Ordinary validated Google sign-ins create isolated ChipDue accounts. The one-time operator-authorized bootstrap described here is needed only to attach a Google identity to pre-existing operator data. Local mode is unchanged.

This mode has no independent ChipDue recovery password. A Google outage, account suspension, OAuth-client error, or loss of a linked Google account can lock that user out. Protect Google accounts and the Cloud project with phishing-resistant MFA and keep provider recovery methods current before enabling it.

## Security model

- `CARDDUE_AUTH_MODE=google` requires both Google OAuth client variables and forbids `CARDDUE_OWNER_PASSWORD_HASH`.
- A random 256-bit setup token authorizes exactly one OAuth start. Vercel configuration stores only its SHA-256 verifier; the browser receives the token only when the owner manually pastes it into ChipDue's password-type field.
- The Vercel Function necessarily receives the raw setup token once in the encrypted HTTPS request and hashes it transiently. ChipDue never persists or logs it, puts it in a URL, cookie, database row, browser storage, or build artifact, or sends it to Google or Plaid.
- Bootstrap uses the same exact-host HTTPS checks, authorization-code flow, PKCE S256, random state and nonce, encrypted short-lived transaction cookie, one-time database marker, Google response-issuer check, RS256 signature verification, and issuer/audience/expiry/freshness/nonce/subject checks as ordinary Google login.
- ChipDue stores only a master-keyed fingerprint of Google's normalized issuer and stable `sub`. It does not request or retain an email, profile, provider token, or raw provider response.
- A normal validated subject receives an immutable random tenant mapping. Bootstrap-verifier replacement and final legacy-operator binding serialize on the same active claim row, so a replaced flow cannot later win that binding.

The setup verifier is a temporary authority over the pre-existing operator tenant, not an everyday login secret. Remove it immediately after the successful operator callback. On a fresh deployment with no legacy data, omit it and let users sign in normally.

## Provision

Complete the Neon, canonical-host, Google Web OAuth client, support-alias, and exact callback setup in [DEPLOY_VERCEL.md](DEPLOY_VERCEL.md) first. Register only:

```text
https://YOUR_CANONICAL_HOST/api/auth/google/callback
```

From a credential-free checkout, create a separate protected bootstrap bundle outside every Git checkout, synced source tree, and CI workspace:

```sh
npm run google:bootstrap -- --output "$ABSOLUTE_PRIVATE_BOOTSTRAP_PATH"
```

The generator refuses a relative path, linked ancestor, Git worktree, existing output, or insecure existing POSIX directory. It creates an owner-only file and prints no generated value. The JSON contains:

- `googleBootstrapToken`: the one-time value manually pasted into ChipDue;
- `googleBootstrapHash`: the verifier configured as `CARDDUE_GOOGLE_BOOTSTRAP_HASH`.

Configure the following as Vercel **Production-only** values, mark credential values Sensitive, and redeploy:

```text
CARDDUE_AUTH_MODE=google
CARDDUE_GOOGLE_CLIENT_ID=<the Web OAuth client ID>
CARDDUE_GOOGLE_CLIENT_SECRET=<the Web OAuth client secret>
CARDDUE_GOOGLE_BOOTSTRAP_HASH=<googleBootstrapHash from the protected bundle>
```

Remove `CARDDUE_OWNER_PASSWORD_HASH`; its presence makes Google-only configuration fail closed. Do not put `googleBootstrapToken`, the bootstrap bundle, or a path to it in Vercel, GitHub, CI, a command argument, an environment file in the checkout, a URL, chat, screenshot, or browser storage.

Open the canonical production page. Manually copy `googleBootstrapToken` from protected storage and paste it into the one-time setup-code field. ChipDue sends it once in a same-origin, size-bounded JSON request, clears the field, returns only a fixed same-origin continuation path, and then redirects to Google's account chooser. Carefully select the intended owner account.

One verifier permits one start, including when the browser is closed, the callback fails, or Google is canceled. ChipDue does not make that verifier reusable. If the callback reports an error, first try ordinary Google login with the same selected account: a rare session-creation failure can occur after the identity binding has already committed. If ordinary login confirms that no identity was bound, generate a fresh bundle at a new protected path, replace the Production bootstrap hash, redeploy, and try once with the new token. Replacing or removing the verifier invalidates old pending continuations and callbacks.

## Decommission bootstrap authority

Immediately after a successful callback:

1. Confirm the dashboard is authenticated and `GET /api/auth/session` reports `authMode: "google"`, `authenticated: true`, and `google.linked: true`.
2. Remove `CARDDUE_GOOGLE_BOOTSTRAP_HASH` from Vercel Production and redeploy. Do not remove the Google client ID or secret.
3. Confirm the signed-out page offers ordinary Google login and no setup-code control; session status should report `google.bootstrapAvailable: false`.
4. Sign in with Google again and verify the same owner reaches the dashboard.
5. Delete the temporary bootstrap bundle and clear the clipboard through the operating system's protected workflow. Remove superseded deployments that still contain the verifier.

The operator fingerprint remains in Neon. Removing the bootstrap hash does not remove that identity or invalidate an already issued ChipDue session.

## Recovery and identity changes

This release intentionally provides no account deletion, unlink, reset, or rebind endpoint. Google-only configuration requires both client variables. Removing them and redeploying is an emergency containment action that makes the entire application fail closed with `503`; it does not erase tenant bindings. Rotating only the Google client secret does not invalidate existing ChipDue sessions.

Do not replace the metadata fingerprint manually while leaving existing Google-only sessions active: sessions are bound to the authentication mode and OAuth client, not to the mutable database row. Any separately reviewed identity-reset procedure must first invalidate every existing session. A temporary password-mode recovery must deploy a fresh password hash and complete one successful fresh password login; issuing that session globally deletes stored sessions bound to the old Google configuration. Merely switching modes is insufficient because an unpresented old row could become valid again after returning to Google with the same client ID. An owner-authorized database recovery may instead delete every session row and verify the table is empty before changing the binding or restoring Google mode. Neither recovery path is exposed by the application, and both require a new security review and verified rollback plan.

If the setup token or verifier is exposed before completion, replace the verifier with a fresh bundle and redeploy before opening the setup flow. If the linked Google account is compromised, remove both Google client variables, redeploy into the intentional fail-closed `503` state, remove old deployments, secure or revoke the provider account and OAuth client, and treat every ChipDue session as compromised until a reviewed recovery invalidates them.

Never restore the database to a pre-link or pre-consumption state while any reachable deployment still carries the corresponding bootstrap verifier. Treat the database state and deployed authentication environment as one recovery unit: remove or host-deny stale deployments first, restore only a reviewed matching pair, and use a fresh bootstrap token and verifier for any authorized re-bootstrap.
