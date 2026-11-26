#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export GIT_NO_REPLACE_OBJECTS=1

home='([Hh][Tt][Tt][Pp][Ss]?://(\[[0-9A-Fa-f:.]+\]|[^]/[:space:]"'"'"',;<>()|`\\{}[]+)[^][:space:]"'"'"',;<>()|`\\{}[]*)?([A-Za-z]:)?(/|\\{1,2})([Uu][Ss][Ee][Rr][Ss]|home|root)(/|\\{1,2})([[:alnum:]._-]|%[0-9A-Fa-f]{2}|[^[:print:][:cntrl:]])+'
web_url='^https?://[^/]'
synthetic_homes='^$'
email='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
ssh_remote='(^|[^A-Za-z0-9._%+-])git@[A-Za-z0-9.-]+(:|/)[A-Za-z0-9._~/-]+'
personal_mail='[A-Za-z0-9._%+-]+@(gmail|googlemail|hotmail|outlook|live|msn|icloud|me|mac|yahoo|ymail|aol|gmx|web|proton|protonmail|pm|yandex|uol|bol|terra|zoho|fastmail|tutanota|tuta)(\.[A-Za-z]{2,3}){1,2}([^A-Za-z0-9-]|$)'
public_address='^([^@[:space:]]+@users\.noreply\.(github|gitlab)\.com|(noreply|support|web-flow)@github\.com|noreply@(anthropic|openai)\.com|[^@[:space:]]+@([a-z0-9-]+\.)*example\.(com|net|org)|[^@[:space:]]+@([a-z0-9-]+\.)*(example|invalid|test|localhost))$'
not_address='@(v?[0-9]+\.[0-9]|[0-9]+x\.|[A-Za-z0-9_.-]+\.(service|socket|timer|target|mount|path|slice|scope|device|swap|automount)$)'
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
  local found where="$1" list mail
  [[ "$1" == index ]] && where=--cached
  list="git grep -nE -e $(printf '%q' "$home") $where"
  mail="git grep -niE -e $(printf '%q' "$personal_mail") $where"
  found="$(grep_tree "$1" "$home" | real_homes)"
  [[ -z "$found" ]] || fail "$2: a file holds a home folder path; list them with $list"
  found="$(grep_tree "$1" "$personal_mail" any-case)"
  [[ -z "$found" ]] || fail "$2: a file holds a personal email address; list them with $mail"
  check_utf16 "$1" "$2"
}

check_utf16() {
  local rc=0 path text bom prefix=":" listing
  [[ "$1" == index ]] || prefix="$1:"
  listing="$(mktemp)"
  if [[ "$1" == index ]]; then
    LC_ALL=C git grep --cached -z -l -a -e $'^\xff\xfe' -e $'^\xfe\xff' > "$listing" || rc=$?
  else
    LC_ALL=C git grep -z -l -a -e $'^\xff\xfe' -e $'^\xfe\xff' "$1" > "$listing" || rc=$?
  fi
  if ((rc > 1)); then
    rm -f "$listing"
    echo "privacy: git grep failed" >&2
    exit 2
  fi
  while IFS= read -r -d '' path; do
    [[ "$1" == index ]] || path="${path#"$1":}"
    bom="$(git cat-file blob "$prefix$path" | head -c 2 | od -An -tx1 | tr -d ' \n' || true)"
    [[ "$bom" == fffe || "$bom" == feff ]] || continue
    if ! text="$(git cat-file blob "$prefix$path" | iconv -f UTF-16 -t UTF-8)"; then
      fail "$2: the UTF-16 file $path cannot be read"
      continue
    fi
    if [[ -n "$(real_homes <<<"$text")" || -n "$(grep -oiE "$personal_mail" <<<"$text" || true)" ]]; then
      fail "$2: the UTF-16 file $path holds a home folder path or a personal email address"
    fi
  done < "$listing"
  rm -f "$listing"
}

check_links() {
  if [[ -n "$1" ]]; then
    fail "$2: remove the $(wc -l <<<"$1" | tr -d ' ') symbolic links; list them with $3 | grep ^120000"
  fi
}

check_address() {
  local address
  address="$(tr '[:upper:]' '[:lower:]' <<<"$2")"
  [[ "$address" =~ $public_address ]] || fail "$1: use a GitHub noreply address"
}

check_addresses() {
  local name="$1" text addresses found
  text="$(sed -E "s#$ssh_remote##g" <<<"$2")"
  addresses="$(grep -oE "$email" <<<"$text" | grep -viE "$not_address" || true)"
  addresses+=$'\n'"$(grep -E '^[A-Za-z-]*-[Bb][Yy]:' <<<"$text" | grep -oE '<[^<>]*@[^<>]*>' | tr -d '<>' || true)"
  for found in $addresses; do
    check_address "$name" "$found"
  done
  return 0
}

check_names() {
  local found
  found="$(awk '{print "/" $0}' <<<"$1" | real_homes)"
  [[ -z "$found" ]] || fail "$2: a path name holds a home folder path"
  found="$(grep -oiE "$personal_mail" <<<"$1" || true)"
  [[ -z "$found" ]] || fail "$2: a path name holds a personal email address"
  check_addresses "$2 path name" "$1"
}

check_text() {
  local homes
  homes="$(real_homes <<<"$2")"
  [[ -z "$homes" ]] || fail "$1: remove the home folder path"
  check_addresses "$1" "$2"
}

check_commit() {
  local commit="$1" short="${1:0:12}" links names mergetag tagger
  links="$(git ls-tree -r "$commit" | awk '$1 == "120000" {print $4}')"
  check_links "$links" "commit $short" "git ls-tree -r $short"
  check_files "$commit" "commit $short"
  names="$(git ls-tree -r -z --name-only "$commit" | tr '\0' '\n')"
  check_names "$names" "commit $short"
  check_address "commit $short author" "$(git log -1 --no-show-signature --format=%ae "$commit")"
  check_address "commit $short committer" "$(git log -1 --no-show-signature --format=%ce "$commit")"
  check_text "commit $short identity names" "$(git log -1 --no-show-signature --format='%an%n%cn' "$commit")"
  check_text "commit $short message" "$(git log -1 --no-show-signature --format=%B "$commit")"
  mergetag="$(git cat-file commit "$commit" | awk '/^$/ { exit } /^mergetag / { tag = 1; sub(/^mergetag /, ""); print; next } /^ / { if (tag) { sub(/^ /, ""); print }; next } { tag = 0 }')"
  if [[ -n "$mergetag" ]]; then
    while IFS= read -r tagger; do
      check_address "commit $short merged tag tagger" "$tagger"
    done < <(sed -n 's/^tagger .*<\(.*\)> .*/\1/p' <<<"$mergetag")
    check_text "commit $short merged tag" "$mergetag"
  fi
}

case "${1:-index}" in
  index)
    links="$(git ls-files --stage | awk '$1 == "120000" {print $4}')"
    check_links "$links" index "git ls-files --stage"
    check_files index index
    names="$(git ls-files -z | tr '\0' '\n')"
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
    check_text "tag ${2:0:12} header" "$(sed -n 's/^tag //p; s/^tagger \(.*\) <.*/\1/p' <<<"$header")"
    check_text "tag ${2:0:12} message" "$(sed '1,/^$/d' <<<"$tag")"
    ;;
  ref)
    check_addresses "ref name" "$2"
    ;;
  *)
    echo "usage: tools/privacy.sh [index | commits <rev-list arguments> | tag <object> | ref <name>]" >&2
    exit 2
    ;;
esac
exit "$status"
