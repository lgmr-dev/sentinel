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

async function evalCheck(name, check, { launches = [], wait = false, sessions = [], muse = false, trace: chairEvents = [] }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-'));
  const work = path.join(dir, 'work'), home = path.join(dir, 'home'), sessionDir = path.join(home, '.codex', 'sessions');
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(dir, 'remote-refs.txt'), '');
  await fs.writeFile(path.join(dir, 'refs.txt'), '');
  await fs.writeFile(path.join(dir, 'gh-state.json'), JSON.stringify({ prs: [{ number: 7 }] }));
  await fs.writeFile(path.join(dir, 'launches.jsonl'), launches.map(launch => `${JSON.stringify(launch)}\n`).join(''));
  if (muse) await fs.writeFile(path.join(dir, 'muse-login'), '');
  spawnSync('git', ['init', '-q'], { cwd: work });
  const trace = [{ type: 'thread.started', thread_id: 'chair' },
    ...(wait ? [{ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'wait' } }] : []), ...chairEvents];
  await fs.writeFile(path.join(dir, 'trace.jsonl'), trace.map(e => JSON.stringify(e)).join('\n'));
  for (const [i, { parent, phase, model = 'gpt-6.2-sol' }] of sessions.entries()) await fs.writeFile(path.join(sessionDir, `session-${i}.jsonl`), [
    { type: 'session_meta', payload: { id: `session-${i}`, source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'exec' } },
    { type: 'turn_context', payload: { model } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase } },
  ].map(e => JSON.stringify(e)).join('\n'));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(`../evals/${name}/check.mjs`, import.meta.url))], { encoding: 'utf8',
    env: { ...process.env, EVAL_WORK: work, EVAL_TMP: dir, EVAL_HOME: home, EVAL_TRACE: path.join(dir, 'trace.jsonl'), EVAL_HOST: 'codex' } });
  await fs.rm(dir, { recursive: true, force: true });
  return JSON.parse(r.stdout).checks.find(c => c.name === check).pass;
}

const fable = { cli: 'claude', args: ['-p', '--model', 'claude-fable-5-2', '--effort', 'medium'], code: 0, bytes: 900 };
const astraSeat = { parent: 'chair', phase: 'final_answer', model: 'gpt-6.2-astra' };

test('the council check counts a Claude seat and an Astra seat that ran the default model and replied', async () => {
  const seats = options => evalCheck('council-design', 'asks at least two other models', options);
  assert.equal(await seats({ launches: [fable], sessions: [astraSeat] }), true);
  assert.equal(await seats({ launches: [fable, { cli: 'codex', args: ['exec', '--model', 'gpt-6.2-astra', '-'], code: 0, bytes: 900 }] }), true);
  assert.equal(await seats({ launches: [{ ...fable, code: 1 }], sessions: [astraSeat] }), false);
  assert.equal(await seats({ launches: [{ ...fable, bytes: 0 }], sessions: [astraSeat] }), false);
  assert.equal(await seats({ launches: [{ ...fable, args: ['-p', '--model', 'claude-opus-5-5'] }], sessions: [astraSeat] }), false);
  assert.equal(await seats({ launches: [{ ...fable, args: [...fable.args, '--help'] }], sessions: [astraSeat] }), false);
  assert.equal(await seats({ launches: [{ ...fable, args: [...fable.args, '-v'] }], sessions: [astraSeat] }), false);
  assert.equal(await seats({ launches: [fable, { cli: 'codex', args: ['exec', '--model', 'gpt-6.2-astra', '-'], code: 1, bytes: 0 }] }), false);
  assert.equal(await seats({ launches: [fable], sessions: [{ ...astraSeat, model: 'gpt-6-luna' }] }), false);
  assert.equal(await seats({ launches: [fable], sessions: [{ ...astraSeat, phase: 'commentary' }] }), false);
  assert.equal(await seats({ launches: [fable], wait: true }), false);
});

