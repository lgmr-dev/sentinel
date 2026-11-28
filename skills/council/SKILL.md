---
name: council
description: Trigger this if the user says 'council' or 'arena'.
---

# Council

Before an audit, address outstanding PR comments, fix known issues, and run
relevant checks. Give council the updated implementation; do not defer known
fixes until reviews return. If the user wants to discard the implementation
and explore new ideas, skip fixes to code being replaced.

Bring in delegates to help with the user's request, usually for review or
feedback. By default, take the members of the `council` role of the seats
file, one seat each:

```sh
node <this skill folder>/scripts/seat.mjs resolve council
```

It prints a JSON list in order. Each seat has `name`, `provider`, `model`,
`effort` and `source`, and `track` and `family` when the entry has them.
`seats.json` in this folder holds the defaults. The user file
`$XDG_CONFIG_HOME/sentinel/seats.json`, or `~/.config/sentinel/seats.json`,
changes them. If `seat.mjs` exits with an error, or if `node` does not run,
report the message. Do not guess the seats. Start a delegate for each seat,
also for the model that you run on.

If the user names members, use only those, one seat each:

- When the user gives an exact model ID, use that ID. When the user also gives
  a seat name of the seats file, take the other fields from that entry.
- When the user gives only a seat name of the seats file, such as "Fable" for
  `fable`, take the entry from `seat.mjs resolve council --names <name>,<name>`.
- When the user gives neither, report that seat and start no model for it. Do
  not guess an ID. An ID that the model list of the route gives for that name
  is not a guess.

If the user asks for more seats than members, fill the extra seats
with copies, in the order of the user's list. If the user asks for fewer seats
and names no members, use the first seats that `seat.mjs` prints. Use only
these members. Report a member that you cannot reach, and a seat that started
and did not reply. Do not replace that seat. If you can reach only one model
family, report it. Do not substitute a model.

When the route lists its models, give them to `seat.mjs` with one
`--available <provider>=<id>,<id>...` for each provider. Use the `provider`
value of the seats file, such as `claude` for the T3 provider `claudeAgent`.
A seat with `track` then takes the newest listed ID that matches its `track`,
and its `source` is `track`. Without a list or a match, it keeps its `model`,
and its `source` is `model`.

- In T3 Code, use the IDs of the one `orchestrator_capabilities` call that the
  host lets you make before the first `delegate_task`. The T3 list is short.
  When it leaves out the newest model, the seat takes the newest listed model.
- In Codex, the native subagent route and `codex exec` take the `slug` of each
  model with `visibility` `list`. This command prints them as a comma list:

  ```sh
  codex debug models | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).models.filter(m=>m.visibility==="list").map(m=>m.slug).join(",")))'
  ```

Start each pinned ID, each ID that the user named and each ID with
`source: model` with no list check. When the start fails, report the seat and
start no other model in its place. Report the ID and the `source` of each seat.

In T3 Code, use `orchestrator_capabilities` to resolve the models, then
`delegate_task` to start one delegate per seat in parallel. Elsewhere, use
the harness's subagent tools when they can select the exact ID. A Claude Code
subagent takes only an alias, so give the ID of a Claude seat to
`claude -p --model`. Otherwise start each delegate as a background command
with a CLI that runs the model. Set the `<effort>` of each seat to its
`effort`. An effort that the user names for all seats replaces the effort of
each seat. An effort that the user names for one seat replaces only the effort
of that seat:

| CLI | Read-only command |
| --- | --- |
| Claude Code | `claude -p --model <id> --effort <effort> --permission-mode plan` (brief on stdin) |
| Codex | `codex exec --sandbox read-only --model <id> -c model_reasoning_effort=<effort> -` (brief on stdin) |
| Copilot CLI | `copilot -p "<brief>" -s --model <id> --effort=<effort> --allow-tool 'read,shell(git diff:*),shell(git status:*),shell(git log:*),shell(git show:*)'` |
| OpenCode | `opencode run --agent plan --model <provider>/<id> --variant <effort> "<brief>"` |
| Kiro CLI | `kiro-cli chat --no-interactive --agent <name> --effort <effort> "<brief>"`, with the model in the agent file |
| Muse | `muse exec --model <id> --effort <effort> --disable-write --disable-shell --approval-mode never "<brief>"`, with the diff in the brief |

Copilot CLI and OpenCode can run models from several model families. Before
you decide that a family is out of reach, check which of these CLIs are on the
`PATH`.

Give each delegate the request and relevant context. For review or feedback,
keep their work read-only. Collect their responses and summarize the useful
findings, disagreements, and recommended next steps.

Do not wait idle. When a result arrives, check its findings against the code
at once and decide what to fix while the other delegates run. Do not edit
files while a delegate still reviews the same checkout. If the user's
instructions mark a delegate as non-blocking, do not wait for it; treat a
late result as feedback and do not record its score.

For a code review, ask each delegate for a score out of 10.
Count each full review pass as one round.
A fresh review after fixes starts a new round.

If the work ends in a pull request that the task lets you change, put the
results in the PR description.
Put this section before the model and harness line at the end:

```markdown
## Council review

Rounds: 2

| Delegate | Round 1 | Round 2 |
| --- | --- | --- |
| <model of seat 1> | 7/10 | 9/10 |
| <model of seat 2> | 8/10 | 10/10 |
| <model of seat 3> | 6/10 | 9/10 |
```

If a delegate gives no score, write `no score`. Do not invent one.
If the PR is open, edit the description. Do not post a comment for this.
If there is no such PR, put the same results in the final reply only.
When `git config --get sentinel.attribution` prints `off`, do not put this
section in the PR. Put the results in the final reply only.

If you agree with their recommendations, make the changes and request a fresh
review after. Continue this process until all delegates are satisfied with the
outcome, for at most 3 rounds. The user can set another limit in the request or
in their instructions. When the limit ends, report the open findings and let
the user decide.

Do not let repeated reviews result in scope creep. It is your job to fight to
keep scope limited.

## Design mode

Use this mode when the user asks the council to design, plan or choose an
approach, or says "arena".

1. Write the task and 3 to 6 criteria that a good plan meets. Give each
   delegate the task, not the criteria.
2. Each delegate writes its own plan, read-only. Delegates do not see the
   other plans.
3. Take one judge from the seats of the run, after the members and the seat
   count of the request apply. The judge is a seat with a `family` other than
   yours: `claude` for a Claude model, `gpt` for a GPT model and `muse` for a
   Muse model. A seat with no `family` is not of another family. Give the
   judge the criteria and the plans, with labels such as "Plan A" and no model
   names. It scores each plan against each criterion. If no seat has another
   family, do not start a judge, and say so.
4. Read each plan in full and score it yourself. If you and the judge pick
   different plans, read both reasons before you decide.
5. Take the best plan as the base. Add the strong parts of the other plans to
   it, and give the source of each part.
6. Show the criteria, the scores, the plan that you took as the base, the
   merged plan with the source of each part, and the parts that you rejected.
   Build it only when the user asks.
