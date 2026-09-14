#!/bin/sh
# Double-clickable launcher for macOS. Finder runs a .command in Terminal, which is
# wanted rather than tolerated: if XLE or a suitable browser is missing, the reason has
# to land somewhere the person who clicked can read it.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed, or not on the PATH this window inherited."
  echo "Install it from https://nodejs.org and try again."
  echo
  printf "Press return to close. "
  read -r _
  exit 1
fi

node server/launch.mjs
status=$?

# On failure the launcher has already explained itself; hold the window open so the
# explanation survives Terminal closing on exit.
if [ $status -ne 0 ]; then
  echo
  printf "Press return to close. "
  read -r _
fi
exit $status
