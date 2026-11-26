import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const addressOf = (user, domain) => `${user}${'@'}${domain}`;
const unixPath = (...parts) => ['', ...parts].join('/');
const personal = addressOf('alice', 'mail.example-isp.net');
const mailbox = addressOf('Alice', ['Gmail', 'com'].join('.'));
const noreply = addressOf('1+a', 'users.noreply.github.com');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'].includes(name)) delete env[name];
  const repo = path.join(dir, 'repo');
  const run = (args, { as = noreply, committer = as, input, cwd = repo, extra = {} } = {}) => spawnSync('git', args, {
    cwd, input, encoding: 'utf8',
    env: { ...env, GIT_AUTHOR_NAME: 'T', GIT_COMMITTER_NAME: 'T', GIT_AUTHOR_EMAIL: as, GIT_COMMITTER_EMAIL: committer, ...extra },
  });
  const ok = (...a) => {
    const result = run(...a);
    assert.equal(result.status, 0, result.stderr);
  };
  ok(['init', '-q', '--bare', '-b', 'main', path.join(dir, 'remote.git')], { cwd: dir });
  ok(['clone', '-q', path.join(dir, 'remote.git'), repo], { cwd: dir });
  fs.cpSync(path.join(root, 'tools/privacy.sh'), path.join(repo, 'tools/privacy.sh'));
  fs.cpSync(path.join(root, 'tools/hooks'), path.join(repo, 'tools/hooks'), { recursive: true });
  ok(['add', 'tools']);
  ok(['commit', '-q', '-m', 'old history with a personal address'], { as: personal });
  ok(['push', '-q', 'origin', 'main']);
  ok(['config', 'core.hooksPath', 'tools/hooks']);
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), text);
    ok(['add', '--', name]);
  };
  return { repo, run, write };
}

const skip = process.platform === 'win32' && 'the hooks run in bash on macOS and Linux';

const files = [
  ['a home path', unixPath('home', 'alice', '.config'), false],
  ['a Windows home path', ['C:', 'Users', 'alice', 'x'].join('\\'), false],
  ['a Git Bash home path', unixPath('c', 'Users', 'alice', 'x'), false],
  ['a compiler flag', `-I${unixPath('home', 'alice', 'include')}`, false],
  ['an escaped JSON string', `"a\\n${unixPath('home', 'alice')}"`, false],
  ['a lower-case macOS home path', unixPath('users', 'alice'), false],
  ['an ASP.NET Home folder', 'Views/Home/Index.cshtml', true],
  ['a file URL', `file://${unixPath('Users', 'alice', 'x')}`, false],
  ['a personal mailbox', `contact: ${mailbox}.`, false],
  ['a home path after a URL in minified JSON', `{"u":"https://a.example/x","p":"${unixPath('home', 'alice', '.ssh')}"}`, false],
  ['a home path after a URL and a comma', `https://a.example/x,${unixPath('home', 'alice')}`, false],
  ['a file URL with a host', `file://localhost${unixPath('home', 'alice', 'x')}`, false],
  ['a Windows home path without a drive', ['', 'Users', 'alice', 'secret'].join('\\'), false],
  ['a web URL with a home-like path', 'https://github.com/o/r/blob/main/portable/root/README', true],
  ['test data with an address', addressOf('a', 'x.io'), true],
];
for (const [name, text, passes] of files) {
  test(`pre-commit ${passes ? 'accepts' : 'stops'} ${name}`, { skip }, (t) => {
    const { run, write } = setup(t);
    write('f.txt', `${text}\n`);
    assert.equal(run(['commit', '-q', '-m', 'f']).status === 0, passes);
  });
}

test('pre-commit stops a non-ASCII home folder name in the C locale', { skip }, (t) => {
  const { run, write } = setup(t);
  write('f.txt', `${unixPath('Users', 'élise', 'secret')}\n`);
  assert.notEqual(run(['commit', '-q', '-m', 'f'], { extra: { LC_ALL: 'C', LANG: 'C' } }).status, 0);
});

