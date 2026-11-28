#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export GIT_NO_REPLACE_OBJECTS=1

url_char='[^][:space:]"'"'"',;<>()|`\\{}]'
url_host='(\[[0-9A-Fa-f:.]+\]|[^]/[:space:]"'"'"',;<>()|`\\{}[]+)'
home="([Hh][Tt][Tt][Pp][Ss]?://$url_host($url_char|\\($url_char*\\))*)?([A-Za-z]:)?(/|\\\\{1,2})([Uu][Ss][Ee][Rr][Ss]|home|root)(/|\\\\{1,2})([[:alnum:]._-]|%[0-9A-Fa-f]{2}|[^[:print:][:cntrl:]])+"
web_url='^https?://[^/]'
synthetic_homes='^$'
system_homes='[/\\]users[/\\]+(shared|public|default)[.]*$'
email='([[:alnum:]._%+-]|[^[:print:][:cntrl:][:space:]])+@([[:alnum:]-]|[^[:print:][:cntrl:][:space:]])+(\.([[:alnum:]-]|[^[:print:][:cntrl:][:space:]])+)*\.([[:alpha:]]|[^[:print:][:cntrl:][:space:]]){2,}'
ssh_remote='(^|[^A-Za-z0-9._%+-])git@[A-Za-z0-9.-]+(:|/)[A-Za-z0-9._~/-]+'
url_user='[Hh][Tt][Tt][Pp][Ss]?://[A-Za-z0-9._~%:+-]+@'
separators="$(printf '\302[\240-\277]|\342\200[\200-\277]|\342\201[\200-\257]|\343\200[\200\201\203-\277]|\357\274[\200-\215\217\232-\240\273-\277]|\357\275[\200\233-\240\242-\245]')"
dots="$(printf '\343\200\202|\357\274\216|\357\275\241')"
personal_mail='([[:alnum:]._%+-]|[^[:print:][:cntrl:][:space:]])+@(gmail|googlemail|mail|hotmail|outlook|live|msn|passport|icloud|me|mac|yahoo|ymail|rocketmail|aol|aim|proton|protonmail|pm|tutanota|tuta|tutamail|keemail|fastmail|hey|posteo|mailbox|runbox|startmail|disroot|riseup|skiff|duck|zoho|att|sbcglobal|bellsouth|pacbell|prodigy|swbell|ameritech|flash|comcast|xfinity|verizon|cox|charter|spectrum|rr|twc|earthlink|juno|netzero|frontier|frontiernet|centurylink|windstream|optonline|optimum|suddenlink|mediacom|shaw|rogers|sympatico|bell|videotron|telus|cogeco|btinternet|btopenworld|sky|virginmedia|ntlworld|blueyonder|talktalk|tiscali|gmx|web|t-online|freenet|arcor|free|sfr|neuf|laposte|orange|wanadoo|libero|virgilio|alice|tin|tim|seznam|centrum|atlas|onet|wp|o2|interia|abv|yandex|ya|rambler|inbox|list|bk|naver|daum|hanmail|nate|163|126|yeah|qq|foxmail|sina|sohu|aliyun|rediffmail|uol|bol|terra|ig|bigpond|optusnet|iinet|tpg|xtra)(\.[A-Za-z]{2,3}){1,2}([^A-Za-z0-9-]|$)'
public_address='^([^@[:space:]]+@users\.noreply\.(github|gitlab)\.com|(noreply|support|web-flow)@github\.com|noreply@(anthropic|openai)\.com|[^@[:space:]]+@([a-z0-9-]+\.)*example\.(com|net|org)|[^@[:space:]]+@([a-z0-9-]+\.)*(example|invalid|test|localhost))$'
not_address='@(v?[0-9]+\.[0-9]|[0-9]+x\.|[A-Za-z0-9_.-]+\.(service|socket|timer|target|mount|path|slice|scope|device|swap|automount)$)'
spaced=users-path-with-a-space
status=0

fail() {
  echo "privacy: $*" >&2
  status=1
}

real_homes() {
  grep -oE "$home( [[:alnum:]])?" | grep -viE "$web_url" |
    awk '/[Uu][Ss][Ee][Rr][Ss](\\|\/).* [[:alnum:]]$/ { print "users-path-with-a-space"; next } { sub(/ [[:alnum:]]$/, ""); print }' |
    grep -viE "$system_homes" | sed -E 's#.*[/\\]##; s#[.]+$##' | grep -vixE "$synthetic_homes" || true
}

check_signature() {
  local armored block found
  armored="$(sed -n -E '/-----BEGIN (SIGNED MESSAGE|PKCS7|PGP SIGNATURE)-----/,/-----END (SIGNED MESSAGE|PKCS7|PGP SIGNATURE)-----/p' <<<"$2")"
  check_addresses "$1" "$(grep ':' <<<"$armored" || true)"
  block="$(grep -v -e '^-----' -e '^=' -e ':' <<<"$armored" | tr -d ' ' || true)"
  [[ -n "$block" ]] || return 0
  if ! base64 --decode <<<"$block" >/dev/null 2>&1; then
    fail "$1: the signature cannot be read"
    return 0
  fi
  found="$(base64 --decode <<<"$block" | LC_ALL=C tr -c '[:print:]' '\n' | grep -oE "$email" || true)"
  while read -r address; do
    [[ -z "$address" ]] || check_address "$1" "$address"
  done < <(sort -u <<<"$found")
}

