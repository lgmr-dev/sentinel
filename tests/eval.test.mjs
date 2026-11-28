import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tools/eval.mjs', import.meta.url));
const evalTool = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('--resume needs --no-early-stop', () => {
  const r = evalTool('--ab', '--targets', 'none', '--resume', 'old');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--resume needs --no-early-stop/);
});

test('--resume refuses a folder with two finished rows of one run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-'));
  const row = JSON.stringify({ case: 'c', target: 't', arm: 'with', index: 1, status: 'pass' });
  await fs.writeFile(path.join(dir, 'runs.jsonl'), `${row}\n${row.replace('pass', 'fail')}\n`);
  const r = evalTool('--ab', '--targets', 'none', '--no-early-stop', '--resume', dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--resume: c t with 1 has two rows/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('--resume copies a row only when its saved seats match the merged seats of the new run', { skip: process.platform === 'win32' }, async () => {
  const { dir, env } = await fakeLogins({ claude: `cat >/dev/null\n${chair('result=done')}` });
  const defaults = JSON.parse(await fs.readFile(new URL('../skills/council/seats.json', import.meta.url), 'utf8'));
  const reversed = value => Array.isArray(value) || typeof value !== 'object' ? value : Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
  const otherOrder = { ...defaults, roles: { ...defaults.roles, reviewer: [...defaults.roles.reviewer].reverse() } };
  const rows = [[reversed(defaults), false], [otherOrder, false], [undefined, false], [defaults, true]].map(([seats, written], i) =>
    JSON.stringify({ case: 'neg-council-review', target: 'opus-5.5-xhigh', arm: 'with', index: i + 1, status: 'pass', pass: true, seconds: 4242, seats, seats_written: written }));
  await fs.writeFile(path.join(dir, 'runs.jsonl'), `${rows.join('\n')}\n`);
  const r = spawnSync(process.execPath, [script, '--case', 'neg-council-review', '--targets', 'opus-5.5-xhigh', '--runs', '4', '--no-early-stop', '--judges', 'codex', '--resume', dir], { encoding: 'utf8', env });
  const results = resultsOf(r);
  const copied = (await fs.readFile(path.join(results, 'runs.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.seconds === 4242).map(row => row.index);
  for (const folder of [results, dir]) await fs.rm(folder, { recursive: true, force: true });
  assert.deepEqual(copied, [1]);
});

test('the trust tool runs its CLI through a symlink', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trust-'));
  await fs.symlink(fileURLToPath(new URL('../tools/trust.mjs', import.meta.url)), path.join(dir, 'trust-link.mjs'));
  const r = spawnSync(process.execPath, [path.join(dir, 'trust-link.mjs')], { encoding: 'utf8' });
  await fs.rm(dir, { recursive: true, force: true });
  assert.deepEqual([r.status, r.stderr], [2, 'usage: node tools/trust.mjs <results dir>...\n']);
});

async function evalCheck(name, check, { launches = [], wait = false, sessions = [], trace: chairEvents = [], host = 'codex', seats, seatsHome = true, hostSeats }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-'));
  const work = path.join(dir, 'work'), home = path.join(dir, 'home'), sessionDir = path.join(home, '.codex', 'sessions');
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(dir, 'remote-refs.txt'), '');
  await fs.writeFile(path.join(dir, 'refs.txt'), '');
  await fs.writeFile(path.join(dir, 'gh-state.json'), JSON.stringify({ prs: [{ number: 7 }] }));
  await fs.writeFile(path.join(dir, 'launches.jsonl'), launches.map(launch => `${JSON.stringify(launch)}\n`).join(''));
  const runSeats = seats ?? JSON.parse(await fs.readFile(new URL(`../evals/${name}/eval.json`, import.meta.url), 'utf8')).seats;
  const env = { ...process.env, EVAL_WORK: work, EVAL_TMP: dir, EVAL_HOME: home, EVAL_TRACE: path.join(dir, 'trace.jsonl'), EVAL_HOST: host,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.EVAL_SEATS_HOME;
  if (seatsHome) {
    env.EVAL_SEATS_HOME = path.join(dir, 'seats');
    await fs.mkdir(path.join(env.EVAL_SEATS_HOME, 'sentinel'), { recursive: true });
    if (runSeats) await fs.writeFile(path.join(env.EVAL_SEATS_HOME, 'sentinel', 'seats.json'), JSON.stringify(runSeats));
  }
  if (hostSeats) {
    await fs.mkdir(path.join(env.XDG_CONFIG_HOME, 'sentinel'), { recursive: true });
    await fs.writeFile(path.join(env.XDG_CONFIG_HOME, 'sentinel', 'seats.json'), JSON.stringify(hostSeats));
  }
  spawnSync('git', ['init', '-q'], { cwd: work });
  const trace = [{ type: 'thread.started', thread_id: 'chair' },
    ...(wait ? [{ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'wait' } }] : []), ...chairEvents];
  await fs.writeFile(path.join(dir, 'trace.jsonl'), trace.map(e => JSON.stringify(e)).join('\n'));
  for (const [i, { id = `session-${i}`, parent, phase, model = 'gpt-6.2-sol' }] of sessions.entries()) await fs.writeFile(path.join(sessionDir, `session-${i}.jsonl`), [
    { type: 'session_meta', payload: { id, source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'exec' } },
    { type: 'turn_context', payload: { model } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase } },
  ].map(e => JSON.stringify(e)).join('\n'));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(`../evals/${name}/check.mjs`, import.meta.url))], { encoding: 'utf8', env });
  await fs.rm(dir, { recursive: true, force: true });
  return JSON.parse(r.stdout).checks.find(c => c.name === check);
}