test('the index check stops when git grep fails', { skip }, (t) => {
  const { repo, run, write } = setup(t);
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const shim = path.join(repo, '..', 'shim');
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'git'), `#!/bin/sh\n[ "$1" = grep ] && exit 128\nexec '${real}' "$@"\n`, { mode: 0o755 });
  write('f.txt', 'x\n');
  const result = spawnSync('bash', ['tools/privacy.sh', 'index'], { cwd: repo, env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}` } });
  assert.equal(result.status, 2);
});

test('pre-commit stops a symbolic link, home folders and mailboxes in path names', { skip }, (t) => {
  const { repo, run, write } = setup(t);
  fs.symlinkSync(os.tmpdir(), path.join(repo, 'link'));
  run(['add', 'link']);
  assert.notEqual(run(['commit', '-q', '-m', 'link']).status, 0);
  run(['rm', '-q', '--cached', 'link']);
  write(['backup', 'Users', 'élise', 'f'].join('/'), 'x\n');
  assert.notEqual(run(['commit', '-q', '-m', 'names']).status, 0);
  run(['rm', '-rq', '--cached', 'backup']);
  write(`notes-${mailbox}.txt`, 'x\n');
  assert.notEqual(run(['commit', '-q', '-m', 'names']).status, 0);
});

const pushes = [
  ['a vendor co-author trailer', { message: `x\n\nCo-Authored-By: Bot <${addressOf('noreply', 'anthropic.com')}>` }, true],
  ['a package tag in the message', { message: 'Update package@next and node@v20.1' }, true],
  ['a personal Signed-off-by trailer', { message: `x\n\nSigned-off-by: A <${personal}>` }, false],
  ['a noreply address of a private domain', { message: `x\n\nCo-authored-by: A <${addressOf('noreply', 'corp-mail.net')}>` }, false],
  ['a personal author', { as: personal, committer: noreply }, false],
  ['a personal committer', { committer: personal }, false],
  ['a home path in the message', { message: `see ${unixPath('Users', 'alice', 'notes')}` }, false],
  ['a personal address in the ref name', { ref: `refs/heads/${personal}` }, false],
  ['an SSH remote in the message', { message: `Push to ${addressOf('git', 'github.com')}:o/r.git` }, true],
  ['an upper-case noreply domain', { as: addressOf('1+a', 'USERS.NOREPLY.GITHUB.COM') }, true],
  ['a git author on a private domain', { as: addressOf('git', 'corp-mail.net') }, false],
  ['a personal address in the author name', { extra: { GIT_AUTHOR_NAME: `A ${personal}` } }, false],
  ['a bare upper-case sign-off', { message: `x\n\nSIGNED-OFF-BY: ${personal}` }, false],
];
for (const [name, { message = 'x', ref = 'refs/heads/feature', ...who }, passes] of pushes) {
  test(`pre-push ${passes ? 'accepts' : 'stops'} ${name}`, { skip }, (t) => {
    const { run } = setup(t);
    assert.equal(run(['commit', '-q', '--allow-empty', '-m', message], who).status, 0);
    assert.equal(run(['push', '-q', 'origin', `HEAD:${ref}`]).status === 0, passes);
  });
}

test('pre-push checks tags and the root commit', { skip }, (t) => {
  const { run } = setup(t);
  assert.equal(run(['tag', '-a', 'v1', '-m', 'notes\ntype tree']).status, 0);
  assert.equal(run(['push', '-q', 'origin', 'v1']).status, 0);
  assert.equal(run(['tag', '-a', 'v2', '-m', 'release'], { committer: personal }).status, 0);
  assert.notEqual(run(['push', '-q', 'origin', 'v2']).status, 0);
  run(['checkout', '-q', '--orphan', 'other']);
  assert.equal(run(['commit', '-q', '-m', 'other']).status, 0);
  assert.notEqual(run(['push', '-q', 'origin', 'HEAD:refs/heads/other']).status, 0);
});
