# Privacy

CardDue is built around data minimization. Manual mode is fully functional without a third-party financial-data connection.

## Data stored locally

CardDue stores only the fields required for reminders:

- A user-selected card nickname and optional issuer name
- Optional last four digits
- Statement balance, minimum payment, and current balance
- Statement date and next payment due date
- Autopay preference, source, and last-update time
- An opaque random installation identifier
- For Plaid connections, encrypted access tokens and Item IDs

It does not store full account numbers, credentials entered into Plaid Link, identity data, addresses, transaction history, or raw Plaid responses.

The database and encryption key are outside the source checkout. Plaid credentials are encrypted with AES-256-GCM before storage. The key file is created with owner-only permissions where the operating system supports them.

## Network activity

In manual mode, CardDue makes no application-level network requests after dependencies have been installed.

When you explicitly start Plaid Link:

- Your browser loads Plaid's Link SDK from `cdn.plaid.com`.
- Plaid and the selected financial institution handle authentication.
- A short-lived public token returns to the local server.
- The local server exchanges it and requests Liabilities data from Plaid.
- CardDue immediately maps the response to its minimal local fields and discards the raw payload.

CardDue has no analytics, telemetry, advertising, crash reporting, remote fonts, hosted database, or webhook relay.

## Logs and browser storage

CardDue does not intentionally log request bodies, response bodies, tokens, account identifiers, card fields, or Plaid errors. Browser `localStorage` and IndexedDB are not used for financial data.

API and dashboard responses use `Cache-Control: no-store`. The server is loopback-only by default and does not enable cross-origin access.

## Calendar exports

Calendar files omit monetary amounts by default. If you explicitly include amounts and then import the file into a cloud calendar, that calendar provider receives the exported values. Treat every `.ics` file as private financial data.

## Limits of protection

- A compromised operating system, browser, or local user account can access data displayed by CardDue.
- The encryption key and encrypted database reside on the same machine; encryption primarily reduces accidental disclosure and repository leakage.
- Plaid and connected institutions process information according to their own terms and privacy policies.
- Liability fields can be delayed, missing, or incorrect. Plaid generally refreshes them about daily, not on demand.
- No third-party free tier is guaranteed permanently. Manual mode remains available if Plaid access changes.

## Delete your data

Disconnect a Plaid Item from inside CardDue first so the application can call Plaid's `/item/remove` endpoint. Then use the local deletion control to remove its cached card records. To erase everything, stop CardDue and remove its platform data directory.

Deleting an Item from Plaid's Trial plan does not restore one of the ten lifetime Item slots.
