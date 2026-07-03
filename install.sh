#!/bin/sh
# install.sh — install the lark-acp CLI globally straight from GitHub.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/install.sh | sh
#   ./install.sh
#
# Overrides (environment variables):
#   LARK_ACP_REPO   GitHub owner/repo   (default: wangmingliang-ms/lark-acp)
#   LARK_ACP_REF    git ref to install  (default: main)
#
# Example:
#   LARK_ACP_REF=v0.2.0 sh install.sh

set -eu

REPO="${LARK_ACP_REPO:-wangmingliang-ms/lark-acp}"
REF="${LARK_ACP_REF:-main}"
MIN_NODE_MAJOR=20

fail() {
  echo "lark-acp install: $1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git not found. Install git first: https://git-scm.com/downloads"
command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js >= ${MIN_NODE_MAJOR}: https://nodejs.org/"
command -v npm >/dev/null 2>&1 || fail "npm not found. It ships with Node.js: https://nodejs.org/"

node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node.js >= ${MIN_NODE_MAJOR} required, found $(node --version)."
fi

target="git+https://github.com/${REPO}.git#${REF}"
echo "lark-acp install: installing from ${target} ..."
npm install -g "$target"

if command -v lark-acp >/dev/null 2>&1; then
  echo "lark-acp install: done. Run 'lark-acp --help' to get started."
else
  bin_dir="$(npm prefix -g)/bin"
  echo "lark-acp install: installed, but 'lark-acp' is not on your PATH." >&2
  echo "Add npm's global bin directory to PATH, e.g.:" >&2
  echo "  export PATH=\"${bin_dir}:\$PATH\"" >&2
fi
