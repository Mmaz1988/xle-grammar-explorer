#!/bin/sh
# The icon's executable. Its whole job is to open a Terminal window running the
# explorer, because a server with no visible window is one nobody can stop by hand.
#
# Used by both copies of the app: the one in the repository, where the runner sits
# beside it, and the packaged one, where the runner travels inside the bundle.

set -u
here=$(cd "$(dirname "$0")" && pwd)
contents=$(cd "$here/.." && pwd)
app=$(cd "$contents/.." && pwd)

if [ -x "$contents/Resources/app/run.command" ]; then
  runner="$contents/Resources/app/run.command"        # Packaged.
else
  runner="$(cd "$app/.." && pwd)/XLE Grammar Explorer.command"   # In the repository.
fi

if [ ! -x "$runner" ]; then
  /usr/bin/osascript -e 'display alert "XLE Grammar Explorer" message "This app cannot find the script it runs. Keep it inside the folder it came in." as critical' >/dev/null 2>&1
  exit 1
fi

if ! /usr/bin/open -a Terminal "$runner"; then
  /usr/bin/osascript -e 'display alert "XLE Grammar Explorer" message "Terminal could not be opened, so there is nowhere to run the explorer." as critical' >/dev/null 2>&1
  exit 1
fi
