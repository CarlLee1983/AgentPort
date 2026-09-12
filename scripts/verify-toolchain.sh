#!/bin/sh
set -eu

fail() {
  printf 'FAIL toolchain contract: %s\n' "$1" >&2
  exit 1
}

expected_node=$(cat .node-version)
actual_node=$(node --version | sed 's/^v//')
[ "$actual_node" = "$expected_node" ] || fail "Node $expected_node required; found $actual_node"

expected_pnpm=$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "")')
actual_pnpm=$(pnpm --version)
[ "$actual_pnpm" = "$expected_pnpm" ] || fail "pnpm $expected_pnpm required; found $actual_pnpm"

node -e '
  const manifest = require("./package.json");
  const nodeVersion = require("node:fs").readFileSync(".node-version", "utf8").trim();
  if (manifest.engines.node !== nodeVersion) process.exit(1);
  if (manifest.engines.pnpm !== manifest.packageManager.replace(/^pnpm@/, "")) process.exit(1);
' || fail 'manifest tool versions disagree'

for lockfile in package-lock.json npm-shrinkwrap.json yarn.lock bun.lock bun.lockb; do
  [ ! -e "$lockfile" ] || fail "competing lockfile exists: $lockfile"
done

[ -s pnpm-lock.yaml ] || fail 'pnpm-lock.yaml is missing or empty'
printf 'PASS toolchain contract (Node %s, pnpm %s)\n' "$actual_node" "$actual_pnpm"