const fable = { cli: 'claude', args: ['-p', '--model', 'claude-fable-5-2', '--effort', 'medium'], code: 0, bytes: 900 };
const opus = { cli: 'claude', args: ['-p', '--model', 'claude-opus-5-5', '--effort', 'high'], code: 0, bytes: 900 };
const solExec = (code = 0, id = 'gpt-6.2-sol') => ({ cli: 'codex', args: ['exec', '--model', id, '-'], code, bytes: code ? 0 : 900 });
const solSeat = { parent: 'chair', phase: 'final_answer' };
const solReply = { phase: 'final_answer' };

test('the council check counts a Claude seat and a Sol seat that ran the seat model and replied', async () => {
  const seats = async options => (await evalCheck('council-design', 'asks each seat', options)).pass;
  const judge = async options => (await evalCheck('council-design', 'asks a judge from another family', options)).pass;
  assert.equal(await judge({ launches: [fable, fable], sessions: [solSeat] }), true);
  assert.equal(await judge({ launches: [fable], sessions: [solSeat, solSeat] }), false);
  assert.equal(await seats({ launches: [fable, fable], sessions: [solSeat] }), true);
  assert.equal(await seats({ launches: [fable, fable, solExec()] }), true);
  assert.equal(await seats({ launches: [{ ...fable, code: 1 }, { ...fable, code: 1 }], sessions: [solSeat] }), false);
  assert.equal(await seats({ launches: [{ ...fable, bytes: 0 }], sessions: [solSeat] }), false);
  assert.equal(await seats({ launches: [{ ...fable, args: ['-p', '--model', 'claude-opus-5-5'] }], sessions: [solSeat] }), false);
  assert.equal(await seats({ launches: [{ ...fable, args: [...fable.args, '--help'] }], sessions: [solSeat] }), false);
  assert.equal(await seats({ launches: [{ ...fable, args: [...fable.args, '-v'] }], sessions: [solSeat] }), false);
  assert.equal(await seats({ launches: [fable, fable, solExec(1)] }), false);
  assert.equal(await seats({ launches: [fable, fable], sessions: [{ ...solSeat, model: 'gpt-6.2-astra' }] }), false);
  assert.equal(await seats({ launches: [fable, fable], sessions: [{ ...solSeat, phase: 'commentary' }] }), false);
  assert.equal(await seats({ launches: [fable, fable], wait: true }), false);
});

