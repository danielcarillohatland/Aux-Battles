#!/usr/bin/env bash
#
# AUX BATTLES — live playtest facilitator checklist.
#
# Pretty-prints the session protocol + questionnaire straight from
# docs/PLAYTEST.md so whoever runs the party can follow the structured
# loop on screen (or printed) without re-reading markdown mid-chaos.
# Single source of truth stays the doc — edit there, run this again.
#
# Usage:   scripts/playtest-checklist.sh
#          NO_COLOR=1 scripts/playtest-checklist.sh   (plain output)
#
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC="$ROOT/docs/PLAYTEST.md"

if [[ ! -f "$DOC" ]]; then
  echo "docs/PLAYTEST.md not found (looked next to: $ROOT)" >&2
  exit 1
fi

# ── palette (ANSI only on a TTY; NO_COLOR wins) ──────────────────────────────
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  B=$'\e[1m'
  DIM=$'\e[2m'
  MAG=$'\e[95m'
  VIO=$'\e[38;5;99m'
  GOLD=$'\e[93m'
  GREEN=$'\e[92m'
  RED=$'\e[91m'
  RST=$'\e[0m'
else
  B=''
  DIM=''
  MAG=''
  VIO=''
  GOLD=''
  GREEN=''
  RED=''
  RST=''
fi

BOX='☐'
RULE='──────────────────────────────────────────────────────────'

rule() { printf '%s%s%s\n' "$DIM" "$RULE" "$RST"; }

section() {
  printf '\n'
  rule
  printf '%s%s%s\n' "$B$VIO" "  $1" "$RST"
  rule
}

# slice '<header>' — emit doc body between an H2 and the next H2.
slice() {
  awk -v start="$1" '$0 ~ start { on = 1; next } /^## / { on = 0 } on' "$DOC"
}

# strip inline markdown emphasis/code so terminal copy stays clean.
strip_md() {
  sed -E 's/`([^`]*)`/\1/g; s/\*\*([^*]+)\*\*/\1/g; s/\*([^*]+)\*/\1/g'
}

cat <<EOF

$B$MAG   ⚔  A U X   B A T T L E S  —  P L A Y T E S T $RST
$DIM   facilitator checklist · generated from docs/PLAYTEST.md$RST
$DIM   success criterion: "would people voluntarily play another round?"$RST

$DIM   setup:$RST fresh room · real phones · host device as intended
$DIM   vibe:$RST   say NOTHING about rules — watch them self-explain

EOF

# ── session protocol ────────────────────────────────────────────────────────
section 'SESSION PROTOCOL'
slice '^## Session protocol' | strip_md | grep -E '^[0-9]+\.' |
  while IFS= read -r line; do
    n="${line%%.*}"
    rest="${line#*. }"
    printf '  %s%s%s %sstep %s%s — %s\n' "$GREEN" "$BOX" "$RST" "$B" "$n" "$RST" "$rest"
  done || true

# ── questionnaire ───────────────────────────────────────────────────────────
section 'QUESTIONNAIRE · ask every player, out loud, after 3 rounds'
slice '^## Questionnaire' | strip_md | grep -E '^[0-9]+\.' |
  while IFS= read -r line; do
    n="${line%%.*}"
    rest="${line#*. }"
    printf '  %s%s%s %sQ%-2s%s %s\n' "$GOLD" "$BOX" "$RST" "$B" "$n" "$RST" "$rest"
  done || true

# ── live-capture log template ───────────────────────────────────────────────
section 'FILL THE LOG BEFORE YOU FORGET'
printf '  %scopy this into your notes verbatim:%s\n\n' "$DIM" "$RST"
awk '/^```/{inblock=!inblock; next} inblock' "$DOC" | while IFS= read -r line; do
  printf '  %s│%s %s\n' "$DIM" "$RST" "$line"
done

# ── kill criteria ───────────────────────────────────────────────────────────
section "KILL CRITERIA · any hit = stop feature work"
slice '^## Kill criteria' | strip_md | grep -E '^-' |
  while IFS= read -r line; do
    printf '  %s🛑%s %s\n' "$RED" "$RST" "${line#- }"
  done || true

cat <<EOF

$B  remember:$RST the moment someone says $GOLD"one more round"$RST — that's the metric. 🎉

EOF
