#!/usr/bin/env node
import {
  chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const APP = 'qq';
const PM2_PROFILE = '/root/.nix-profile/bin/pm2';
const STATE_DIR = join(homedir(), '.local', 'state', 'crossgram-ppapi-host');
const SNAPSHOT = join(STATE_DIR, 'qq-pm2.json');
const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = constants;

process.umask(0o077);

function fail(message) { throw new Error(message); }
function ownedPrivate(stat, mode, label) {
  if (stat.uid !== process.getuid()) fail(`${label} has the wrong owner`);
  if ((stat.mode & 0o777) !== mode) fail(`${label} has the wrong mode`);
}
function checkedDirectory(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${path} is not a directory`);
    ownedPrivate(stat, 0o700, path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(path, { mode: 0o700 });
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`${path} is a symlink`);
    ownedPrivate(stat, 0o700, path);
  }
}
function checkedRegular(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a regular file`);
  ownedPrivate(stat, 0o600, label);
  return stat;
}
function trustedOwner(stat, label) {
  if (stat.uid !== 0 && stat.uid !== process.getuid()) fail(`${label} has an unexpected owner`);
}
function pm2Binary(profile = PM2_PROFILE, storePrefix = '/nix/store/') {
  const profileStat = lstatSync(profile);
  if (!profileStat.isSymbolicLink()) fail('PM2 profile entry must be a symlink');
  // Linux symlink permissions are fixed at 0777 and are not dereferenced here.
  trustedOwner(profileStat, 'PM2 profile entry');
  if ((profileStat.mode & 0o777) !== 0o777) fail('PM2 profile symlink has an unexpected mode');
  const resolved = realpathSync(profile);
  if (!resolved.startsWith(storePrefix) || !/^.*\/bin\/pm2$/.test(resolved)) {
    fail('PM2 profile target is outside the trusted Nix store PM2 path');
  }
  const target = statSync(resolved);
  if (!target.isFile()) fail('PM2 target must be a regular file');
  trustedOwner(target, 'PM2 target');
  if ((target.mode & 0o022) !== 0 || (target.mode & 0o111) === 0) {
    fail('PM2 target is writable or not executable');
  }
  return resolved;
}
function pm2FixtureTests() {
  const root = mkdtempSync('/tmp/ppapi-host-pm2-fixture-');
  try {
    const store = join(root, 'store');
    const target = join(store, 'fixture', 'bin', 'pm2');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const profile = join(root, 'pm2');
    symlinkSync(target, profile);
    assert.equal(pm2Binary(profile, `${store}/`), target);

    const unsafeTarget = join(root, 'unsafe-target');
    writeFileSync(unsafeTarget, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(unsafeTarget, 0o777);
    const unsafeProfile = join(root, 'unsafe-pm2');
    symlinkSync(unsafeTarget, unsafeProfile);
    assert.throws(() => pm2Binary(unsafeProfile, `${root}/`));

    const regularProfile = join(root, 'regular-pm2');
    writeFileSync(regularProfile, '#!/bin/sh\n', { mode: 0o755 });
    assert.throws(() => pm2Binary(regularProfile, `${store}/`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function pm2List(pm2) {
  return JSON.parse(execFileSync(pm2, ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
}
function currentDefinition(pm2) {
  const apps = pm2List(pm2).filter((app) => app.name === APP);
  if (apps.length !== 1) fail('expected exactly one PM2 application named qq');
  const p = apps[0].pm2_env;
  const env = p.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('qq has no saved PM2 environment');
  if (Object.hasOwn(env, 'LD_PRELOAD')) fail('refusing to snapshot an already-preloaded qq process');
  const definition = {
    name: APP,
    exec: p.pm_exec_path,
    args: p.args ?? [],
    cwd: p.pm_cwd,
    interpreter: p.exec_interpreter,
    env,
  };
  if (!isAbsolute(definition.exec) || !isAbsolute(definition.cwd) || !Array.isArray(definition.args)) {
    fail('qq PM2 definition is incomplete');
  }
  return definition;
}
function writeSnapshot(definition) {
  checkedDirectory(STATE_DIR);
  try { checkedRegular(SNAPSHOT, 'existing snapshot'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(STATE_DIR, `.${basename(SNAPSHOT)}.${randomBytes(16).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temp, O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(definition)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, SNAPSHOT);
    checkedRegular(SNAPSHOT, 'snapshot');
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function loadSnapshot() {
  checkedDirectory(STATE_DIR);
  checkedRegular(SNAPSHOT, 'snapshot');
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  if (snapshot.name !== APP || !isAbsolute(snapshot.exec) || !isAbsolute(snapshot.cwd) || !Array.isArray(snapshot.args) || !snapshot.env || Object.hasOwn(snapshot.env, 'LD_PRELOAD')) {
    fail('snapshot has an invalid or preloaded definition');
  }
  return snapshot;
}
function checkedPreload(path) {
  if (!isAbsolute(path)) fail('preload must be an absolute path');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('preload must be a real regular file');
  if (stat.uid !== 0 && stat.uid !== process.getuid()) fail('preload has an unexpected owner');
  if ((stat.mode & 0o022) !== 0) fail('preload is group/world writable');
  return realpathSync(path);
}
function expected(snapshot, preload) {
  const env = { ...snapshot.env };
  if (preload) env.LD_PRELOAD = preload;
  else delete env.LD_PRELOAD;
  return { ...snapshot, env };
}
function replace(pm2, definition) {
  const deleted = spawnSync(pm2, ['delete', APP], { stdio: 'inherit' });
  if (deleted.status !== 0) fail('PM2 failed to delete qq');
  const started = spawnSync(pm2, [
    'start', definition.exec, '--name', APP, '--cwd', definition.cwd,
    '--interpreter', definition.interpreter, '--', ...definition.args,
  ], { env: definition.env, stdio: 'inherit' });
  if (started.status !== 0) fail('PM2 failed to start qq');
}
function verify(pm2, wanted) {
  const apps = pm2List(pm2).filter((app) => app.name === APP);
  if (apps.length !== 1) fail('qq was not restored as exactly one PM2 application');
  const actual = apps[0].pm2_env;
  assert.equal(actual.pm_exec_path, wanted.exec, 'PM2 executable mismatch');
  assert.deepEqual(actual.args ?? [], wanted.args, 'PM2 argv mismatch');
  assert.equal(actual.pm_cwd, wanted.cwd, 'PM2 cwd mismatch');
  assert.equal(actual.exec_interpreter, wanted.interpreter, 'PM2 interpreter mismatch');
  assert.deepEqual(actual.env, wanted.env, 'PM2 saved environment mismatch');
  if (Object.hasOwn(wanted.env, 'LD_PRELOAD') !== Object.hasOwn(actual.env, 'LD_PRELOAD')) fail('PM2 preload policy mismatch');
}

try {
  const [command, argument] = process.argv.slice(2);
  if (command === '--self-test' && argument === undefined) pm2FixtureTests();
  else {
    const pm2 = pm2Binary();
    if (command === 'snapshot' && argument === undefined) writeSnapshot(currentDefinition(pm2));
  else if (command === 'install' && argument !== undefined) {
    const snapshot = currentDefinition(pm2);
    writeSnapshot(snapshot);
    const wanted = expected(snapshot, checkedPreload(argument));
    replace(pm2, wanted);
    verify(pm2, wanted);
  } else if (command === 'rollback' && argument === undefined) {
    const wanted = expected(loadSnapshot(), '');
    replace(pm2, wanted);
    verify(pm2, wanted);
    } else fail('usage: ppapi-host-pm2.mjs {snapshot|install /absolute/preload.so|rollback}');
  }
} catch (error) {
  process.stderr.write(`ppapi-host-pm2: ${error.message}\n`);
  process.exitCode = 1;
}
