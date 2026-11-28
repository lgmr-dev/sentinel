#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const families = ['claude', 'gpt', 'muse'];
const usage = 'usage: node seat.mjs resolve <role> [--author-family <family>] [--available <provider>=<id>,<id>...]... [--names <name>,<name>...]';
const fail = message => { throw new Error(message); };
const defined = entry => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function trackVersion(track, id) {
  const [head, tail] = track.split('*');
  return id.match(new RegExp(`^${escape(head)}(\\d{1,4}(?:[.-]\\d{1,4})*)${escape(tail)}$`))?.[1].split(/[.-]/).map(Number) ?? null;
}

function newer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) > (b[i] ?? -1);
  return false;
}

export function mergeSeats(defaults, user) {
  const models = { ...defaults.models };
  for (const [name, entry] of Object.entries(user?.models ?? {})) {
    const base = defaults.models[name];
    models[name] = !base ? entry : defined({ ...entry,
      provider: entry.provider ?? (!entry.family || entry.family === base.family ? base.provider : undefined),
      model: entry.model ?? base.model,
      effort: entry.effort ?? base.effort,
      family: entry.family ?? (entry.model === undefined && entry.provider === undefined ? base.family : undefined),
      track: entry.track ?? (entry.model === undefined ? base.track : undefined) });
  }
  return { models, roles: { ...defaults.roles, ...user?.roles } };
}

export function resolve(seats, role, { authorFamily, available = {}, names } = {}) {
  if (authorFamily !== undefined && !families.includes(authorFamily)) fail(`--author-family takes ${families.join(', ')}, not ${authorFamily}`);
  const members = names ?? seats.roles[role];
  if (!Array.isArray(members) || !members.length) fail(`the role ${role} has no members`);
  const seen = new Set();
  const list = members.map(name => {
    const entry = seats.models[name];
    if (!entry) fail(names ? `--names gives ${name}, which models does not define` : `the role ${role} names ${name}, which models does not define`);
    for (const key of ['provider', 'model', 'effort']) if (!entry[key]) fail(`the seat ${name} has no ${key}`);
    if (entry.track !== undefined && (entry.track.split('*').length !== 2 || !trackVersion(entry.track, entry.model))) {
      fail(`the track ${entry.track} of the seat ${name} needs one * and must match its model ${entry.model}`);
    }
    let model = entry.model, source = 'model', best = null;
    if (entry.track !== undefined) for (const id of available[entry.provider] ?? []) {
      const version = trackVersion(entry.track, id);
      if (version && (!best || newer(version, best))) [model, source, best] = [id, 'track', version];
    }
    if (seen.has(`${entry.provider} ${model}`)) fail(`two members of the role ${role} use ${entry.provider} ${model}`);
    seen.add(`${entry.provider} ${model}`);
    return defined({ name, provider: entry.provider, model, effort: entry.effort, source, track: entry.track, family: entry.family || undefined });
  });
  const other = member => member.family !== undefined && member.family !== authorFamily;
  return authorFamily ? [...list.filter(other), ...list.filter(member => !other(member))] : list;
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

export function checkSeats(seats, file) {
  if (!isObject(seats)) fail(`${file} is not an object`);
  for (const key of ['models', 'roles']) if (seats[key] !== undefined && !isObject(seats[key])) fail(`${key} in ${file} is not an object`);
  for (const [name, entry] of Object.entries(seats.models ?? {})) {
    if (!isObject(entry)) fail(`the seat ${name} in ${file} is not an object`);
    for (const key of ['model', 'track']) if (entry[key] !== undefined && typeof entry[key] !== 'string') fail(`the ${key} of the seat ${name} in ${file} is not a string`);
  }
  return seats;
}

function userSeats(file) {
  let text, seats;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  try { seats = JSON.parse(text); } catch (error) { fail(`${file} is not valid JSON: ${error.message}`); }
  return checkSeats(seats, file);
}

const isMain = import.meta.main ?? (() => {
  const self = fileURLToPath(import.meta.url);
  try { return path.resolve(process.argv[1]) === self || fs.realpathSync(process.argv[1]) === self; } catch { return false; }
})();
if (isMain) {
  try {
    const [command, role, ...rest] = process.argv.slice(2);
    if (command !== 'resolve' || !role) fail(usage);
    const options = { available: {} };
    for (let i = 0; i < rest.length; i += 2) {
      const [flag, value] = [rest[i], rest[i + 1] ?? ''];
      if (flag === '--author-family') options.authorFamily = value;
      else if (flag === '--names') options.names = value.split(',');
      else if (flag === '--available') {
        const at = value.indexOf('=');
        if (at < 0) fail(`--available ${value} has no =`);
        const provider = value.slice(0, at);
        options.available[provider] = [...options.available[provider] ?? [], ...value.slice(at + 1).split(',').filter(Boolean)];
      } else fail(usage);
    }
    const defaults = JSON.parse(fs.readFileSync(new URL('../seats.json', import.meta.url), 'utf8'));
    const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sentinel', 'seats.json');
    console.log(JSON.stringify(resolve(mergeSeats(defaults, userSeats(file)), role, options), null, 2));
  } catch (error) { console.error(`seat: ${error.message}`); process.exitCode = 1; }
}
