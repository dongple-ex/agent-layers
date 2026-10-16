#!/usr/bin/env sh
# Bootstrap agent-layers on macOS, Linux or WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/dongple-ex/agent-layers/main/install/install.sh -o install-agent-layers.sh
#   less install-agent-layers.sh
#   sh install-agent-layers.sh https://github.com/you/my-agent-layers.git
#
# Environment:
#   AGENT_LAYERS_PACKAGE   npm package spec (default: agent-layers)
#   AGENT_LAYERS_APPLY=1   run "agent-layers apply" at the end
set -eu

REPO="${1:-}"
PACKAGE="${AGENT_LAYERS_PACKAGE:-agent-layers}"

have() {
  command -v "$1" >/dev/null 2>&1
}

if ! have git; then
  if have brew; then
    brew install git
  else
    echo "git is required; install it with your package manager and run this script again." >&2
    exit 1
  fi
fi

if ! have node; then
  if have brew; then
    brew install node
  else
    echo "Node.js 18.17+ is required. Install it (for example with mise, fnm or your package manager) and run this script again." >&2
    exit 1
  fi
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18.17+ is required (found $(node --version))." >&2
  exit 1
fi

PREFIX=$(npm prefix -g)
if [ -w "$PREFIX" ] || [ -w "$PREFIX/lib" ] 2>/dev/null; then
  npm install --global "$PACKAGE"
  AS="agent-layers"
else
  echo "The global npm prefix ($PREFIX) is not writable; using npx instead of a global install."
  AS="npx --yes $PACKAGE"
fi

if [ -n "$REPO" ]; then
  $AS init --from "$REPO"
else
  $AS init
fi

$AS doctor || true
$AS secrets check || true
$AS plan

if [ "${AGENT_LAYERS_APPLY:-0}" = "1" ]; then
  $AS apply
else
  echo
  echo "Review the plan above, store missing secrets with \"agent-layers secrets set <name>\","
  echo "then run \"agent-layers apply\"."
fi
