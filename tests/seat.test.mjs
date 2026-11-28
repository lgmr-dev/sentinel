import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/council/scripts/seat.mjs', import.meta.url));

async function seat(args, user, { run = script } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seat-'));
  const config = path.join(dir, 'config');
  if (user !== undefined) {
    await fs.mkdir(path.join(config, 'sentinel'), { recursive: true });
    await fs.writeFile(path.join(config, 'sentinel', 'seats.json'), typeof user === 'string' ? user : JSON.stringify(user));
  }
  const link = path.join(dir, 'seat-link.mjs');
  if (run === 'symlink') await fs.symlink(script, link);
  const r = spawnSync(process.execPath, [run === 'symlink' ? link : run, 'resolve', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: config } });
  await fs.rm(dir, { recursive: true, force: true });
  return { code: r.status, seats: r.status === 0 ? JSON.parse(r.stdout) : null, error: r.stderr };
}

const names = result => result.seats.map(s => s.name);
const fable = { name: 'fable', provider: 'claude', model: 'claude-fable-5-2', effort: 'high', source: 'model', track: 'claude-fable-*', family: 'claude' };
const sol = { name: 'sol', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high', source: 'model', track: 'gpt-*-sol', family: 'gpt' };
const muse = { name: 'muse', provider: 'muse', model: 'muse-wonder-full-1.0', effort: 'high', source: 'model', track: 'muse-wonder-full-*', family: 'muse' };
const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
const guide = readme.slice(readme.indexOf('\n## Seats\n'), readme.indexOf('\n## Updates\n'));
const [pin, noMuse, oneFamily, effort] = [...guide.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map(block => JSON.parse(block[1]));

test('seat runs through a symlink from another folder and prints the shipped defaults', { skip: process.platform === 'win32' }, async () => {
  assert.deepEqual((await seat(['council'], undefined, { run: 'symlink' })).seats, [fable, sol, muse]);
});

test('a user file wins only for the roles that it defines', async () => {
  const user = { roles: { council: ['sol'] } };
  assert.deepEqual(names(await seat(['council'], user)), ['sol']);
  assert.deepEqual(names(await seat(['reviewer'], user)), ['sol', 'opus']);
});

test('a Patrol seats file with no roles gets the default roles and the default entries that it leaves out', async () => {
  const patrol = { models: { opus: { provider: 'claude', model: 'claude-opus-5-5', family: 'claude', effort: 'high' } } };
  assert.deepEqual((await seat(['council'], patrol)).seats, [fable, sol, muse]);
});

test('a user entry takes the missing provider and effort from the default entry of the same name', async () => {
  const opus = async entry => (await seat(['reviewer', '--names', 'opus'], { models: { opus: entry } })).seats[0];
  assert.deepEqual(await opus({ model: 'claude-opus-5-6', family: 'claude' }),
    { name: 'opus', provider: 'claude', model: 'claude-opus-5-6', effort: 'high', source: 'model', family: 'claude' });
  assert.deepEqual(await opus({ model: 'claude-opus-5-6' }), { name: 'opus', provider: 'claude', model: 'claude-opus-5-6', effort: 'high', source: 'model' });
  assert.deepEqual(await opus({ model: 'claude-opus-5-6', track: 'claude-opus-*' }),
    { name: 'opus', provider: 'claude', model: 'claude-opus-5-6', effort: 'high', source: 'model', track: 'claude-opus-*' });
  const gpt = { models: { opus: { model: 'gpt-6.1-astra', family: 'gpt' } } };
  assert.match((await seat(['reviewer'], gpt)).error, /the seat opus has no provider/);
  assert.deepEqual(names(await seat(['council'], gpt)), ['fable', 'sol', 'muse']);
  assert.deepEqual((await seat(['reviewer', '--names', 'sol'], { models: { sol: { provider: 'copilot' } } })).seats,
    [{ name: 'sol', provider: 'copilot', model: 'gpt-6.2-sol', effort: 'high', source: 'model', track: 'gpt-*-sol' }]);
});

test('--author-family puts the members of another family first', async () => {
  assert.deepEqual(names(await seat(['reviewer', '--author-family', 'claude'])), ['sol', 'opus']);
  assert.deepEqual(names(await seat(['reviewer', '--author-family', 'gpt'])), ['opus', 'sol']);
  const user = { models: { spare: { provider: 'copilot', model: 'spare-1', effort: 'high' } }, roles: { reviewer: ['spare', 'opus', 'sol'] } };
  assert.deepEqual(names(await seat(['reviewer', '--author-family', 'claude'], user)), ['sol', 'spare', 'opus']);
  const empty = { models: { spare: { provider: 'copilot', model: 'spare-1', effort: 'high', family: '' } }, roles: { reviewer: ['opus', 'spare'] } };
  assert.deepEqual(names(await seat(['reviewer', '--author-family', 'claude'], empty)), ['opus', 'spare']);
});

test('the role validates only its own members', async () => {
  assert.deepEqual(names(await seat(['council'], { models: { spare: { provider: 'claude', model: 'claude-haiku-5-5' } } })), ['fable', 'sol', 'muse']);
});

test('--names gives the named entries in their order, with no check of the role', async () => {
  assert.deepEqual(names(await seat(['council'], noMuse)), ['fable', 'sol']);
  assert.deepEqual(names(await seat(['council', '--names', 'muse,fable'], noMuse)), ['muse', 'fable']);
  assert.deepEqual(names(await seat(['reviewer', '--names', 'sol'], oneFamily)), ['sol']);
  assert.deepEqual(names(await seat(['reviewer', '--names', 'sol'], { roles: { reviewer: [] } })), ['sol']);
});

test('--available gives a member with a track the newest listed ID of its provider', async () => {
  const solFrom = async (...lists) => (await seat(['reviewer', ...lists.flatMap(list => ['--available', list])])).seats.find(s => s.name === 'sol');
  assert.deepEqual(await solFrom('codex=gpt-6-sol,gpt-6.2-sol,gpt-6.10-sol,gpt-6.11-astra'), { ...sol, model: 'gpt-6.10-sol', source: 'track' });
  assert.deepEqual(await solFrom('codex='), sol);
  assert.deepEqual(await solFrom('codex=gpt-mini-sol'), sol);
  assert.deepEqual(await solFrom('codex=gpt-6.1-sol'), { ...sol, model: 'gpt-6.1-sol', source: 'track' });
  assert.deepEqual(await solFrom('claude=gpt-6.10-sol'), sol);
  assert.deepEqual(await solFrom('codex=gpt-6.1-sol', 'codex=gpt-6.3-sol,gpt-6-sol'), { ...sol, model: 'gpt-6.3-sol', source: 'track' });
  const opus = await seat(['reviewer', '--names', 'opus', '--available', 'claude=claude-opus-5-20260101,claude-opus-5-5']);
  assert.deepEqual([opus.seats[0].model, opus.seats[0].source], ['claude-opus-5-5', 'track']);
  const pinned = await seat(['reviewer', '--available', 'codex=gpt-6.3-sol'], { models: { sol: { model: 'gpt-6.1-sol', family: 'gpt' } } });
  assert.deepEqual(pinned.seats[0], { name: 'sol', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', source: 'model', family: 'gpt' });
});

test('the examples of the seat guide resolve', async () => {
  assert.deepEqual((await seat(['reviewer', '--author-family', 'claude', '--available', 'codex=gpt-6.3-sol'], pin)).seats[0],
    { name: 'sol', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', source: 'model', family: 'gpt' });
  assert.deepEqual((await seat(['council'], effort)).seats, [{ ...fable, effort: 'medium' }, sol, muse]);
  const opus = { ...fable, name: 'opus', model: 'claude-opus-5-5', track: 'claude-opus-*' };
  assert.deepEqual((await seat(['reviewer', '--author-family', 'claude'], oneFamily)).seats, [fable, opus]);
  assert.deepEqual((await seat(['council', '--available', 'claude=claude-fable-5-3'], oneFamily)).seats,
    [{ ...fable, model: 'claude-fable-5-3', source: 'track' }, opus]);
});

const faults = [
  ['a user file that is not valid JSON', ['council'], '{ "models": ', /is not valid JSON/],
  ['models that is not an object', ['council'], { models: [] }, /models in .* is not an object/],
  ['a models entry that is a string', ['council'], { models: { sol: 'gpt-6.3-sol' } }, /the seat sol in .* is not an object/],
  ['a models entry that is null', ['council'], { models: { sol: null } }, /the seat sol in .* is not an object/],
  ['a track that is not a string', ['reviewer'], { models: { sol: { track: 6 } } }, /the track of the seat sol in .* is not a string/],
  ['roles that is not an object', ['council'], { roles: 'fable' }, /roles in .* is not an object/],
  ['a role with no members', ['council'], { roles: { council: [] } }, /the role council has no members/],
  ['a role that the file does not define', ['tester'], undefined, /the role tester has no members/],
  ['a member that models does not define', ['council'], { roles: { council: ['fable', 'astra'] } }, /the role council names astra/],
  ['a member with no provider', ['council'], { models: { spare: { model: 'm', effort: 'high' } }, roles: { council: ['spare'] } }, /the seat spare has no provider/],
  ['a member with no model', ['council'], { models: { spare: { provider: 'claude', effort: 'high' } }, roles: { council: ['spare'] } }, /the seat spare has no model/],
  ['a member with no effort', ['council'], { models: { spare: { provider: 'claude', model: 'm' } }, roles: { council: ['spare'] } }, /the seat spare has no effort/],
  ['an unknown author family', ['reviewer', '--author-family', 'llama'], undefined, /--author-family takes claude, gpt, muse/],
  ['a track with no *', ['reviewer'], { models: { sol: { track: 'gpt-6.2-sol' } } }, /the track gpt-6.2-sol of the seat sol needs one \*/],
  ['a track with two *', ['reviewer'], { models: { sol: { track: 'gpt-*.*-sol' } } }, /the track gpt-\*\.\*-sol/],
  ['a track that does not match its model', ['reviewer'], { models: { sol: { model: 'gpt-6.2-astra', track: 'gpt-*-sol' } } }, /must match its model gpt-6.2-astra/],
  ['an --available value with no =', ['reviewer', '--available', 'gpt-6.3-sol'], undefined, /--available gpt-6.3-sol has no =/],
  ['a --names entry that models does not define', ['council', '--names', 'fable,astra'], undefined, /--names gives astra/],
  ['two members with one provider and model', ['reviewer', '--available', 'codex=gpt-6.3-sol'],
    { models: { old: { provider: 'codex', model: 'gpt-6.1-sol', track: 'gpt-*-sol', effort: 'high' } }, roles: { reviewer: ['sol', 'old'] } }, /two members of the role reviewer use codex gpt-6.3-sol/],
];
for (const [name, args, user, error] of faults) {
  test(`seat exits with code 1 for ${name}`, async () => {
    const result = await seat(args, user);
    assert.equal(result.code, 1);
    assert.match(result.error, error);
  });
}
