#!/usr/bin/env bash
# systemd lifecycle scenarios for Quotameter (task 196, spec §17.2's final
# sentence, §5.2-§5.6; decision D-206).
#
# Runs INSIDE the systemd scenario container (test/systemd/Dockerfile) as
# root, against a real systemd PID 1 — everything the development and CI job
# containers cannot provide. One invocation executes exactly one PHASE; the
# orchestrator (test/systemd/run.sh) reboots the container between phases,
# because "enablement after reboot" is only provable by a real manager boot:
#
#   pre-reboot-system   install + start + health of the SYSTEM unit through
#                       the real CLI (`sudo quotameter service install` from
#                       the regular account), crash restart (kill -9 the main
#                       process, systemd's Restart=on-failure brings it back,
#                       the §5.6 single-instance lock re-acquired), and the
#                       §6.4 reload (accepted + rejected).
#   post-reboot-system  after a container reboot: the enabled system unit is
#                       active again; then the system unit is uninstalled and
#                       the USER unit is installed from a login session with
#                       linger DISABLED (the exact §5.3 enable-linger
#                       guidance must be printed), linger is enabled by root,
#                       and the lingered manager restarts the user unit.
#   post-reboot-user    after a second reboot: the lingered user manager runs
#                       with no session and the enabled user unit is active.
#
# The scenarios exercise the REAL generated units and commands — nothing is
# hand-written: `quotameter init --yes` writes the configuration, `quotameter
# service install` generates and installs the unit (D-103/D-104 generators,
# D-108 sequence, D-187 health verification), systemd supervises the real
# `quotameter run` server (U-050), `quotameter reload` delivers the real
# SIGHUP (D-112, U-052). No provider access is needed or attempted: the
# configuration has no accounts (the init --yes shape proven by task 195).
#
# Every assertion is fail-closed: an unexpected value exits non-zero with a
# "scenario FAIL:" line naming what was expected.

set -euo pipefail

readonly SCENARIO_USER='qmsvc'
readonly SCENARIO_HOME='/home/qmsvc'
readonly CONFIG_DIR="${SCENARIO_HOME}/.config/quotameter"
readonly CONFIG_FILE="${CONFIG_DIR}/config.json"
readonly CONFIG_BACKUP="${CONFIG_FILE}.scenario-backup"
readonly DATA_DIR="${SCENARIO_HOME}/.local/share/quotameter"
readonly DATABASE_FILE="${DATA_DIR}/quotameter.sqlite"
readonly LOCK_FILE="${DATA_DIR}/.quotameter.lock"
readonly SYSTEM_UNIT_FILE='/etc/systemd/system/quotameter.service'
readonly USER_UNIT_FILE="${SCENARIO_HOME}/.config/systemd/user/quotameter.service"
readonly LINGER_FLAG_FILE="/var/lib/systemd/linger/${SCENARIO_USER}"
readonly USER_RUNTIME_DIR='/run/user/1001'
readonly UNIT='quotameter.service'
readonly HEALTH_URL='http://127.0.0.1:8787/api/health'

fail() {
  echo "scenario FAIL: $*" >&2
  exit 1
}

ok() {
  echo "scenario ok: $*"
}

assert_eq() {
  local description="$1" got="$2" want="$3"
  if [ "$got" != "$want" ]; then
    fail "${description}: got '${got}', want '${want}'"
  fi
  ok "${description}"
}

assert_contains() {
  local description="$1" haystack="$2" needle="$3"
  if ! grep -F -- "$needle" <<<"$haystack" >/dev/null; then
    fail "${description}: output does not contain the expected text '${needle}'"
  fi
  ok "${description}"
}

assert_not_contains() {
  local description="$1" haystack="$2" needle="$3"
  if grep -F -- "$needle" <<<"$haystack" >/dev/null; then
    fail "${description}: output unexpectedly contains '${needle}'"
  fi
  ok "${description}"
}

# Polls a predicate command until it exits 0 or the deadline passes.
wait_for() {
  local description="$1" timeout_seconds="$2"
  shift 2
  local deadline=$(( $(date +%s) + timeout_seconds ))
  until "$@" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "timed out after ${timeout_seconds}s waiting for: ${description}"
    fi
    sleep 1
  done
  ok "waited for: ${description}"
}

# The §11 health endpoint of the running service, probed over loopback with
# Node's own fetch (no curl dependency; Node is the service runtime already).
# As strict as the product's own install-time verification (D-187): a healthy
# §13 body is required, not merely a 2xx answer.
health_endpoint_answers() {
  node -e '
    fetch(process.argv[1])
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        const body = await response.json();
        process.exit(body.status === "ok" ? 0 : 1);
      })
      .catch(() => process.exit(1));
  ' "$HEALTH_URL"
}

