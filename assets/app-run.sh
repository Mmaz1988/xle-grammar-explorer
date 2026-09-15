#!/bin/sh
# What Terminal runs: the explorer itself, in a window you can watch and interrupt.
#
# The window is the point. A browser-based tool whose server is invisible is a tool you
# cannot stop when something goes wrong with the browser — the tab crashes, or is closed
# in a way that never reports it, and a process you cannot see goes on holding a port
# and an XLE session. Jupyter keeps its terminal for the same reason. Ctrl-C here always
# works, whatever the browser did.
#
# Used by both copies: this file is `XLE Grammar Explorer.command` in the repository and
# `Contents/Resources/app/run.command` inside the packaged app. It works out which by
# looking for the code.

set -u
here=$(cd "$(dirname "$0")" && pwd)

if [ -f "$here/server/launch.mjs" ]; then
  root="$here"            # Packaged: this script sits beside the code it runs.
  bundled=1
else
  root="$here"            # Repository: the script sits at the top of it.
  bundled=0
fi

if [ ! -f "$root/server/launch.mjs" ]; then
  echo "Cannot find the explorer's files. Keep this script in the folder it came in."
  printf "Press return to close. "
  read -r _
  exit 1
fi

# A window opened from Finder inherits a bare PATH — /usr/bin:/bin:/usr/sbin:/sbin —
# and Homebrew, nvm and the official installer all put node somewhere else.
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
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then node="$candidate"; break; fi
  done
fi

if [ -z "$node" ]; then
  echo "Node.js is needed to run the explorer, and is not installed on this Mac."
  echo "Install it from https://nodejs.org and open this again."
  echo
  # Said twice on purpose: the window may be behind something, and this is the one
  # failure someone can fix in a minute if they are told where to go.
  answer=$(/usr/bin/osascript -e 'display alert "XLE Grammar Explorer" message "Node.js is needed to run the explorer, and is not installed on this Mac.

Install it, then open this app again." buttons {"Cancel", "Get Node.js"} default button 2' 2>/dev/null)
  case "$answer" in
    *"Get Node.js"*) /usr/bin/open "https://nodejs.org/en/download" ;;
  esac
  printf "Press return to close. "
  read -r _
  exit 1
fi

XLE_APP_BUNDLE="$bundled" "$node" "$root/server/launch.mjs"
status=$?

# Hold the window open on failure; the reason is above and would otherwise vanish with
# the window. A clean exit is the explorer having been closed, which needs no epitaph.
if [ "$status" -ne 0 ]; then
  echo
  printf "Press return to close. "
  read -r _
fi
exit "$status"
