#!/bin/bash
# Sourced by the shared entrypoint (UAT_PRE_HOST_HOOK) AFTER the build, just before the host launches:
# install the egress rule and start the allowlist proxy. The build (npm ci, VS Code download) ran with full network.
# Egress policy: only the proxy user (uid 65534) may leave the container, and the proxy only tunnels to
# EVAL_ALLOWED_HOSTS (package registries + the core's API host). If the rule cannot be installed the run
# still proceeds, but network.json records a known leak for the report.
STATUS_DIR=/run/karst-eval
mkdir -p "$STATUS_DIR"
PROXY_PORT=3128
write_status() { printf '%s\n' "$1" > "$STATUS_DIR/network.json"; }

# Both families must be locked: an IPv6 route would bypass an IPv4-only rule.
lock_family() {
  "$1" -A OUTPUT -o lo -j ACCEPT 2>/dev/null \
    && "$1" -A OUTPUT -m owner --uid-owner 65534 -j ACCEPT 2>/dev/null \
    && "$1" -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
    && "$1" -A OUTPUT -j REJECT 2>/dev/null
}

if lock_family iptables && lock_family ip6tables; then
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    env EVAL_PROXY_PORT=$PROXY_PORT EVAL_ALLOWED_HOSTS="$EVAL_ALLOWED_HOSTS" \
    node /work/scripts/uat-host/evalProxy.mjs >/dev/null 2>"$STATUS_DIR/proxy.log" &
  for _ in 1 2 3 4 5 6 7 8 9 10; do (echo > "/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null && break; sleep 0.3; done
  write_status "{\"enforced\":true,\"allowedHosts\":\"$EVAL_ALLOWED_HOSTS\"}"
  export EVAL_PROXY_URL="http://127.0.0.1:$PROXY_PORT"
  # The host runs as root: without this it could `iptables -F`. The entrypoint launches the host through
  # this prefix, so NET_ADMIN/NET_RAW are gone from the bounding set and cannot be regained.
  HOST_LAUNCH_PREFIX="setpriv --bounding-set=-net_admin,-net_raw"
else
  write_status '{"enforced":false,"knownLeak":"IPv4/IPv6 egress rules could not both be installed; github.com and other hosts were reachable"}'
fi
if [ -n "$UAT_EVAL_AUTH_DIR" ] && [ -n "$UAT_EVAL_CORE" ]; then
  case "$UAT_EVAL_CORE" in claude) ln -sfn /auth "$HOME/.claude" ;; codex) ln -sfn /auth "$HOME/.codex" ;; esac
fi
