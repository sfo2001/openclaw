# ADR-003: PAT/Audit Layer (Deferred)

## Status

Deferred

## Context

The full vault architecture envisions OpenClaw authenticating to the vault with a scoped,
time-limited Personal Access Token (PAT), with audit logging of secret access. This
provides:

1. Per-application access scopes (which secrets each app can use)
2. Time-limited tokens with automatic expiration
3. Audit trail of which secrets were accessed, when, and by whom

## Decision

Defer. For Phase 1, use Docker network isolation as the access boundary. Only containers
on the `vault-internal` network can reach the broker's listener ports. No PAT, no audit
trail.

Revisit and add OpenBao (open-source Vault fork, MPL 2.0) as the credential backend if:

- Secretless Broker proves effective and proper PAT lifecycle management is needed
- Audit trail of secret access becomes a requirement
- Multiple applications need to share the vault with different access scopes

### Options for future implementation

| Approach                        | Capability                                                   | Overhead                                     |
| ------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| OpenBao                         | PAT management, scoped access, audit trail, lease expiration | ~200 MB RAM, additional container            |
| Secretless Broker listener auth | Basic authentication on the proxy listener                   | Minimal, but no time-limited tokens or audit |

## Consequences

- Phase 1 relies on Docker network isolation (only `vault-internal` containers can
  reach the broker)
- No audit trail of which secrets were accessed when
- No automatic token expiration or rotation
- Adding OpenBao later is non-breaking: it would replace the static secret injection
  in the nginx reverse proxy with dynamic credential fetching from the vault backend
