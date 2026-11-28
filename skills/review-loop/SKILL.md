---
name: review-loop
description: Use when the user says "review loop" or "sol loop".
---

# review-loop

This is a workflow for making your code changes more correct before (or
sometimes after) filing a pull request. tl;dr - use the reviewer of the seats file to review
your code in a loop.

Make the most minimal possible changes to appease the reviewers. Be careful
of scope creep and don't be scared to push back.

## Budget

- Default: 3 rounds total. Round 1 is full. Later rounds check only
  changed code and open findings.
- Extend to 5 only for security, permissions, auth, data loss, or
  state/concurrency, while a blocker or should stays open with evidence. Or when
  the user asks.
- Stop early if a round returns only nits. Declined nits and comment,
  doc, or format-only fixes need no new round.
- One reviewer only. The reviewer must not start subagents or reviewers.
- Keep a ledger: id, severity, outcome, usage if returned. Never guess it.

## 1. Scope

Run `git status --short`. Do not stash, discard, or include unrelated
changes. Limit review to the change paths if they separate cleanly.
Otherwise stop and ask.

Find the base after `git fetch origin`:

- PR: `gh pr view <n> --json baseRefName,headRefOid`. On another forge, use
  its CLI or API for the same step. Find the forge from the PR URL, the remote
  URL, the CI files and the signed-in CLIs. Check out the branch
  only if clean. Confirm `HEAD` is the PR head, or ahead only by this
  change. Base: `git merge-base HEAD origin/<baseRefName>`.
- Local: `git merge-base HEAD origin/<default-branch>`. No remote: a base
  the user names, or `HEAD` for uncommitted changes only.

The change is base to working tree in those paths, with untracked files.
Use one diff command all rounds. State intent and out-of-scope in 1-2
sentences. Run covering checks. Do not send code this change breaks. Note
missing or pre-failing checks in the brief.

## 2. Start the reviewer

Pick the reviewer from the seats file. `seat.mjs` is in the `council` skill
folder next to this skill folder. Run it as
`node <council skill folder>/scripts/seat.mjs resolve reviewer ...`.

- If the user names the reviewer by provider, model, and effort, use it. Do
  not run `seat.mjs`.
- If the user gives an exact model ID, use that ID. If the user also gives a
  seat name of the seats file, take the other fields from that entry.
- If the user gives only a seat name of the seats file, run
  `seat.mjs resolve reviewer --names <name>`.
- If the user names only a Sol version, such as "Sol 6.1", run
  `seat.mjs resolve reviewer --names sol`. Put the version in place of `*` in
  its `track`, and start only that ID. For another one-run change, name the
  reviewer by provider, model, and effort.
- If the user gives neither a seat name nor a model ID, report it and start no
  model. Do not guess an ID. An ID that the model list of the route gives for
  that name is not a guess.
- Else run `seat.mjs resolve reviewer --author-family <family>`. Your family is
  `claude` for a Claude model, `gpt` for a GPT model and `muse` for a Muse
  model. On a model of another family, leave out `--author-family`. Take the
  first member that a route can start. If no route runs the provider of a
  member, take the next member and report the skip.

When the route lists its models, add one `--available <provider>=<id>,<id>...`
for each provider. Use the `provider` value of the seats file, such as `claude`
for the T3 provider `claudeAgent`. A seat with `track` then takes the newest
listed ID of its line, with `source: track`. Without a list or a match, it keeps
its `model`, with `source: model`. In T3, use the IDs of the one
`orchestrator_capabilities` call that the host lets you make before the first
`delegate_task`. The T3 list is short. When it leaves out the newest model, the
seat takes the newest listed model. For one exact reviewer, give its ID as
`search` in that call. In Codex, the native subagent route and `codex exec`
take the `slug` of each model with `visibility` `list`:

```sh
codex debug models | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).models.filter(m=>m.visibility==="list").map(m=>m.slug).join(",")))'
```

