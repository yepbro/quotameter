#!/usr/bin/env bash
# Host-side orchestrator of the systemd lifecycle scenarios (task 196, spec
# §17.2's final sentence; decision D-206).
#
# Usage: test/systemd/run.sh <packed-tarball>
#
# Builds the systemd scenario image (test/systemd/Dockerfile), boots it with
# systemd as PID 1, and executes the three phases of test/systemd/scenario.sh
# in order, REBOOTING the container between them:
#
#   pre-reboot-system -> [reboot] -> post-reboot-system -> [reboot] -> post-reboot-user
#
# `docker restart` is the container's honest reboot: a clean manager shutdown
# (STOPSIGNAL SIGRTMIN+3) and a fresh systemd boot with persistent /var —
# exactly the state "enablement after reboot" must survive.
#
# Requires a Docker daemon (the dev container cannot run nested systemd)
# and network access: apt and the base pull on the first image build only,
# but every scenario run installs the tarball inside the container, and npm
# resolves the package's runtime dependencies from the registry then. CI
# runs this script from the systemd job with the package job's tarball
# artifact; locally, `make test-systemd` builds and packs the tarball first.
#
# Environment knobs:
#   SYSTEMD_SCENARIO_KEEP=1  keep the container and payload directory for
#                            inspection instead of tearing them down (the
#                            image is intentionally kept in both modes — it
#                            is the build cache for the next run).
#
# Fails closed: any non-zero phase exits the script non-zero after dumping
# the container's manager state and journal tail for diagnosis.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <packed-tarball>" >&2
  exit 2
fi

readonly TARBALL="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
if [ ! -f "$TARBALL" ]; then
  echo "error: the packed tarball '${TARBALL}' does not exist" >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || {
  echo 'error: docker is required to run the systemd scenarios' >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly IMAGE='quotameter-systemd-scenario:local'
readonly CONTAINER="quotameter-systemd-scenario-$$"
readonly PAYLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quotameter-systemd-payload-XXXXXX")"

cleanup() {
  local keep="${SYSTEMD_SCENARIO_KEEP:-0}"
  if [ "$keep" = '1' ]; then
    echo "kept for inspection: container ${CONTAINER}, payload ${PAYLOAD_DIR} (image ${IMAGE} is the kept build cache)"
    return
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$PAYLOAD_DIR"
}
trap cleanup EXIT

# Prints the manager's own diagnostics after a failed phase, best-effort.
dump_diagnostics() {
  echo '── scenario failure diagnostics ──────────────────────────────' >&2
  docker exec "$CONTAINER" sh -c '
    systemctl --no-pager --failed || true
    systemctl --no-pager status quotameter.service || true
    echo "── journal (unit) ──"
    journalctl --no-pager -u quotameter.service -n 80 || true
    echo "── journal (user manager) ──"
    journalctl --no-pager -u user@1001.service -n 40 || true
  ' >&2 || true
  echo '──────────────────────────────────────────────────────────────' >&2
}

# Waits until the container's system manager answers (running or degraded —
# a degraded container boots units all the same; the scenario asserts the
# unit states that matter).
wait_for_boot() {
  local deadline=$(( $(date +%s) + 90 ))
  while true; do
    local state
    state="$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)"
    case "$state" in
      running | degraded)
        echo "boot: system manager is ${state}"
        return
        ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "error: the container's systemd did not reach running/degraded within 90s (last: '${state}')" >&2
      docker logs "$CONTAINER" >&2 || true
      exit 1
    fi
    sleep 2
  done
}

phase() {
  local name="$1"
  echo "══ systemd scenario phase: ${name} ══"
  if ! docker exec "$CONTAINER" /usr/local/lib/quotameter-systemd-scenario.sh "$name"; then
    dump_diagnostics
    echo "error: scenario phase ${name} failed" >&2
    exit 1
  fi
}

cp "$TARBALL" "$PAYLOAD_DIR/"
docker build -t "$IMAGE" -f "${SCRIPT_DIR}/Dockerfile" "$SCRIPT_DIR"

# systemd as PID 1 needs a writable cgroup hierarchy (--privileged) and a
# clean /run per boot (--tmpfs /run); see the Dockerfile's package notes.
docker run -d --privileged \
  --tmpfs /run --tmpfs /tmp \
  --name "$CONTAINER" \
  --volume "${PAYLOAD_DIR}:/payload:ro" \
  "$IMAGE" >/dev/null
wait_for_boot

phase 'pre-reboot-system'
docker restart "$CONTAINER" >/dev/null
wait_for_boot
phase 'post-reboot-system'
docker restart "$CONTAINER" >/dev/null
wait_for_boot
phase 'post-reboot-user'

echo 'all systemd lifecycle scenario phases passed'
