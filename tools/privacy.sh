#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

home='(https?://[^/[:space:]"'"'"',;<>()\\]+[^[:space:]"'"'"',;<>()\\]*)?(/[Uu][Ss][Ee][Rr][Ss]/|/home/|/root/|([A-Za-z]:)?\\{1,2}[Uu][Ss][Ee][Rr][Ss]\\{1,2})([[:alnum:]._-]|[^[:print:][:cntrl:]])+'
web_url='^https?://[^/]'
synthetic_homes='^$'
email='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
ssh_remote='git@[A-Za-z0-9.-]+:[^[:space:]]*'
personal_mail='[A-Za-z0-9._%+-]+@(gmail|googlemail|hotmail|outlook|live|msn|icloud|me|mac|yahoo|ymail|aol|gmx|web|proton|protonmail|pm|yandex|uol|bol|terra|zoho|fastmail|tutanota)(\.[A-Za-z]{2,3}){1,2}([^A-Za-z0-9-]|$)'
public_address='^([^@[:space:]]+@users\.noreply\.github\.com|(noreply|support)@github\.com|noreply@(anthropic|openai)\.com|[^@[:space:]]+@example\.(com|net|org)|[^@[:space:]]+@([a-z0-9-]+\.)*(example|invalid|test|localhost))$'
status=0

fail() {
  echo "privacy: $*" >&2
  status=1
}

real_homes() {
  grep -oE "$home" | grep -viE "$web_url" | sed -E 's#.*[/\\]##; s#[.]+$##' | grep -vixE "$synthetic_homes" || true
}

grep_tree() {
  local rc=0 flags=(-a -h -o -E)
  [[ "${3:-}" == any-case ]] && flags+=(-i)
  if [[ "$1" == index ]]; then
    git grep --cached "${flags[@]}" -e "$2" || rc=$?
  else
    git grep "${flags[@]}" -e "$2" "$1" || rc=$?
  fi
  if ((rc > 1)); then
    echo "privacy: git grep failed" >&2
    exit 2
  fi
}

check_files() {
  local found list="git grep -nE -e '$home' $1" mail="git grep -niE -e '$personal_mail' $1"
  if [[ "$1" == index ]]; then
    list="git grep --cached -nE -e '$home'"
    mail="git grep --cached -niE -e '$personal_mail'"
  fi
  found="$(grep_tree "$1" "$home" | real_homes)"
  [[ -z "$found" ]] || fail "$2: a file holds a home folder path; list them with $list"
  found="$(grep_tree "$1" "$personal_mail" any-case)"
  [[ -z "$found" ]] || fail "$2: a file holds a personal email address; list them with $mail"
}

check_links() {
  if [[ -n "$1" ]]; then
    fail "$2: remove the $(wc -l <<<"$1" | tr -d ' ') symbolic links; list them with git ls-tree -r $3 | grep ^120000"
  fi
}

check_address() {
  local address
  address="$(tr '[:upper:]' '[:lower:]' <<<"$2")"
  [[ "$address" =~ $public_address ]] || fail "$1: use a GitHub noreply address"
}

check_names() {
  local found
  found="$(awk '{print "/" $0}' <<<"$1" | real_homes)"
  [[ -z "$found" ]] || fail "$2: a path name holds a home folder path"
  found="$(grep -oiE "$personal_mail" <<<"$1" || true)"
  [[ -z "$found" ]] || fail "$2: a path name holds a personal email address"
}

check_text() {
  local name="$1" text="$2" homes addresses found
  homes="$(real_homes <<<"$text")"
  [[ -z "$homes" ]] || fail "$name: remove the home folder path"
  text="$(sed -E "s#$ssh_remote##g" <<<"$text")"
  addresses="$(grep -oE "$email" <<<"$text" || true)"
  addresses+=$'\n'"$(sed -n 's/^[A-Za-z-]*-[Bb][Yy]:.*<\(.*\)>.*/\1/p' <<<"$text")"
  for found in $addresses; do
    check_address "$name" "$found"
  done
}

check_commit() {
  local commit="$1" short="${1:0:12}" links names
  links="$(git ls-tree -r "$commit" | awk '$1 == "120000" {print $4}')"
  check_links "$links" "commit $short" "$short"
  check_files "$commit" "commit $short"
  names="$(git -c core.quotePath=false ls-tree -r --name-only "$commit")"
  check_names "$names" "commit $short"
  check_address "commit $short author" "$(git log -1 --format=%ae "$commit")"
  check_address "commit $short committer" "$(git log -1 --format=%ce "$commit")"
  check_text "commit $short identity names" "$(git log -1 --format='%an%n%cn' "$commit")"
  check_text "commit $short message" "$(git log -1 --format=%B "$commit")"
}

case "${1:-index}" in
  index)
    links="$(git ls-files --stage | awk '$1 == "120000" {print $4}')"
    check_links "$links" index HEAD
    check_files index index
    names="$(git -c core.quotePath=false ls-files)"
    check_names "$names" index
    ;;
  commits)
    shift
    commits="$(git rev-list "$@")"
    for commit in $commits; do
      check_commit "$commit"
    done
    ;;
  tag)
    [[ "$(git cat-file -t "$2")" == tag ]] || exit 0
    tag="$(git cat-file tag "$2")"
    header="$(sed '/^$/q' <<<"$tag")"
    [[ "$(sed -n 's/^type //p' <<<"$header")" == commit ]] || fail "tag ${2:0:12}: tag a commit"
    check_address "tag ${2:0:12} tagger" "$(sed -n 's/^tagger .*<\(.*\)> .*/\1/p' <<<"$header")"
    check_text "tag ${2:0:12} tagger name" "$(sed -n 's/^tagger \(.*\) <.*/\1/p' <<<"$header")"
    check_text "tag ${2:0:12} message" "$(sed '1,/^$/d' <<<"$tag")"
    ;;
  ref)
    check_text "ref name" "$2"
    ;;
  *)
    echo "usage: tools/privacy.sh [index | commits <rev-list arguments> | tag <object> | ref <name>]" >&2
    exit 2
    ;;
esac
exit "$status"