test('the council check counts a Claude Code subagent that ran the Fable model and replied', async () => {
  const seats = async options => (await evalCheck('council-design', 'asks each seat', { host: 'claude', sessions: [solSeat, solSeat], ...options })).pass;
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'seat', name: 'Agent', input: { model: 'fable' } }] } };
  const prompt = { type: 'user', message: { role: 'user', content: 'Review the plan' } };
  const text = texts => texts.map(t => ({ type: 'text', text: t }));
  const sync = (result = {}, event = {}) => [call, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'seat', content: text(['Findings']) }] },
    tool_use_result: { status: 'completed', resolvedModel: 'claude-fable-5-2', content: text(['Findings']), ...result }, ...event }];
  const async = (note = {}) => [call,
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'seat', content: 'launched' }] }, tool_use_result: { isAsync: true, status: 'async_launched', resolvedModel: 'claude-fable-5-2' } },
    { type: 'system', subtype: 'task_notification', tool_use_id: 'seat', status: 'completed', summary: 'Findings', summary_is_report: true, ...note },
    { type: 'assistant', message: { model: 'claude-opus-5-5', content: text(['Done']) } }];
  assert.equal((await evalCheck('council-design', 'asks a judge from another family', { host: 'claude', sessions: [solSeat, solSeat], trace: sync() })).pass, true);
  assert.equal(await seats({ trace: [prompt, ...sync()] }), true);
  assert.equal(await seats({ trace: sync({ content: text(['Harness note', 'Findings']), harnessNoteCount: 1 }) }), true);
  assert.equal(await seats({ trace: async() }), true);
  assert.equal(await seats({ trace: sync({ content: text(['']) }) }), false);
  assert.equal(await seats({ trace: sync({ content: text(['Harness note']), harnessNoteCount: 1 }) }), false);
  assert.equal(await seats({ trace: sync({ content: text(['Harness note']), harnessTailCount: 1 }) }), false);
  assert.equal(await seats({ trace: sync({ resolvedModel: 'claude-opus-5-5' }) }), false);
  assert.equal(await seats({ trace: sync({ modelsUsed: ['claude-fable-5-2', 'claude-opus-5-5'] }) }), false);
  assert.equal(await seats({ trace: sync({ resolvedModel: 'claude-opus-5-5', modelsUsed: ['claude-opus-5-5', 'claude-fable-5-2'] }) }), true);
  assert.equal(await seats({ trace: sync({}, { parent_tool_use_id: 'outer' }) }), false);
  const reply = model => ({ type: 'assistant', parent_tool_use_id: 'seat', message: { model, content: text(['Findings']) } });
  assert.equal(await seats({ trace: async().toSpliced(2, 0, reply('claude-fable-5-2')) }), true);
  assert.equal(await seats({ trace: async().toSpliced(2, 0, reply('claude-fable-5-2'), reply('claude-opus-5-5')) }), false);
  assert.equal(await seats({ trace: async().slice(0, 2) }), false);
  assert.equal(await seats({ trace: async({ summary: 'NOTE: this agent stopped at its 1-turn limit and had produced no report.', summary_is_report: undefined }) }), false);
  assert.equal(await seats({ trace: async({ tool_use_id: 'other' }) }), false);
  assert.equal(await seats({ trace: async({ status: 'failed' }) }), false);
});

test('the council check reads the seats of the run, not the host seats file of the sandbox', async () => {
  const council = async options => evalCheck('council-review-pr', 'starts the council', options);
  assert.equal((await council({ launches: [fable], sessions: [solSeat] })).pass, true);
  const noSol = await council({ launches: [fable], hostSeats: { roles: { council: ['fable'] } } });
  assert.equal(noSol.pass, false);
  assert.match(noSol.detail, /sol gpt-6.2-sol 0 replies/);
  assert.equal((await council({ launches: [fable], sessions: [solSeat], seatsHome: false })).pass, false);
  const muse = { cli: 'muse', args: ['exec', '--model', 'muse-wonder-full-1.0', 'Review'], code: 0, bytes: 900 };
  const withMuse = { roles: { council: ['fable', 'sol', 'muse'] } };
  assert.equal((await council({ launches: [fable, muse], sessions: [solSeat], seats: withMuse })).pass, true);
  assert.equal((await council({ launches: [fable, { ...muse, code: 1 }], sessions: [solSeat], seats: withMuse })).pass, false);
  assert.equal((await council({ launches: [fable], sessions: [solSeat], seats: withMuse })).pass, false);
});

