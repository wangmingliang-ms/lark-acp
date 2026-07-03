#!/bin/sh
# install.sh — install the lark-acp CLI globally straight from GitHub.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wangmingliang-ms/lark-acp/main/install.sh | sh
#   ./install.sh
#
# Overrides (environment variables):
#   LARK_ACP_REPO   GitHub owner/repo   (default: wangmingliang-ms/lark-acp)
#   LARK_ACP_REF    git branch or tag   (default: main)
#
# Example:
#   LARK_ACP_REF=v0.2.0 sh install.sh
#
# Why clone+build instead of `npm i -g git+https://...`:
#   npm's git-dependency prepare sandbox runs this package's `prepare` build
#   (tsc) against a node_modules whose .bin/tsc is not executable, so the build
#   dies with "tsc: Permission denied". Cloning and building in a normal working
#   directory sidesteps that sandbox entirely.

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

# Clone into a temp dir, build there, install a real copy globally, then clean up.
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/lark-acp-install.XXXXXX")"
# shellcheck disable=SC2064
trap "rm -rf \"$work_dir\"" EXIT INT TERM

repo_dir="${work_dir}/lark-acp"
clone_url="https://github.com/${REPO}.git"

echo "lark-acp install: cloning ${clone_url} (ref: ${REF}) ..."
git clone --depth 1 --branch "$REF" "$clone_url" "$repo_dir" \
  || fail "git clone failed for ${clone_url} (ref: ${REF})."

echo "lark-acp install: installing dependencies ..."
(cd "$repo_dir" && npm install --no-audit --no-fund) || fail "npm install failed."

echo "lark-acp install: building ..."
(cd "$repo_dir" && npm run build) || fail "build failed."

# --install-links forces npm to copy the package instead of symlinking it into
# the temp dir (which the trap removes on exit). Without it the global bin would
# dangle the moment this script finishes.
echo "lark-acp install: installing globally ..."
(cd "$repo_dir" && npm install -g --install-links .) || fail "global install failed."

if command -v lark-acp >/dev/null 2>&1; then
  echo "lark-acp install: done. Run 'lark-acp --help' to get started."
else
  bin_dir="$(npm prefix -g)/bin"
  echo "lark-acp install: installed, but 'lark-acp' is not on your PATH." >&2
  echo "Add npm's global bin directory to PATH, e.g.:" >&2
  echo "  export PATH=\"${bin_dir}:\$PATH\"" >&2
fi