Start a pinned ID, a named ID or an ID with `source: model` with no list check.
If a named member, a named version or its start fails, report it and stop. Do
not take the next member. If `seat.mjs` exits with an error, or if `node` does
not run, report the message. Do not guess the reviewer. If the reviewer has
your family, start it in a fresh context.

In T3, call `orchestrator_capabilities`. Pick the reviewer as above unless the user
named one. Do not hardcode an ID. Use the `effort` of the seat unless the user names
another effort. Record provider, model, and effort
only if exposed. Use `delegate_task` every round (`role: "review"`,
`mode: "async"`). Save `taskId`. New `clientRequestId` per round.
`childThreadId` is storage, not the next target. Do not use
`t3_thread_send`, `create_threads`, or `t3_thread_launch` for review.

In T3 Code, if its tools are not listed, try one direct capability call. Outside T3, use
a native subagent that can select the exact ID and keep its ID. In Claude Code, use a custom subagent
only if it is set up to run that ID. Otherwise, start each round as a background
command with the brief on stdin, such as `claude -p --model <ID> ...` from the `council` skill or
`codex exec --sandbox read-only --model <ID> -c model_reasoning_effort=<effort> -`.
Without that CLI, use another CLI from the `council` skill that runs the ID.
If no route runs any member, report the blocker. Do not substitute a model.

Do not edit scoped files while review runs. Wait for the notice. Do not
poll or start a second reviewer. Timeout, error, or no reply is not
approval. On failure, cancel, verify stop, restart with the ledger.

Round 1 brief (T3 children and CLI reviewers get no history):

```
Review only. Do not edit, commit, push, comment on PRs, or start subagents.
Repo: <abs path> Base: <sha> Intent: <intent> Out of scope: <scope> Checks: <results>
See: git diff <base> [-- <paths>]; git status --short (read untracked).
Read surrounding code. Find bugs, broken callers, mismatch with intent.
Skip style unless it hides a bug. Hold to the smallest change. Flag code,
tests, or guards the intent does not need. Other paths, rare cases, small
perf, extra compat: nits.
blocker = intended case wrong. should = real bug callers will hit, in intent. nit = rest.
Reply:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion> (stable ids)
```

## 3. Answer findings

Check each finding and severity yourself. Another path, rare case, or
small cost is a nit, whatever label it came with.

- Agree: smallest fix. Prefer delete or narrow over new lock, cache,
  helper, or option. Fix the case that happened. Add one focused test
  that fails without the fix, if intent needs it.
- Disagree: say why, with evidence (file:line, test, output).
- Out of scope or nit: decline in one line. List as follow-up.

Update the ledger. Re-run checks and `git diff --shortstat <base>`. If
review grew the diff, cut first. Do not agree just to end the loop.

## 4. Next round

Start one only if budget remains and a blocker or should is open, behavior code
changed, or approval does not cover the current behavior diff. Use a fresh
`delegate_task` in T3 or a fresh CLI round, or follow up the saved native ID. Send the round 1 brief,
the ledger (`fixed:` / `disagree:` / `declined:` + evidence), the same base
diff, and the change since last round. Tell the reviewer: open ids and changed code only.
Mark each old id `resolved` or `still open: <reason>`.

## 5. Stop and ship

Agreed: APPROVE on the current behavior diff, no blocker or should open,
no concern of your own. Stuck: an item stays disputed after two replies,
or budget ends. Show both sides in 2-3 lines each. The user decides.
Budget end is not approval.

Do not push during the loop. Push after agreement only if the user asked
to push, ship, or update the PR. If you push to a PR, add above the model
blurb:

`Reviewed with review-loop: <N> rounds with <model>. Verdict: approved`.

Add `on <effort>` only if verified. Skip this line when
`git config --get sentinel.attribution` prints `off`.

Report: rounds, model ID and `source`, if the reviewer has your family, what the reviewer changed, diff size before/after, fixed and
declined findings with reasons, usage if exposed (else say not), pushed or not.
Put your own findings in the same ledger. For each finding that you did not
fix, yours or the reviewer's, give the reason in one line.