require_healthy_service() {
  wait_for 'the health endpoint to answer' 45 health_endpoint_answers
}

# The §5.6 single-instance lock's recorded holder pid.
lock_holder_pid() {
  node -e '
    const fs = require("fs");
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof payload.pid !== "number" || !Number.isInteger(payload.pid)) {
      process.exit(1);
    }
    process.stdout.write(String(payload.pid));
  ' "$LOCK_FILE"
}

# True once the service's §6.4 reload record is in the unit's journal — the
# SIGHUP handler is fire-and-forget, so the record lands asynchronously.
journal_has_reload_record() {
  journalctl --no-pager -u "$UNIT" | grep -F 'configuration reloaded' >/dev/null
}

system_main_pid() {
  systemctl show -p MainPID --value "$UNIT"
}

system_unit_is_active() {
  [ "$(systemctl is-active "$UNIT" || true)" = 'active' ]
}

# True once the reload record ALSO names the applied live fields — proving
# the reloader applied the scenario's changes (RELOAD_FIELDS order:
# pollingIntervalSeconds precedes logging.level), not merely that it ran.
journal_has_applied_fields() {
  journalctl --no-pager -u "$UNIT" |
    grep -F '"applied":["app.pollingIntervalSeconds","logging.level"]' >/dev/null
}

user_manager_is_active() {
  as_linger_user systemctl --user is-active default.target >/dev/null 2>&1
}

# True once the user manager is NOT running — the no-linger consequence of
# the last session closing (linger off stops user@UID at session end).
user_manager_stopped() {
  ! user_manager_is_active
}

user_unit_is_active() {
  as_linger_user systemctl --user is-active "$UNIT" >/dev/null 2>&1
}

# Runs a command through a real login session (PAM: XDG_RUNTIME_DIR exported,
# user manager started if needed) — the §5.3 no-sudo operator shape. Works
# with linger disabled; the session owns the user manager's lifetime.
as_session_user() {
  su - "$SCENARIO_USER" -c "$1"
}

# Runs a command as the owner against the lingered user manager (no session):
# the §5.3 linger shape — the manager runs because linger keeps it alive.
as_linger_user() {
  setpriv --reuid="$SCENARIO_USER" --regid="$SCENARIO_USER" --init-groups \
    env HOME="$SCENARIO_HOME" XDG_RUNTIME_DIR="$USER_RUNTIME_DIR" "$@"
}

require_booted_manager() {
  assert_eq 'PID 1 is systemd' "$(cat /proc/1/comm)" 'systemd'
  local state
  state="$(systemctl is-system-running || true)"
  case "$state" in
    running | degraded) ok "the system manager answers: ${state}" ;;
    *) fail "the system manager is not usable (is-system-running: ${state})" ;;
  esac
}

