#!/usr/bin/env bash
# Run a command on the Fly.io production machine (dene-translation-db).
#
# Why this exists: flyctl's own `fly ssh console` cannot run in a
# non-interactive / no-real-console environment on Windows — it dies with
# "The handle is invalid." So instead we:
#   1. mint a short-lived SSH certificate with `fly ssh issue`,
#   2. open a `fly proxy` tunnel to the machine's SSH port, and
#   3. drive the native OpenSSH client. Fly's SSH server (hallpass) does NOT
#      honor non-interactive `exec` requests (it just echoes the command), so
#      we force a PTY (-tt) and feed the command on stdin, ending with `exit`.
#
# Usage (run from Git Bash / the Bash tool):
#   scripts/prod-ssh.sh "node -v"
#   scripts/prod-ssh.sh "ls -la /app/data"
#   echo "some; commands" | scripts/prod-ssh.sh        # commands via stdin
#   # offsite DB pull example:
#   scripts/prod-ssh.sh "node -e \"new (require('better-sqlite3'))('/app/data/dene.db').exec(\\\"VACUUM INTO '/tmp/dene.db'\\\")\""
set -euo pipefail

FLY="${FLYCTL:-/c/Users/mike/.fly/bin/flyctl.exe}"
APP=dene-translation-db
KEY="$HOME/.fly-ssh/dene"
PORT="${FLY_SSH_PORT:-10022}"

# 1. Ensure a usable cert. Certs are time-limited (72h); re-issue if the cert is
#    missing or older than 60h, leaving a safety margin.
if [ ! -f "$KEY" ] || [ ! -f "$KEY-cert.pub" ] || find "$KEY-cert.pub" -mmin +3600 2>/dev/null | grep -q .; then
  mkdir -p "$(dirname "$KEY")"
  "$FLY" ssh issue personal "$KEY" --overwrite --hours 72 -u root >/dev/null
  chmod 600 "$KEY" "$KEY-cert.pub"
fi

# 2. Ensure the proxy tunnel is up on $PORT (idempotent: skip if already bound).
proxy_up() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }
if ! proxy_up; then
  ( "$FLY" proxy "$PORT:22" -a "$APP" >"/tmp/fly-proxy-$APP.log" 2>&1 & )
  for _ in $(seq 1 20); do proxy_up && break; sleep 0.5; done
fi

# 3. Feed the command(s) over a forced-PTY session; strip CRs from the output.
if [ "$#" -gt 0 ]; then CMD="$*"; else CMD="$(cat)"; fi
printf '%s\nexit\n' "$CMD" | ssh -tt -i "$KEY" \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o IdentitiesOnly=yes -o LogLevel=ERROR \
  -p "$PORT" root@localhost 2>&1 | tr -d '\r'
