#!/bin/sh
# The icon's executable, used by both copies of the app: the one in the repository and
# the packaged one `npm run app:bundle` makes. It finds its own code either way.
#
# Nothing here writes to a terminal, because a double-clicked app has none. Output goes
# to a log, and anything that stops it from starting is said in a dialog — the one way
# a double-clicked app can say anything at all.

set -u
here=$(cd "$(dirname "$0")" && pwd)
contents=$(cd "$here/.." && pwd)
app=$(cd "$contents/.." && pwd)

# Packaged: the code travels inside the bundle. Otherwise: the repository around it.
if [ -f "$contents/Resources/app/server/launch.mjs" ]; then
  root="$contents/Resources/app"
  bundled=1
else
  root=$(cd "$app/.." && pwd)
  bundled=0
fi

alert() {
  /usr/bin/osascript -e "display alert \"XLE Grammar Explorer\" message \"$1\" as critical" >/dev/null 2>&1
}

if [ ! -f "$root/server/launch.mjs" ]; then
  alert "This app cannot find its own files. Keep it inside the folder it came in."
  exit 1
fi

# A double-clicked app inherits a bare PATH — /usr/bin:/bin:/usr/sbin:/sbin — and none
# of the usual places to install Node are on it. Look where they actually are.
node=""
for candidate in \
  "$(command -v node 2>/dev/null)" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then node="$candidate"; break; fi
done
if [ -z "$node" ]; then
  # nvm keeps versions under the home directory and puts none of them on PATH.
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then node="$candidate"; break; fi
  done
fi

if [ -z "$node" ]; then
  answer=$(/usr/bin/osascript -e 'display alert "XLE Grammar Explorer" message "Node.js is needed to run the explorer, and is not installed on this Mac.

Install it, then open this app again." buttons {"Cancel", "Get Node.js"} default button 2' 2>/dev/null)
  case "$answer" in
    *"Get Node.js"*) /usr/bin/open "https://nodejs.org/en/download" ;;
  esac
  exit 1
fi

log="$HOME/Library/Logs/XLE Grammar Explorer.log"
mkdir -p "$(dirname "$log")"
: > "$log"

XLE_APP_BUNDLE="$bundled" "$node" "$root/server/launch.mjs" >>"$log" 2>&1
status=$?

# A clean exit is the explorer having been closed; only a failure needs saying. The log
# holds the reason, and an alert cannot hold it legibly, so it offers the log instead.
if [ "$status" -ne 0 ]; then
  answer=$(/usr/bin/osascript -e 'display alert "XLE Grammar Explorer" message "The explorer could not start. The log says why." buttons {"OK", "Open Log"} default button 2 as critical' 2>/dev/null)
  case "$answer" in
    *"Open Log"*) /usr/bin/open -t "$log" ;;
  esac
fi
exit "$status"
