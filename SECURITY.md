# Security policy

## Reporting a vulnerability

Use GitHub's private security-advisory feature for vulnerabilities. Do not open a public issue containing credentials, financial records, institution names, account suffixes, private paths, screenshots, request traces, or raw API payloads.

If a secret has already been exposed, revoke or rotate it before doing anything else. Removing it from the latest commit is not sufficient because Git history and existing clones retain old objects.

## Supported version

Security fixes target the current `main` branch until versioned releases are introduced.

## Security boundaries

CardDue is intended for a trusted, single-user computer. It binds to loopback and has no authentication layer. Do not expose it to a LAN, reverse proxy, public hostname, shared machine, or hosted platform without first adding authentication, TLS, authorization, and a fresh threat-model review.

Plaid secrets and long-lived tokens must remain server-side. Never place them in a variable beginning with `PUBLIC_` or `VITE_`.

Review [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the complete boundary and assumptions.