test('the council check counts a codex exec launch, and no session with no parent', async () => {
  const council = async options => evalCheck('council-review-pr', 'starts the council', options);
  assert.equal((await council({ launches: [fable], sessions: [solReply] })).pass, false);
  assert.equal((await council({ launches: [fable, solExec(1)], sessions: [solReply] })).pass, false);
  const newer = await council({ launches: [fable, solExec(0, 'gpt-6.3-sol')] });
  assert.deepEqual([newer.pass, newer.detail], [true, 'fable claude-fable-5-2 1 launch, sol gpt-6.3-sol 1 launch']);
  assert.equal((await council({ launches: [fable, solExec(0)], sessions: [{ ...solReply, model: 'gpt-6.1-sol' }] })).pass, true);
  assert.equal((await council({ launches: [fable, solExec(1)], sessions: [{ ...solReply, model: 'gpt-6.1-sol' }] })).pass, false);
});

test('the review-loop check needs a reply from the first reviewer for the family of the chair', async () => {
  const reviewer = async options => evalCheck('review-loop-pagination', 'the first reviewer replied', { host: 'claude', ...options });
  assert.equal((await reviewer({ sessions: [solReply] })).pass, true);
  assert.equal((await reviewer({ sessions: [solSeat] })).pass, true);
  assert.equal((await reviewer({ sessions: [{ parent: 'other', phase: 'final_answer' }] })).pass, false);
  assert.equal((await reviewer({ host: 'codex', launches: [opus] })).pass, true);
  assert.equal((await reviewer({ host: 'codex', sessions: [solReply] })).pass, false);
  const newer = await reviewer({ sessions: [{ ...solReply, model: 'gpt-6.3-sol' }] });
  assert.deepEqual([newer.pass, newer.detail], [true, 'sol gpt-6.3-sol 1 session, opus claude-opus-5-5 0 replies']);
  const older = await reviewer({ sessions: [{ ...solReply, model: 'gpt-6.1-sol' }] });
  assert.deepEqual([older.pass, older.detail], [true, 'sol gpt-6.1-sol 1 session, opus claude-opus-5-5 0 replies']);
  const twoTracks = { models: { sol6: { provider: 'codex', model: 'gpt-6.3-sol', track: 'gpt-6.*-sol', family: 'gpt', effort: 'high' } }, roles: { reviewer: ['sol', 'sol6'] } };
  const shared = await reviewer({ seats: twoTracks, sessions: [{ ...solReply, model: 'gpt-6.4-sol' }] });
  assert.equal(shared.pass, false);
  assert.match(shared.detail, /gpt-6.4-sol matches more than one track/);
});

test('the review-loop check gives a codex exec launch credit only from a saved reply session', async () => {
  const reviewer = async options => evalCheck('review-loop-pagination', 'the first reviewer replied', { host: 'claude', ...options });
  assert.equal((await reviewer({ launches: [solExec(1, 'gpt-5-mini')], sessions: [solReply] })).pass, false);
  assert.equal((await reviewer({ launches: [solExec()] })).pass, false);
  assert.equal((await reviewer({ launches: [solExec()], sessions: [{ ...solReply, id: 'chair' }] })).pass, false);
  const mixed = await reviewer({ launches: [solExec(1), solExec()], sessions: [solReply] });
  assert.equal(mixed.pass, false);
  assert.match(mixed.detail, /sol gpt-6.2-sol 0 replies ambiguous/);
  assert.equal((await reviewer({ launches: [solExec(0)], sessions: [{ ...solReply, model: 'gpt-6.1-sol' }] })).pass, true);
  assert.equal((await reviewer({ launches: [solExec(1)], sessions: [{ ...solReply, model: 'gpt-6.1-sol' }] })).pass, false);
});

async function fakeLogins(fakes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'logins-'));
  const bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  await fs.mkdir(bin);
  await fs.mkdir(path.join(home, '.config', 'muse'), { recursive: true });
  await fs.mkdir(path.join(home, '.codex'));
  await fs.writeFile(path.join(home, '.config', 'muse', 'auth.json'), JSON.stringify({ providers: { meta: { api_key: museKey } } }));
  const jwt = `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 86400 })).toString('base64url')}.x`;
  await fs.writeFile(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: jwt } }));
  for (const [name, body] of Object.entries({ codex: 'cat >/dev/null\nexit 1', ...fakes })) await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-0123456789abcdef', META_API_KEY: museKey };
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']) delete env[key];
  return { dir, env };
}

