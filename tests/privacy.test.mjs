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
  ['a file URL with an encoded name', `file://${unixPath('home', '%C3%A9lise', 'x')}`, false],
  ['a printf format after a home folder', `printf '${unixPath('home', '%s')}'`, true],
  ['a Windows home path without a drive', ['', 'Users', 'alice', 'secret'].join('\\'), false],
  ['a home path after a URL in a table', `|https://a.example/x|${unixPath('home', 'alice', 'k')}|`, false],
  ['a home folder in a WSL share', ['', '', 'wsl$', 'Ubuntu', 'home', 'alice'].join('\\'), false],
  ['an upper-case web URL with a home-like path', 'HTTPS://github.com/o/r/blob/main/root/README', true],
  ['a web URL with a home-like path', 'https://github.com/o/r/blob/main/portable/root/README', true],
  ['test data with an address', addressOf('a', 'x.io'), true],
  ['a Tuta mailbox', addressOf('alice', 'tuta.com'), false],
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
  run(['rm', '-q', '--cached', `notes-${mailbox}.txt`]);
  write(`notes-${personal}.txt`, 'x\n');
  assert.notEqual(run(['commit', '-q', '-m', 'names']).status, 0);
});

test('pre-push reads the real commits and not replacement objects', { skip }, (t) => {
  const { run } = setup(t);
  assert.equal(run(['commit', '-q', '--allow-empty', '-m', 'x'], { as: personal }).status, 0);
  const tree = run(['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const clean = run(['commit-tree', tree, '-p', 'HEAD~1', '-m', 'x']).stdout.trim();
  assert.equal(run(['replace', 'HEAD', clean]).status, 0);
  assert.notEqual(run(['push', '-q', 'origin', 'HEAD:refs/heads/replaced']).status, 0);
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
  ['an ssh URL in the message', { message: `Clone ssh://${addressOf('git', 'github.com')}/o/r.git` }, true],
  ['a personal address after an SSH remote and a comma', { message: `See ${addressOf('git', 'github.com')}:o/r.git,${personal}` }, false],
  ['a generic type in a trailer', { message: 'x\n\nCaused-by: List<String> change' }, true],
  ['a GitHub web-flow committer', { committer: addressOf('web-flow', 'github.com') }, true],
  ['a personal address that ends in -git before a colon', { message: `Ask ${addressOf('team-git', 'corp-mail.net')}: now` }, false],
  ['two angle values in a sign-off', { message: `x\n\nSigned-off-by: A <${addressOf('alice', 'myhost')}> <${noreply}>` }, false],
  ['a subdomain of a reserved example domain', { message: `Mail ${addressOf('a', 'mail.example.com')}` }, true],
  ['a pre-release package version', { message: 'bump pkg@v1.0.0-rc.alpha and @scope/pkg@1.0.0-canary.abc' }, true],
  ['an image size and a systemd unit', { message: 'Add logo@2x.png and enable wg-quick@wg0.service' }, true],
  ['a branch name with a users folder', { ref: ['refs', 'heads', 'feat', 'users', 'login'].join('/') }, true],
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

test('the printed list command runs and names the file', { skip }, (t) => {
  const { repo, write } = setup(t);
  write('f.txt', `${unixPath('home', 'alice')}\n`);
  const check = spawnSync('bash', ['tools/privacy.sh', 'index'], { cwd: repo, encoding: 'utf8' });
  const command = check.stderr.split('list them with ')[1].split('\n')[0];
  const listed = spawnSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^f\.txt:1:/);
});

test('the printed link command lists a staged link', { skip }, (t) => {
  const { repo, run } = setup(t);
  fs.symlinkSync('target', path.join(repo, 'link'));
  run(['add', 'link']);
  const check = spawnSync('bash', ['tools/privacy.sh', 'index'], { cwd: repo, encoding: 'utf8' });
  const command = check.stderr.split('list them with ')[1].split('\n')[0];
  assert.match(spawnSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8' }).stdout, /\tlink$/m);
});

test('pre-push checks the tagger of a merged signed tag', { skip }, (t) => {
  const { repo, run } = setup(t);
  const key = path.join(repo, '..', 'key');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]).status, 0);
  const signing = ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`];
  run(['checkout', '-q', '-b', 'side']);
  assert.equal(run(['commit', '-q', '--allow-empty', '-m', 'side']).status, 0);
  assert.equal(run([...signing, 'tag', '-s', 'signed', '-m', 'signed'], { committer: personal }).status, 0);
  run(['checkout', '-q', 'main']);
  assert.equal(run(['merge', '-q', '--no-ff', '--no-edit', 'signed']).status, 0);
  assert.notEqual(run(['push', '-q', 'origin', 'HEAD:refs/heads/merged']).status, 0);
});

test('pre-push checks a renamed annotated tag', { skip }, (t) => {
  const { run } = setup(t);
  assert.equal(run(['tag', '-a', personal, '-m', 'release']).status, 0);
  assert.equal(run(['tag', 'clean', personal]).status, 0);
  assert.notEqual(run(['push', '-q', 'origin', 'clean']).status, 0);
});

test('pre-commit and pre-push stop a UTF-16 file with private data', { skip }, (t) => {
  const { repo, run } = setup(t);
  for (const [name, text] of [['home.txt', `p=${unixPath('home', 'alice', 'x')}\r\n`], ['mail.txt', `contact ${mailbox}\r\n`], ['größe.txt', `p=${unixPath('home', 'alice', 'x')}\r\n`]]) {
    fs.writeFileSync(path.join(repo, name), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    run(['add', name]);
    assert.notEqual(run(['commit', '-q', '-m', name]).status, 0, name);
    assert.equal(run(['commit', '-q', '--no-verify', '-m', name]).status, 0);
    assert.notEqual(run(['push', '-q', 'origin', `HEAD:refs/heads/${name}`]).status, 0, name);
    run(['reset', '-q', '--hard', 'origin/main']);
  }
});

test('pre-commit stops a top-level home folder in a name with a tab', { skip }, (t) => {
  const { run, write } = setup(t);
  write(['home', 'alice\tx', 'f'].join('/'), 'x\n');
  assert.notEqual(run(['commit', '-q', '-m', 'names']).status, 0);
});

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
