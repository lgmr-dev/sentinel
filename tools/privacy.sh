#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

home='(^|[^A-Za-z0-9._~-])(/Users/|/home/|/root/|[A-Za-z]:\\{1,2}Users\\{1,2})[A-Za-z0-9._-]+'
synthetic_homes='^$'
email='[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)*'
public_address='^([^@[:space:]]+@users\.noreply\.github\.com|(noreply|no-reply)@[A-Za-z0-9.-]+|[^@[:space:]]+@github\.com|[^@[:space:]]+@example\.(com|net|org)|[^@[:space:]]+@([A-Za-z0-9-]+\.)*(example|invalid|test|localhost))$'
status=0

fail() {
  echo "privacy: $*" >&2
  status=1
}

real_homes() {
  grep -oE "$home" | sed -E 's#.*[/\\]##' | grep -vxE "$synthetic_homes" || true
}

grep_paths() {
  local hits rc=0 where="$1" list="git grep -nE -e '$home' $1"
  if [[ "$1" == index ]]; then
    where=--cached
    list="git grep --cached -nE -e '$home'"
  fi
  hits="$(git grep -a -h -o -E -e "$home" "$where")" || rc=$?
  if ((rc > 1)); then
    echo "privacy: git grep failed" >&2
    exit 2
  fi
  if [[ -n "$(real_homes <<<"$hits")" ]]; then
    fail "$2: a file holds a home folder path; list them with $list"
  fi
}

check_links() {
  if [[ -n "$1" ]]; then
    fail "$2: remove the $(wc -l <<<"$1" | tr -d ' ') symbolic links; list them with git ls-tree -r $3 | grep ^120000"
  fi
}

check_address() {
  [[ "$2" =~ $public_address ]] || fail "$1: use a GitHub noreply address"
}

check_names() {
  if [[ -n "$(awk '{print "/" $0}' <<<"$1" | real_homes)" ]]; then
    fail "$2: a path name holds a home folder path"
  fi
}

check_text() {
  local name="$1" text="$2" addresses found
  if [[ -n "$(real_homes <<<"$text")" ]]; then
    fail "$name: remove the home folder path from the message"
  fi
  addresses="$(grep -oE "$email" <<<"$text" || true)"
  addresses+=$'\n'"$(sed -n 's/^[A-Za-z-]*-[Bb]y: .*<\(.*\)>.*/\1/p' <<<"$text")"
  for found in $addresses; do
    check_address "$name" "$found"
  done
}

case "${1:-index}" in
  index)
    links="$(git ls-files --stage | awk '$1 == "120000" {print $4}')"
    check_links "$links" index HEAD
    grep_paths index index
    names="$(git ls-files)"
    check_names "$names" index
    ;;
  commits)
    shift
    commits="$(git rev-list "$@")"
    for commit in $commits; do
      short="${commit:0:12}"
      links="$(git ls-tree -r "$commit" | awk '$1 == "120000" {print $4}')"
      check_links "$links" "commit $short" "$short"
      grep_paths "$commit" "commit $short"
      names="$(git ls-tree -r --name-only "$commit")"
      check_names "$names" "commit $short"
      check_address "commit $short author" "$(git log -1 --format=%ae "$commit")"
      check_address "commit $short committer" "$(git log -1 --format=%ce "$commit")"
      check_text "commit $short" "$(git log -1 --format=%B "$commit")"
    done
    ;;
  tag)
    [[ "$(git cat-file -t "$2")" == tag ]] || exit 0
    [[ "$(git cat-file tag "$2" | sed -n 's/^type //p')" == commit ]] || fail "tag ${2:0:12}: tag a commit"
    tagger="$(git cat-file tag "$2" | sed -n 's/^tagger .*<\(.*\)> .*/\1/p')"
    check_address "tag ${2:0:12} tagger" "$tagger"
    check_text "tag ${2:0:12}" "$(git cat-file tag "$2" | sed '1,/^$/d')"
    ;;
  *)
    echo "usage: tools/privacy.sh [index | commits <rev-list arguments> | tag <object>]" >&2
    exit 2
    ;;
esac
exit "$status"