test('the council check counts a Claude Code subagent that ran the Fable model and replied', async () => {
  const seats = options => evalCheck('council-design', 'asks at least two other models', { sessions: [astraSeat], ...options });
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'seat', name: 'Agent', input: { model: 'fable' } }] } };
  const prompt = { type: 'user', message: { role: 'user', content: 'Review the plan' } };
  const text = texts => texts.map(t => ({ type: 'text', text: t }));
  const sync = (result = {}, event = {}) => [call, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'seat', content: text(['Findings']) }] },
    tool_use_result: { status: 'completed', resolvedModel: 'claude-fable-5-2', content: text(['Findings']), ...result }, ...event }];
  const async = (note = {}) => [call,
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'seat', content: 'launched' }] }, tool_use_result: { isAsync: true, status: 'async_launched', resolvedModel: 'claude-fable-5-2' } },
    { type: 'system', subtype: 'task_notification', tool_use_id: 'seat', status: 'completed', summary: 'Findings', ...note }];
  assert.equal(await seats({ trace: [prompt, ...sync()] }), true);
  assert.equal(await seats({ trace: sync({ content: text(['Harness note', 'Findings']), harnessNoteCount: 1 }) }), true);
  assert.equal(await seats({ trace: async() }), true);
  assert.equal(await seats({ trace: async({ handback: 'send' }) }), true);
  assert.equal(await seats({ trace: sync({ content: text(['']) }) }), false);
  assert.equal(await seats({ trace: sync({ content: text(['Harness note']), harnessNoteCount: 1 }) }), false);
  assert.equal(await seats({ trace: sync({ content: text(['Harness note']), harnessTailCount: 1 }) }), false);
  assert.equal(await seats({ trace: sync({ handback: 'withheld' }) }), false);
  assert.equal(await seats({ trace: sync({ resolvedModel: 'claude-opus-5-5' }) }), false);
  assert.equal(await seats({ trace: sync({}, { parent_tool_use_id: 'outer' }) }), false);
  assert.equal(await seats({ trace: async().slice(0, 2) }), false);
  assert.equal(await seats({ trace: async({ summary: '' }) }), false);
  assert.equal(await seats({ trace: async({ handback: 'withheld', summary: 'The report was withheld' }) }), false);
  assert.equal(await seats({ trace: async({ tool_use_id: 'other' }) }), false);
  assert.equal(await seats({ trace: async({ status: 'failed' }) }), false);
});

test('the council checks need a Muse seat that replied, when the sandbox has a Muse login', async () => {
  const muse = { cli: 'muse', args: ['exec', '--model', 'muse-wonder-full-1.0', 'Review'], code: 0, bytes: 900 };
  for (const [name, check] of [['council-design', 'asks the Muse seat'], ['council-review-pr', 'starts the Muse seat']]) {
    const seat = options => evalCheck(name, check, { sessions: [astraSeat], ...options });
    assert.equal(await seat({ launches: [fable, muse], muse: true }), true);
    assert.equal(await seat({ launches: [fable, { ...muse, code: 1 }], muse: true }), false);
    assert.equal(await seat({ launches: [fable], muse: true }), false);
    assert.equal(await seat({ launches: [fable] }), true);
  }
});