const resultsOf = r => path.resolve(fileURLToPath(new URL('..', import.meta.url)), r.stdout.match(/Results: (\S+)/)[1]);

async function fakeRun(fakes, name = 'neg-council-review', ...args) {
  const { dir, env } = await fakeLogins(fakes);
  const r = spawnSync(process.execPath, [script, '--case', name, '--targets', 'opus-5.5-xhigh', '--runs', '1', '--judges', 'codex', ...args], { encoding: 'utf8', env });
  const results = resultsOf(r);
  const run = path.join(results, name, 'opus-5.5-xhigh', 'with-1');
  const archive = path.join(run, 'sandbox.tgz');
  const again = resultsOf(spawnSync(process.execPath, [script, '--rejudge', results], { encoding: 'utf8', env }));
  const out = {
    final: await fs.readFile(path.join(run, 'final.md'), 'utf8'),
    saved: spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout,
    launches: spawnSync('tar', ['-xzOf', archive, 'launches.jsonl'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)),
    checks: JSON.parse(await fs.readFile(path.join(run, 'result.json'), 'utf8')).checks,
    rejudged: JSON.parse((await fs.readFile(path.join(again, 'runs.jsonl'), 'utf8')).split('\n')[0]).checks,
  };
  for (const folder of [results, again, dir]) await fs.rm(folder, { recursive: true, force: true });
  return out;
}

const museKey = 'muse-key-0123456789abcdefghij';
const chair = body => `${body}
echo '{"type":"system","subtype":"init","model":"fake","cwd":"'"$PWD"'","session_id":"s"}'
echo '{"type":"result","result":"'"$result"'"}'`;

