# Threat model

## Goal

Prevent CardDue's source repository, Git history, CI, logs, browser storage, and normal runtime behavior from disclosing personal financial data or credentials.

## In scope

- Accidental commits of credentials, databases, exports, logs, screenshots, and personal metadata
- Client-side exposure of server credentials or long-lived Plaid tokens
- Excessive collection or retention from Plaid responses
- Cross-origin requests and casual LAN exposure
- Sensitive browser caching or persistent browser storage
- Leaks through test fixtures, diagnostics, CI artifacts, and Git author metadata

## Assumptions

- The computer and local operating-system account are trusted.
- CardDue runs as a single-user loopback service.
- npm and Plaid are trusted external dependencies within their documented roles.
- The user verifies payment details with the card issuer.

## Controls

| Risk                                    | Control                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| Runtime files enter Git                 | Data lives outside the checkout; broad ignore rules; filename and content scanning   |
| Git author reveals a private email      | Repository-local noreply identity and a privacy check                                |
| Plaid credentials reach the browser     | Server-only environment access and API modules                                       |
| A database leak reveals Plaid tokens    | AES-256-GCM encryption with a separate local key                                     |
| Raw provider data expands exposure      | Allowlisted field mapping; raw payloads are never persisted or logged                |
| Another website invokes local mutations | SvelteKit origin checks, same-origin API use, no CORS                                |
| Another device reaches the server       | Development and production commands bind to loopback                                 |
| Browser retains financial responses     | `Cache-Control: no-store`; no localStorage or IndexedDB                              |
| CI publishes private artifacts          | Synthetic tests, no production secrets, no artifact upload, full-history secret scan |
| Calendar sync exposes amounts           | Amounts are opt-in and omitted by default                                            |

## Explicitly out of scope

- Malware or an attacker controlling the local operating-system account
- A compromised browser extension
- Compromise of Plaid or a connected financial institution
- Multi-user hosting, public deployment, or LAN access
- Initiating or guaranteeing credit-card payments

Any change to these assumptions requires a new design review before implementation.