# Rewrites the owner's configuration with the reload scenario's live-field
# changes, as the owner (ownership and the 0600 mode of the existing file
# are preserved): a new polling interval AND the §16 log level lifted to
# `info` — both §6.4 live-reload fields, and the level change is what makes
# the reloader's own `configuration reloaded` record visible (the reloader
# applies the new level before writing the record, and the §16 default
# level `warn` would suppress it).
edit_config_for_reload() {
  as_session_user "node -e '
    const fs = require(\"fs\");
    const file = process.argv[1];
    const config = JSON.parse(fs.readFileSync(file, \"utf8\"));
    config.app.pollingIntervalSeconds = 600;
    config.logging = config.logging || {};
    config.logging.level = \"info\";
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + \"\\n\");
  ' '$CONFIG_FILE'"
}

# ── Phase 1: system-unit install, crash restart, reload ───────────────────

run_pre_reboot_system() {
  require_booted_manager

  local tarball
  set -- /payload/quotameter-*.tgz
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    fail 'the packed tarball is not mounted at /payload (exactly one quotameter-*.tgz expected)'
  fi
  tarball="$1"
  npm install --global "$tarball" >/dev/null
  local version
  version="$(quotameter --version)"
  if ! grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' <<<"$version"; then
    fail "the installed CLI did not answer --version with a version (got '${version}')"
  fi
  ok "the package is installed globally; quotameter --version -> ${version}"

  local init_output
  if ! init_output="$(
    su - "$SCENARIO_USER" -c '
      set -eu
      quotameter init --yes --timezone UTC </dev/null
      printf "%s\n" "--init-done--"
      # §5.3 step 7 executed as the no-sudo path: with a reachable user
      # manager, init installed and started the USER unit — asserted here
      # before the README documented privileged sequence removes it (the
      # §5.6 lock is exclusive, so the system unit needs the directory
      # free).
      test -f "$HOME/.config/systemd/user/quotameter.service"
      printf "%s\n" "--init-user-unit-present--"
      test "$(systemctl --user is-active quotameter.service)" = "active"
      printf "%s\n" "--init-user-unit-active--"
      quotameter service uninstall
      printf "%s\n" "--user-unit-removed--"
    ' 2>&1
  )"; then
    fail "the init/uninstall session failed as ${SCENARIO_USER}: ${init_output}"
  fi
  assert_contains 'init --yes reports the written configuration' \
    "$init_output" "Configuration written to ${CONFIG_FILE}."
  assert_contains 'init --yes reports the initialized database' \
    "$init_output" "Database ready at ${DATABASE_FILE}."
  assert_contains 'init --yes installed the user unit (§5.3 step 7 no-sudo path)' \
    "$init_output" '--init-user-unit-present--'
  assert_contains 'the init-time user unit was started by the user manager' \
    "$init_output" '--init-user-unit-active--'
  assert_contains 'the init-time user unit was removed for the system install' \
    "$init_output" '--user-unit-removed--'
  if [ -e "$USER_UNIT_FILE" ]; then
    fail "init --yes left a user unit at ${USER_UNIT_FILE}; the system-unit scenario needs the data directory free"
  fi
  ok 'no user unit remains after the documented removal step'
  assert_eq 'the configuration directory is 0700 (§5.3 step 5)' \
    "$(stat -c %a "$CONFIG_DIR")" '700'
  assert_eq 'the configuration file is 0600 (§5.3 step 5)' \
    "$(stat -c %a "$CONFIG_FILE")" '600'
  assert_eq 'the data directory is 0700 (§5.3 step 5)' \
    "$(stat -c %a "$DATA_DIR")" '700'

  local install_output
  if ! install_output="$(as_session_user 'sudo quotameter service install' 2>&1)"; then
    fail "sudo quotameter service install failed: ${install_output}"
  fi
  assert_contains 'service install reports the system service' \
    "$install_output" "installed the system service for ${SCENARIO_USER}."
  assert_contains 'service install verified the active state' \
    "$install_output" "Verified active with: systemctl is-active ${UNIT}"
  if [ ! -f "$SYSTEM_UNIT_FILE" ]; then
    fail "the system unit file is not present at ${SYSTEM_UNIT_FILE}"
  fi
  ok "the system unit file is present at ${SYSTEM_UNIT_FILE}"
  assert_eq 'the installed system unit is active' "$(systemctl is-active "$UNIT" || true)" 'active'
  assert_eq 'the installed system unit is enabled' "$(systemctl is-enabled "$UNIT" || true)" 'enabled'
  require_healthy_service

  # Crash restart (§17.2): SIGKILL the supervised process; Restart=on-failure
  # (with the generated RestartSec) must bring a NEW process up, and the
  # restarted instance must re-acquire the §5.6 single-instance lock (the
  # crashed holder left it stale). The directive itself is asserted from the
  # INSTALLED unit — the generated §5.4 contract, not the generator's word.
  assert_eq 'the installed unit carries Restart=on-failure (§5.4)' \
    "$(systemctl show -p Restart --value "$UNIT")" 'on-failure'
  local old_pid
  old_pid="$(system_main_pid)"
  if [ "$old_pid" -le 0 ]; then
    fail "cannot crash-restart: the unit reports no main pid (${old_pid})"
  fi
  kill -9 "$old_pid"
  ok "sent SIGKILL to the service main pid ${old_pid}"
  local restarted_with_new_pid
  restarted_with_new_pid() {
    [ "$(systemctl is-active "$UNIT" || true)" = 'active' ] || return 1
    local new_pid
    new_pid="$(system_main_pid)"
    [ "$new_pid" -gt 0 ] && [ "$new_pid" != "$old_pid" ]
  }
  wait_for 'systemd to restart the crashed service (Restart=on-failure)' 60 restarted_with_new_pid
  local new_pid
  new_pid="$(system_main_pid)"
  local restarts
  restarts="$(systemctl show -p NRestarts --value "$UNIT")"
  if [ "$restarts" -lt 1 ]; then
    fail "the unit reports NRestarts=${restarts} after a crash — systemd did not count a restart"
  fi
  ok "systemd restarted the service (NRestarts=${restarts}, pid ${old_pid} -> ${new_pid})"
  require_healthy_service
  assert_eq 'the restarted instance holds the single-instance lock (§5.6)' \
    "$(lock_holder_pid)" "$new_pid"

  # Reload (§6.4): a valid configuration change is signalled and accepted; an
  # invalid file is rejected with NO SIGHUP, and the running service keeps
  # its last valid configuration (§6.2).
  as_session_user "cp '$CONFIG_FILE' '$CONFIG_BACKUP'"
  edit_config_for_reload
  local reload_output
  if ! reload_output="$(as_session_user 'quotameter reload' 2>&1)"; then
    fail "quotameter reload failed on a valid configuration: ${reload_output}"
  fi
  assert_contains 'reload reports acceptance' \
    "$reload_output" 'reload accepted'
  wait_for 'the service to log its reload record to journald' 20 journal_has_reload_record
  wait_for 'the reload record to name the applied live fields' 20 journal_has_applied_fields
  ok 'the service logged its reload record (journald: "configuration reloaded", applied: pollingIntervalSeconds, logging.level)'

  as_session_user "printf '{' > '$CONFIG_FILE'"
  local rejected_output='' rejected_rc=0
  rejected_output="$(as_session_user 'quotameter reload' 2>&1)" || rejected_rc=$?
  if [ "$rejected_rc" -eq 0 ]; then
    fail "quotameter reload accepted an invalid configuration (exit 0)"
  fi
  assert_contains 'reload reports the rejection' \
    "$rejected_output" 'the configuration is invalid'
  assert_contains 'reload states that no SIGHUP was sent' \
    "$rejected_output" 'no SIGHUP was sent'

  as_session_user "cp '$CONFIG_BACKUP' '$CONFIG_FILE'"
  local restored_output
  if ! restored_output="$(as_session_user 'quotameter reload' 2>&1)"; then
    fail "quotameter reload failed on the restored configuration: ${restored_output}"
  fi
  assert_contains 'the restored configuration reloads' "$restored_output" 'reload accepted'
  assert_eq 'the service is still active after the reload sequence' \
    "$(systemctl is-active "$UNIT" || true)" 'active'
  require_healthy_service

  echo "phase pre-reboot-system: all assertions passed"
}

# ── Phase 2: reboot enablement (system), user unit, linger ────────────────

run_post_reboot_system() {
  require_booted_manager

  wait_for 'the enabled system unit to become active after the reboot' 60 system_unit_is_active
  assert_eq 'the system unit is still enabled after the reboot' \
    "$(systemctl is-enabled "$UNIT" || true)" 'enabled'
  require_healthy_service
  assert_eq 'the rebooted instance holds the single-instance lock (§5.6)' \
    "$(lock_holder_pid)" "$(system_main_pid)"
  if [ ! -f "$DATABASE_FILE" ]; then
    fail "the database did not survive the reboot (expected ${DATABASE_FILE})"
  fi
  ok 'the database survived the reboot'

  local status_output
  if ! status_output="$(as_session_user 'quotameter status' 2>&1)"; then
    fail "quotameter status failed after the reboot: ${status_output}"
  fi
  assert_contains 'quotameter status renders its report' "$status_output" 'Quotameter status'
  assert_contains 'quotameter status reports the running service' \
    "$status_output" 'Running: running (pid '

  local uninstall_output
  if ! uninstall_output="$(as_session_user 'sudo quotameter service uninstall' 2>&1)"; then
    fail "sudo quotameter service uninstall failed: ${uninstall_output}"
  fi
  assert_contains 'service uninstall reports the removal' \
    "$uninstall_output" 'removed the system service.'
  if [ -e "$SYSTEM_UNIT_FILE" ]; then
    fail "the system unit file is still present at ${SYSTEM_UNIT_FILE} after uninstall"
  fi
  ok 'the system unit file is gone after uninstall'
  if system_unit_is_active; then
    fail 'the system service is still active after uninstall'
  fi
  ok 'the system service is stopped after uninstall'

  # User unit with linger disabled (§5.3 step 7's no-sudo bullet): installed
  # from a real login session; the exact enable-linger command must appear.
  loginctl disable-linger "$SCENARIO_USER" >/dev/null 2>&1 || true
  sleep 1
  if [ -e "$LINGER_FLAG_FILE" ]; then
    fail "linger is unexpectedly enabled for ${SCENARIO_USER} (flag file present)"
  fi
  ok "linger is disabled for ${SCENARIO_USER} (no flag file at ${LINGER_FLAG_FILE})"

  local session_output
  if ! session_output="$(
    su - "$SCENARIO_USER" -c '
      set -eu
      quotameter service install
      printf "%s\n" "--install-succeeded--"
      test "$(systemctl --user is-enabled quotameter.service)" = "enabled"
      printf "%s\n" "--user-unit-enabled--"
      test "$(systemctl --user is-active quotameter.service)" = "active"
      printf "%s\n" "--user-unit-active--"
    ' 2>&1
  )"; then
    fail "the user-unit install session failed: ${session_output}"
  fi
  assert_contains 'the user service is installed without sudo' \
    "$session_output" "installed the user service for ${SCENARIO_USER} — no sudo needed."
  assert_contains 'the user-unit install prints the exact enable-linger command (§5.3)' \
    "$session_output" "sudo loginctl enable-linger ${SCENARIO_USER}"
  assert_contains 'the user unit was enabled in the session' "$session_output" '--user-unit-enabled--'
  assert_contains 'the user unit was active in the session' "$session_output" '--user-unit-active--'
  if [ ! -f "$USER_UNIT_FILE" ]; then
    fail "the user unit file is not present at ${USER_UNIT_FILE}"
  fi
  ok "the user unit file is present at ${USER_UNIT_FILE}"
  require_healthy_service

  # The no-linger consequence first: with the session closed and linger
  # still disabled, logind stops the user manager (user@UID follows the last
  # session's end), stopping the user unit with it — §5.3's stated reason
  # for the enable-linger command. Proving the stop makes the re-run below
  # a genuine linger proof instead of a leftover from the session.
  wait_for 'the user manager to stop with linger disabled and the session closed' 60 user_manager_stopped
  ok 'the user manager stopped with linger disabled (the §5.3 logout consequence)'

  # Linger enabled by root: the manager (and the enabled user unit) must run
  # again with no session open — §5.3's logout/reboot consequence.
  loginctl enable-linger "$SCENARIO_USER"
  if [ ! -e "$LINGER_FLAG_FILE" ]; then
    fail "loginctl enable-linger did not create the flag file ${LINGER_FLAG_FILE}"
  fi
  ok "linger is enabled for ${SCENARIO_USER} (flag file at ${LINGER_FLAG_FILE})"
  wait_for 'the lingered user manager to run without a session' 30 user_manager_is_active
  wait_for 'the lingered manager to run the enabled user unit' 45 user_unit_is_active
  require_healthy_service

  # Regeneration (§5.4: service install regenerates the unit) must now state
  # linger is already enabled and print no enable-linger command.
  local regenerated_output
  if ! regenerated_output="$(as_session_user 'quotameter service install' 2>&1)"; then
    fail "the regenerating service install failed: ${regenerated_output}"
  fi
  assert_contains 'the regenerated install confirms linger is enabled' \
    "$regenerated_output" "Linger is already enabled for ${SCENARIO_USER}"
  assert_not_contains 'the regenerated install prints no enable-linger command' \
    "$regenerated_output" 'To keep the service running after logout or reboot, run:'

  echo "phase post-reboot-system: all assertions passed"
}

# ── Phase 3: reboot enablement of the lingered user unit ──────────────────

run_post_reboot_user() {
  require_booted_manager

  if [ ! -e "$LINGER_FLAG_FILE" ]; then
    fail "linger did not survive the reboot (flag file ${LINGER_FLAG_FILE} is gone)"
  fi
  ok 'linger survived the reboot'
  wait_for 'the lingered user manager to boot without any session' 45 user_manager_is_active
  assert_eq 'the user unit is still enabled after the reboot' \
    "$(as_linger_user systemctl --user is-enabled "$UNIT" || true)" 'enabled'
  wait_for 'the enabled user unit to start after the reboot' 60 user_unit_is_active
  local user_pid
  user_pid="$(as_linger_user systemctl --user show -p MainPID --value "$UNIT")"
  if [ "$user_pid" -le 0 ]; then
    fail "the rebooted user unit reports no main pid (${user_pid})"
  fi
  ok "the rebooted user unit runs (pid ${user_pid})"
  require_healthy_service

  echo "phase post-reboot-user: all assertions passed"
}

# ── Dispatch ──────────────────────────────────────────────────────────────

case "${1:-}" in
  pre-reboot-system) run_pre_reboot_system ;;
  post-reboot-system) run_post_reboot_system ;;
  post-reboot-user) run_post_reboot_user ;;
  *)
    echo "usage: $0 {pre-reboot-system|post-reboot-system|post-reboot-user}" >&2
    exit 2
    ;;
esac