test('a run gives nested Claude and Muse calls their logins, and saves no Muse key', { skip: process.platform === 'win32' }, async () => {
  const { final, saved } = await fakeRun({
    claude: chair(`cp "$XDG_CONFIG_HOME/muse/auth.json" muse.json
seats=no; [ -e "$XDG_CONFIG_HOME/sentinel/seats.json" ] && seats=yes
result="claude=$(env -u CLAUDE_CODE_OAUTH_TOKEN claude-login) muse=$(grep -c ${museKey} muse.json) meta=\${META_API_KEY:+leaked} seats=$seats"`),
    'claude-login': 'grep -c user:inference "$CLAUDE_CONFIG_DIR/.credentials.json"',
  });
  assert.equal(final, 'claude=1 muse=1 meta= seats=no');
  assert.match(saved, /work\//);
  assert.doesNotMatch(saved, /muse\.json/);
});

test('a run grades the seats of the case, not the host seats file that the chair changed, also in a rejudge', { skip: process.platform === 'win32' }, async () => {
  const { checks, rejudged } = await fakeRun({
    claude: chair(`cat >/dev/null
case " $* " in *" claude-fable-5-2 "*) echo "Score: 8/10"; exit 0 ;; esac
grep -q '"sol"' "$XDG_CONFIG_HOME/sentinel/seats.json" && echo brief | claude -p --model claude-fable-5-2 >/dev/null
echo '{"roles":{"council":["fable"]}}' > "$XDG_CONFIG_HOME/sentinel/seats.json"
result=done`),
  }, 'council-review-pr');
  const live = checks.find(c => c.name === 'starts the council');
  assert.deepEqual([live.pass, live.detail], [false, 'fable claude-fable-5-2 1 launch, sol gpt-6.2-sol 0 replies']);
  assert.deepEqual(rejudged.find(c => c.name === 'starts the council'), live);
});

test('a run logs the exit code and the output size of each nested claude, codex and muse launch, but not of the chair', { skip: process.platform === 'win32' }, async () => {
  const { final, launches } = await fakeRun({
    claude: chair(`if [ "$1" = --version ]; then echo 9.9; exit 0; fi
claude --version >/dev/null
echo brief | codex exec --model gpt-6.2-astra - >/dev/null 2>&1
muse exec --model muse-wonder-full-1.0 Review | head -c 1 >/dev/null
result="seats ran"`),
    codex: 'cat >/dev/null\necho "codex failed" >&2\nexit 2',
    muse: 'echo "Score: 8/10"',
  });
  assert.equal(final, 'seats ran');
  assert.deepEqual(launches, [
    { cli: 'claude', args: ['--version'], code: 0, bytes: 4 },
    { cli: 'codex', args: ['exec', '--model', 'gpt-6.2-astra', '-'], code: 2, bytes: 0 },
    { cli: 'muse', args: ['exec', '--model', 'muse-wonder-full-1.0', 'Review'], code: 0, bytes: 12 },
  ]);
});

test('a launch that the chair stops also stops the real CLI', { skip: process.platform === 'win32' }, async () => {
  const { final } = await fakeRun({
    claude: chair(`muse exec --model muse-wonder-full-1.0 Review &
while [ ! -f ready ]; do sleep 0.1; done
kill -TERM $!
wait $!
result="$(cat stopped 2>/dev/null || echo running)"`),
    muse: 'trap \'echo stopped > stopped; exit 143\' TERM\ntouch ready\nsleep 3 &\nwait',
  });
  assert.equal(final, 'stopped');
});

test('a rejudge asks the current Codex judge in place of an old one, and grades the seats of --seats again', { skip: process.platform === 'win32' }, async () => {
  const { dir, env } = await fakeLogins({
    claude: `cat >/dev/null
case " $* " in
*" --json-schema "*) while [ $# -gt 0 ]; do [ "$1" = --model ] && echo "claude $2" >> "$JUDGE_LOG"; shift; done
  echo '{"is_error":false,"result":"","structured_output":{"pass":true,"reason":"ok"}}' ;;
*" claude-opus-9-1 "*) echo "Score: 9/10" ;;
*) ${chair(`grep -q claude-opus-9-1 "$XDG_CONFIG_HOME/sentinel/seats.json" && claude -p --model claude-opus-9-1 </dev/null >/dev/null
result=done`)} ;;
esac`,
    codex: `cat >/dev/null
while [ $# -gt 0 ]; do case "$1" in -m) echo "codex $2" >> "$JUDGE_LOG" ;; -o) answer="$2" ;; esac; shift; done
echo '{"pass":true,"reason":"ok"}' > "$answer"`,
  });
  env.JUDGE_LOG = path.join(dir, 'judges.log');
  const config = JSON.parse(await fs.readFile(new URL('../evals/targets.json', import.meta.url), 'utf8'));
  const codexJudge = config.judges.find(j => j.host === 'codex').model;
  const oldJudge = 'gpt-6.1-sol';
  const seats = path.join(dir, 'seats.json');
  await fs.writeFile(seats, JSON.stringify({ models: { opus: { model: 'claude-opus-9-1', family: 'claude' } }, roles: { council: ['opus'] } }));
  const first = resultsOf(spawnSync(process.execPath, [script, '--case', 'council-review-pr', '--targets', 'opus-5.5-xhigh', '--runs', '1', '--judges', 'claude,codex', '--seats', seats], { encoding: 'utf8', env }));
  const runs = path.join(first, 'runs.jsonl');
  await fs.writeFile(runs, (await fs.readFile(runs, 'utf8')).replaceAll(`"judge":"${codexJudge}"`, `"judge":"${oldJudge}"`));
  await fs.rm(env.JUDGE_LOG);
  const again = resultsOf(spawnSync(process.execPath, [script, '--rejudge', first], { encoding: 'utf8', env }));
  const asked = new Set((await fs.readFile(env.JUDGE_LOG, 'utf8')).trim().split('\n'));
  const council = async folder => JSON.parse(await fs.readFile(path.join(folder, 'runs.jsonl'), 'utf8')).checks.find(c => c.name === 'starts the council');
  const [before, after] = [await council(first), await council(again)];
  for (const folder of [first, again, dir]) await fs.rm(folder, { recursive: true, force: true });
  assert.deepEqual([...asked].sort(), [`claude ${config.judges.find(j => j.host === 'claude').model}`, `codex ${codexJudge}`]);
  assert.deepEqual([before.pass, before.detail], [true, 'opus claude-opus-9-1 1 launch']);
  assert.deepEqual(after, before);
});