grep_tree() {
  local rc=0 flags=(--no-color --no-recurse-submodules -a -h -o -E)
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
  found="$(grep_tree "$1" "$home( [[:alnum:]])?" | real_homes)"
  if grep -qx "$spaced" <<<"$found"; then
    fail "$2: a file holds a Users path that a space and a word follow; list them with $list"
  elif [[ -n "$found" ]]; then
    fail "$2: a file holds a home folder path; list them with $list"
  fi
  found="$(grep_tree "$1" "$personal_mail" any-case)"
  [[ -z "$found" ]] || fail "$2: a file holds a personal email address; list them with $mail"
  check_utf16 "$1" "$2"
}

check_utf16() {
  local rc=0 path text bom prefix=":" listing where="$1"
  [[ "$1" == index ]] && where=--cached
  [[ "$1" == index ]] || prefix="$1:"
  listing="$(mktemp)"
  if [[ "$1" == index ]]; then
    LC_ALL=C git grep --no-color --no-recurse-submodules --cached -z -l -a -G -e $'^\xff\xfe' -e $'^\xfe\xff' > "$listing" || rc=$?
  else
    LC_ALL=C git grep --no-color --no-recurse-submodules -z -l -a -G -e $'^\xff\xfe' -e $'^\xfe\xff' "$1" > "$listing" || rc=$?
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
      fail "$2: a UTF-16 file cannot be read; list them with git grep -l -a -e \$'^\\xff\\xfe' -e \$'^\\xfe\\xff' $where"
      continue
    fi
    if [[ -n "$(real_homes <<<"$text")" || -n "$(grep -oiE "$personal_mail" <<<"$text" || true)" ]]; then
      fail "$2: a UTF-16 file holds a home folder path or a personal email address; list them with git grep -l -a -e \$'^\\xff\\xfe' -e \$'^\\xfe\\xff' $where"
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
  address="$(LC_ALL=C sed -E 's/^[^ -~]+//; s/[^ -~]+$//' <<<"$2" | tr '[:upper:]' '[:lower:]')"
  [[ "$address" =~ $public_address ]] || fail "$1: use a GitHub noreply address"
}

check_addresses() {
  local name="$1" text addresses found
  text="$(sed -E -e "s#$ssh_remote##g" -e "s#$url_user##g" <<<"$2" | LC_ALL=C sed -E -e "s/$separators/ /g" -e "s/$dots/./g")"
  addresses="$(grep -oE "$email" <<<"$text" | grep -viE "$not_address" || true)"
  addresses+=$'\n'"$(grep -E '^[A-Za-z-]*-[Bb][Yy]:' <<<"$text" | grep -oE '<[^<>]*@[^<>]*>' | tr -d '<>' || true)"
  while read -r found; do
    [[ -z "$found" ]] || check_address "$name" "$found"
  done < <(sort -u <<<"$addresses")
  return 0
}

check_names() {
  local found
  found="$(awk '{print "/" $0}' <<<"$1" | real_homes)"
  [[ -z "$found" ]] || fail "$2: a path name holds a home folder path"
  found="$(grep -oiE "$personal_mail" <<<"$1" || true)"
  [[ -z "$found" ]] || fail "$2: a path name holds a personal email address"
  check_addresses "$2: a path name holds text that looks like an address, so rename the file or" "$1"
}

check_text() {
  local homes
  homes="$(real_homes <<<"$2")"
  if grep -qx "$spaced" <<<"$homes"; then
    fail "$1: remove the Users path that a space and a word follow"
  elif [[ -n "$homes" ]]; then
    fail "$1: remove the home folder path"
  fi
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
  check_signature "commit $short signature" "$(git cat-file commit "$commit" | awk '/^$/ { exit } /^gpgsig(-sha256)? / { sig = 1; sub(/^gpgsig(-sha256)? /, ""); print; next } /^ / { if (sig) { sub(/^ /, ""); print }; next } { sig = 0 }')"
  mergetag="$(git cat-file commit "$commit" | awk '/^$/ { exit } /^mergetag / { tag = 1; sub(/^mergetag /, ""); print; next } /^ / { if (tag) { sub(/^ /, ""); print }; next } { tag = 0 }')"
  if [[ -n "$mergetag" ]]; then
    while IFS= read -r tagger; do
      check_address "commit $short merged tag tagger" "$tagger"
    done < <(sed -n 's/^tagger .*<\(.*\)> .*/\1/p' <<<"$mergetag")
    check_text "commit $short merged tag" "$mergetag"
    check_signature "commit $short merged tag signature" "$mergetag"
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
    check_signature "tag ${2:0:12} signature" "$tag"
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
