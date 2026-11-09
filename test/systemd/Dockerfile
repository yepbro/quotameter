# systemd lifecycle scenario image (task 196, spec §17.2's final sentence,
# §5.4/§5.6; decision D-206).
#
# A real systemd machine for the §17.2 lifecycle scenarios: PID 1 is systemd,
# logind runs, `systemctl --user` reaches a per-user manager, and linger is
# exercisable — none of which the project's job containers (or the development
# container) provide. The runtime stays at the declared minimum and the base
# is the same pin the development Dockerfile uses (node:22.13.0-bookworm-slim,
# Debian 12 + systemd 252): one representative §5.1-supported systemd
# environment, which is exactly what §17.2's systemd sentence asks for ("in a
# systemd-capable test environment") — the distribution×runtime axis is the
# install matrix's charter (task 195, D-203), not this image's.
#
# Package set notes (validated live on the bookworm/systemd-252 generation):
#
# - `systemd` alone is not bootable as PID 1 in a container: `systemd-sysv`
#   supplies /sbin/init, and `libpam-systemd` supplies the PAM module without
#   which user@.service dies with "$XDG_RUNTIME_DIR is not set" — linger and
#   `su - <user>` sessions then work (a PAM session starts the user manager
#   and exports XDG_RUNTIME_DIR, with linger still disabled).
# - `sudo` makes the privileged route genuine: `sudo quotameter service
#   install` from the regular account (SUDO_USER resolution, §5.3 step 1),
#   not a root shell faking it.
# - dbus arrives through the systemd packages' dependencies (recommends are
#   kept deliberately); diagnostics use systemctl/journalctl only.
#
# Build/run flags live in test/systemd/run.sh: the container needs
# `--privileged` (systemd as PID 1 requires a writable cgroup hierarchy) and
# `--tmpfs /run` (a clean /run per boot, the container's reboot semantics).
FROM node:22.13.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y systemd systemd-sysv libpam-systemd sudo \
  && rm -rf /var/lib/apt/lists/*

# The service owner (§5.3 step 7's regular account; §5.1: never root). The
# fixed uid keeps /run/user/1001 deterministic across the scenario phases.
RUN useradd --create-home --uid 1001 --user-group --shell /bin/bash qmsvc \
  && printf 'qmsvc ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/qmsvc \
  && chmod 0440 /etc/sudoers.d/qmsvc

COPY scenario.sh /usr/local/lib/quotameter-systemd-scenario.sh
RUN chmod 0755 /usr/local/lib/quotameter-systemd-scenario.sh

# SIGRTMIN+3 is systemd's own clean-shutdown signal: `docker stop` then takes
# the manager down the way a real reboot does (units stopped, not killed).
STOPSIGNAL SIGRTMIN+3

CMD ["/sbin/init"]
