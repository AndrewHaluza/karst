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

v4_locked=0; v6_locked=0
lock_family iptables && v4_locked=1
lock_family ip6tables && v6_locked=1
if [ "$v4_locked" != "$v6_locked" ]; then
  # One family is rejecting everything while the other is open and no proxy runs: the run cannot work and the
  # "hosts were reachable" leak note would be false. Abort with an accurate status.
  write_status "{\"enforced\":false,\"knownLeak\":\"partial egress lockdown (ipv4=$v4_locked ipv6=$v6_locked); run aborted\"}"
  echo "eval-lockdown: only one IP family could be locked (ipv4=$v4_locked ipv6=$v6_locked)" >&2
  return 1 2>/dev/null || exit 1
fi
if [ "$v4_locked" = 1 ]; then
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    env EVAL_PROXY_PORT=$PROXY_PORT EVAL_ALLOWED_HOSTS="$EVAL_ALLOWED_HOSTS" \
    node /work/scripts/uat-host/evalProxy.mjs >/dev/null 2>"$STATUS_DIR/proxy.log" &
  proxy_up=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if (echo > "/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null; then proxy_up=1; break; fi
    sleep 0.3
  done
  if [ "$proxy_up" != 1 ]; then
    write_status '{"enforced":false,"knownLeak":"egress proxy did not start; run aborted"}'
    echo "eval-lockdown: egress proxy did not start (see $STATUS_DIR/proxy.log)" >&2
    return 1 2>/dev/null || exit 1
  fi
  write_status "{\"enforced\":true,\"allowedHosts\":\"$EVAL_ALLOWED_HOSTS\"}"
  export EVAL_PROXY_URL="http://127.0.0.1:$PROXY_PORT"
  # The host runs as root. Without this it could `iptables -F`, or setuid to the proxy's uid 65534 (which the
  # rule lets out) and reach any host. The entrypoint launches the host through this prefix, so those
  # capabilities are gone from the bounding set and cannot be regained, even through a setuid binary.
  HOST_LAUNCH_PREFIX="setpriv --no-new-privs --bounding-set=-net_admin,-net_raw,-setuid,-setgid"
else
  write_status '{"enforced":false,"knownLeak":"no egress rules could be installed (iptables unavailable); github.com and other hosts were reachable"}'
fi
# /auth is mounted read-only but cores write to their config dir (token refresh, sessions): copy it, so
# writes stay in the container and never reach the host.
seed_auth() { mkdir -p "$1" && cp -a /auth/. "$1/"; }
if [ -n "$UAT_EVAL_AUTH_DIR" ] && [ -n "$UAT_EVAL_CORE" ]; then
  case "$UAT_EVAL_CORE" in claude) seed_auth "$HOME/.claude" ;; codex) seed_auth "$HOME/.codex" ;; esac
fi
