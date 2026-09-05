#!/usr/bin/env bash
#
# Install dshrc the way someone who has never seen this machine would.
#
# The earlier "clean install" check was not clean: it ran as the author, with
# deepseek-acp already on PATH, ~/.dsh/.credentials.yaml already present, and
# ~/.dshrc/config.json already written. `dshrc doctor` passed because of the
# machine, not the package.
#
# ISOLATED HERE (everything dshrc actually reads):
#   HOME          fresh empty dir  -> no ~/.dsh, ~/.dshrc, ~/.npmrc, no history
#   PATH          system only      -> no deepseek-acp, no author-installed binaries
#   npm cache     fresh            -> nothing warmed
#
# NOT ISOLATED (no user namespaces on this kernel; bwrap and unshare are denied):
#   kernel, system packages, and the installed Node version. A stranger on
#   Node 18, or without build tools, is NOT covered by this script.
#
# Usage: tools/stranger-check.sh [--pkg dshrc|<tarball path>]
set -u

PKG="${2:-dshrc}"
PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; [ -n "${2:-}" ] && echo "      $2"; FAIL=$((FAIL+1)); }
head2() { sed -n '1,6p' | sed 's/^/      /'; }

REAL_AGENT_DIR=$(dirname "$(command -v deepseek-acp 2>/dev/null || echo /nonexistent/deepseek-acp)")

SB=$(mktemp -d /tmp/dshrc-stranger-XXXXXX)
export HOME="$SB"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export npm_config_cache="$SB/.npm"
export npm_config_prefix="$SB/.local"
export XDG_CONFIG_HOME="$SB/.config" XDG_DATA_HOME="$SB/.local/share"
unset DSH_HOME DSHRC_HOME
mkdir -p "$SB/.local" "$SB/projects"
cd "$SB" || exit 1

echo
echo "  stranger check — HOME=$SB"
echo "  node $(node -v 2>&1), npm $(npm -v 2>&1)"
echo

# ── the machine really is bare ────────────────────────────────────────────────
[ -z "$(command -v deepseek-acp)" ] && ok "deepseek-acp is NOT installed (as a stranger's would be)" \
  || bad "deepseek-acp leaked into the sandbox PATH" "$(command -v deepseek-acp)"
[ ! -e "$HOME/.dsh" ]   && ok "no DeepSeek credentials in HOME"   || bad "~/.dsh leaked in"
[ ! -e "$HOME/.dshrc" ] && ok "no dshrc config in HOME"      || bad "~/.dshrc leaked in"

# ── install exactly as the README says ────────────────────────────────────────
echo
echo "  installing $PKG from the public registry…"
if npm install -g "$PKG" >"$SB/install.log" 2>&1; then
  ok "npm install -g $PKG"
else
  bad "npm install -g $PKG failed"; sed -n '1,10p' "$SB/install.log" | sed 's/^/      /'
fi

BIN="$SB/.local/bin/dshrc"
[ -x "$BIN" ] && ok "dshrc binary is on the prefix" || bad "no dshrc binary produced"
[ -d "$SB/.local/lib/node_modules/dshrc/web" ] && ok "the PWA shipped with it" || bad "web/ missing from the package"

# ── does it behave without deepseek-acp installed? ────────────────────────────
echo
echo "  --- with NO deepseek-acp installed ---"
DOC=$("$BIN" doctor 2>&1)
echo "$DOC" | head2
if echo "$DOC" | grep -qiE "not found|no deepseek-acp|install"; then
  ok "doctor names the missing dependency"
else
  bad "doctor does not tell a stranger that deepseek-acp is missing"
fi
echo "$DOC" | grep -qiE "Error:|ERR_|stack|Cannot find module" \
  && bad "doctor leaked a stack trace instead of a message" || ok "doctor fails cleanly, no stack trace"

UP=$(timeout 25 "$BIN" up --port 4498 2>&1)
echo "$UP" | head2
# STRICT: must name the missing binary, not merely contain the word "deepseek-acp"
# somewhere in an unrelated warning — which is how this check first passed.
echo "$UP" | grep -qiE "deepseek-acp (was )?not found|not found on PATH|install: npm install -g deepseek-acp" \
  && ok "up explains the missing dependency" || bad "up does not explain what is missing"

# ── with deepseek-acp present but no credentials ──────────────────────────────
echo
echo "  --- with deepseek-acp present but NOT logged in ---"
mkdir -p "$SB/.local/bin"
if [ -x "$REAL_AGENT_DIR/deepseek-acp" ]; then
  ln -sf "$REAL_AGENT_DIR/deepseek-acp" "$SB/.local/bin/deepseek-acp"
  export PATH="$SB/.local/bin:$PATH"
  DOC2=$("$BIN" doctor 2>&1)
  echo "$DOC2" | head2
  echo "$DOC2" | grep -qi "deepseek-acp found" && ok "doctor finds deepseek-acp once it is installed" \
    || bad "doctor cannot see a deepseek-acp that is on PATH"
  # STRICT: dshrc must TELL the user what to run. Matching "auth" inside the
  # agent's own "MISSING_CREDENTIAL" error is the agent talking, not us.
  echo "$DOC2" | grep -qiE "deepseek-acp --setup|export DEEPSEEK_API_KEY" \
    && ok "doctor tells a logged-out user to run \`deepseek-acp --setup\`" \
    || bad "doctor passes the agent's raw auth error through without saying what to do"
else
  echo "      (no deepseek-acp binary to link — skipped, denominator 2 checks)"
fi

# ── the one required setting ──────────────────────────────────────────────────
echo
echo "  --- required configuration ---"
CFG=$("$BIN" config 2>&1); echo "$CFG" | head2
echo "$CFG" | grep -qi "defaultCwd" && ok "config tells a stranger defaultCwd is needed" \
  || bad "config does not surface the one required setting"

"$BIN" config set defaultCwd "$SB/projects" >/dev/null 2>&1 \
  && ok "config set defaultCwd works" || bad "config set failed"
grep -q "$SB/projects" "$HOME/.dshrc/config.json" 2>/dev/null \
  && ok "the setting persisted to a fresh HOME" || bad "config did not persist"

echo
echo "  ── $PASS passed, $FAIL failed ──"
echo "  sandbox: $SB (removing)"
cd /; rm -rf "$SB"
[ "$FAIL" -eq 0 ]