test('the sol-loop check counts a Sol reviewer of the chair, not of another thread', async () => {
  const reviewer = options => evalCheck('sol-loop-pagination', 'a Sol reviewer replied', options);
  assert.equal(await reviewer({ sessions: [{ phase: 'final_answer' }] }), true);
  assert.equal(await reviewer({ sessions: [{ parent: 'chair', phase: 'final_answer' }] }), true);
  assert.equal(await reviewer({ sessions: [{ parent: 'other', phase: 'final_answer' }] }), false);
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

async function fakeRun(fakes) {
  const { dir, env } = await fakeLogins(fakes);
  const r = spawnSync(process.execPath, [script, '--case', 'neg-council-review', '--targets', 'opus-5.5-xhigh', '--runs', '1', '--judges', 'codex'], { encoding: 'utf8', env });
  const results = resultsOf(r);
  const run = path.join(results, 'neg-council-review', 'opus-5.5-xhigh', 'with-1');
  const archive = path.join(run, 'sandbox.tgz');
  const out = {
    final: await fs.readFile(path.join(run, 'final.md'), 'utf8'),
    saved: spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout,
    launches: spawnSync('tar', ['-xzOf', archive, 'launches.jsonl'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
  await fs.rm(results, { recursive: true, force: true });
  await fs.rm(dir, { recursive: true, force: true });
  return out;
}

const museKey = 'muse-key-0123456789abcdefghij';
const chair = body => `${body}
echo '{"type":"system","subtype":"init","model":"fake","cwd":"'"$PWD"'","session_id":"s"}'
echo '{"type":"result","result":"'"$result"'"}'`;

test('a run gives nested Claude and Muse calls their logins, and saves no Muse key', { skip: process.platform === 'win32' }, async () => {
  const { final, saved } = await fakeRun({
    claude: chair(`cp "$XDG_CONFIG_HOME/muse/auth.json" muse.json
result="claude=$(env -u CLAUDE_CODE_OAUTH_TOKEN claude-login) muse=$(grep -c ${museKey} muse.json) meta=\${META_API_KEY:+leaked}"`),
    'claude-login': 'grep -c user:inference "$CLAUDE_CONFIG_DIR/.credentials.json"',
  });
  assert.equal(final, 'claude=1 muse=1 meta=');
  assert.match(saved, /work\//);
  assert.match(saved, /muse-login/);
  assert.doesNotMatch(saved, /muse\.json/);
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

test('a rejudge of a run that an old Codex judge graded asks the current Codex judge', { skip: process.platform === 'win32' }, async () => {
  const { dir, env } = await fakeLogins({
    claude: `cat >/dev/null
case " $* " in
*" --json-schema "*) while [ $# -gt 0 ]; do [ "$1" = --model ] && echo "claude $2" >> "$JUDGE_LOG"; shift; done
  echo '{"is_error":false,"result":"","structured_output":{"pass":true,"reason":"ok"}}' ;;
*) ${chair('result=done')} ;;
esac`,
    codex: `cat >/dev/null
while [ $# -gt 0 ]; do case "$1" in -m) echo "codex $2" >> "$JUDGE_LOG" ;; -o) answer="$2" ;; esac; shift; done
echo '{"pass":true,"reason":"ok"}' > "$answer"`,
  });
  env.JUDGE_LOG = path.join(dir, 'judges.log');
  const config = JSON.parse(await fs.readFile(new URL('../evals/targets.json', import.meta.url), 'utf8'));
  const codexJudge = config.judges.find(j => j.host === 'codex').model;
  const oldJudge = 'gpt-6.1-sol';
  const first = resultsOf(spawnSync(process.execPath, [script, '--case', 'neg-council-review', '--targets', 'opus-5.5-xhigh', '--runs', '1', '--judges', 'claude,codex'], { encoding: 'utf8', env }));
  const runs = path.join(first, 'runs.jsonl');
  await fs.writeFile(runs, (await fs.readFile(runs, 'utf8')).replaceAll(`"judge":"${codexJudge}"`, `"judge":"${oldJudge}"`));
  await fs.rm(env.JUDGE_LOG);
  const again = resultsOf(spawnSync(process.execPath, [script, '--rejudge', first], { encoding: 'utf8', env }));
  const asked = new Set((await fs.readFile(env.JUDGE_LOG, 'utf8')).trim().split('\n'));
  for (const folder of [first, again, dir]) await fs.rm(folder, { recursive: true, force: true });
  assert.deepEqual([...asked].sort(), [`claude ${config.judges.find(j => j.host === 'claude').model}`, `codex ${codexJudge}`]);
});
