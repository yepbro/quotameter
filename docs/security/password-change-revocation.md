# Password changes and session revocation (spec §15.2)

This is the single home of the ordering rationale shared by every
password-writing path: `quotameter passwd` (`src/cli/passwd.ts`, decision
D-118), `PUT /api/settings` with `auth.password` (the settings store in
`src/server/config-stores.ts`, decisions D-130/D-140, the order itself
D-184), and `quotameter init`'s fresh-password leg over a surviving
database (`src/cli/init.ts`, D-141 — revoke before the store, the same
order). Their docblocks and module READMEs point here.

## The rule

§15.2: "Changing the password revokes all sessions." Every path executes
that as one fail-secure sequence:

1. **Revoke first** — delete every stored session through the
   repository's `deleteAllSessions`.
2. **Write second** — persist the new `auth.passwordHash` into the
   `0600` configuration file. The settings store applies §6.4's change
   application in the same request; `passwd` and `init` write the file
   and advise `quotameter reload` when a live service holds the old
   password (`auth.passwordHash` is live-on-reload, D-026).

## Why this order

The order is chosen by comparing the failure arms of both directions:

| Failure                                     | Revoke first (every path)                                                                                                                                                      | Write first (rejected)                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The revocation fails                        | The change is refused with **nothing written**: the incumbent hash stays effective and its sessions stay coherent with it. Fail-secure.                                        | The **new** hash is already effective and every old session is still valid — the exact state §15.2 forbids, invisible to the operator behind a generic error. |
| The write/reload fails after the revocation | The password is not applied (or the file is ahead of memory until a reload, §6.2) and everyone must sign in again with the current password. More restrictive, never less.     | Unreachable (the revocation never runs).                                                                                                                      |
| Everything succeeds                         | New hash in the file, no old sessions; the running service authenticates with it after its reload (the settings store reloads in-request; `passwd`/`init` print the advisory). | The same end state.                                                                                                                                           |

The rejected direction's failed-revocation arm leaves old sessions valid
under a password the operator believes changed — the security property
("changing the password revokes all sessions") silently not delivered.
The chosen direction's worst case is an inconvenience (everyone logged
out, password not applied) that every path reports honestly. `quotameter
passwd` recorded this calculus first (D-118); D-184 aligned the settings
path with it after a review found the two paths disagreeing.

## How each path reports the arms

- `quotameter passwd` exits 1 and prints:
  - failed revocation — "The password was not changed — the configuration
    file was left untouched. Fix the database problem, then run passwd
    again."
  - failed write after revocation — "The password was not changed, but N
    stored session(s) had already been revoked — the next sign-in still
    needs the current password. Run passwd again to change it." (N is
    printed unconditionally in this arm, zero included.)
- The settings PUT's store rejects; the endpoint answers the INTERNAL
  envelope (the detailed text goes to the logs, never the response
  body):
  - failed revocation — "revoking the sessions failed (the password
    change was refused, nothing was written): \<storage error\>"
  - failed mutation after a revocation that deleted sessions — the
    mutation's own error text plus "(the password change did not
    complete, but N stored session(s) had already been revoked — the
    running service keeps the current password, and the configuration
    file may already hold the new hash, which a later reload would
    apply)". The uncertainty is deliberate: what the file holds depends
    on where the mutation failed (a refused candidate or a failed atomic
    write leaves it untouched; a rejected reload leaves it ahead of
    memory, §6.2), and the message must be true in every arm. A
    zero-count revocation lost nothing and appends nothing — this is the
    settings path's own rule (passwd prints the count in that arm).

## Accepted residuals

- **The login-in-the-gap window**: a sign-in between the revocation and
  the write mints a session under the incumbent password that survives
  the change. Every path has this gap. For a **stolen-session** attacker
  it is harmless (a sign-in requires the password, the credential the
  attacker lacks). For a **compromised-password** attacker — the case
  that usually motivates a password change — it is a real, narrow leak:
  they can authenticate inside the gap and keep the minted session. The
  settings path's gap (queue wait + file read/write/reload) is wider
  than passwd's. Closing it (a second `deleteAllSessions` after the
  successful write, or a gate serializing sign-ins against password
  writes) is a successor decision away — it must be made for all paths
  at once and decides the new failure arm it creates (a revocation
  failing after a change that already applied).
- **The reload-rejected file-ahead state**: when the settings path's
  reload is rejected after the write (§6.2), the file already holds the
  new hash while the running service keeps the old one, and the sessions
  are already revoked — D-140's pre-existing residual, still on the
  fail-secure side (access became more restrictive, never less).
