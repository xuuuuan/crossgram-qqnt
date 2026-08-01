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
const DYNAMIC_ENV_KEYS = new Set(['unique_id']);
const SAFE_UNIQUE_ID = /^[A-Za-z0-9._-]{1,128}$/;

process.umask(0o077);

function fail(message) { throw new Error(message); }
function staticEnvironment(env, requireUniqueId = false) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('qq has no saved PM2 environment');
  const result = { ...env };
  const uniqueId = result.unique_id;
  for (const key of DYNAMIC_ENV_KEYS) delete result[key];
  if (requireUniqueId && (typeof uniqueId !== 'string' || !SAFE_UNIQUE_ID.test(uniqueId))) {
    fail('PM2 regenerated unique_id is missing or unsafe');
  }
  return result;
}
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

    const original = ['-i', 'DISPLAY=:0', 'PATH=/usr/bin:/bin', '/usr/bin/setsid', '--wait', '/opt/QQ/qq', '--type=ppapi'];
    const synthetic = '/tmp/synthetic-hardened.so';
    const inserted = definitionWithPreload({ env: {}, args: original }, synthetic).args;
    assert.deepEqual(inserted, ['-i', `LD_PRELOAD=${synthetic}`, ...original.slice(1)]);
    assert.deepEqual(original, ['-i', 'DISPLAY=:0', 'PATH=/usr/bin:/bin', '/usr/bin/setsid', '--wait', '/opt/QQ/qq', '--type=ppapi']);
    envIPlan(original);
    envIPlan(inserted, synthetic);
    const dangerousMarker = join(root, 'must-not-execute');
    assert.throws(() => envIPlan(['-i', `LD_PRELOAD=/tmp/x;touch ${dangerousMarker}`, '/usr/bin/setsid', '--wait', '/opt/QQ/qq']));
    assert.throws(() => envIPlan(['-i', 'X=1', '-i', '/usr/bin/setsid', '--wait', '/opt/QQ/qq']));
    assert.throws(() => envIPlan(['-S', '/usr/bin/setsid', '--wait', '/opt/QQ/qq']));
    assert.throws(() => envIPlan(['-i', '-u', 'root', '/usr/bin/setsid', '--wait', '/opt/QQ/qq']));
    assert.throws(() => envIPlan(['-i', '--', '/usr/bin/setsid', '--wait', '/opt/QQ/qq']));
    assert.throws(() => envIPlan(['-i', 'X=1', 'X=2', '/usr/bin/setsid', '--wait', '/opt/QQ/qq']));
    assert.throws(() => envIPlan(['-i', 'X=1', '/usr/bin/setsid', '--wait', '/wrong/qq']));
    assert.throws(() => envIPlan(['-i', 'X=1', '/wrong/setsid', '--wait', '/opt/QQ/qq']));
    assert.throws(() => envIPlan(['-i', 'X=1', '/usr/bin/setsid', '--wait', '/opt/QQ/qq', 1]));
    assert.throws(() => envIPlan(['-i', 'LD_PRELOAD=/tmp/x', '/usr/bin/setsid', '--wait', '/opt/QQ/qq']));
    assert.throws(() => readFileSync(dangerousMarker));

    const snapshot = {
      exec: '/usr/bin/env', args: original, cwd: '/opt/QQ', interpreter: 'none',
      env: { DISPLAY: ':0', PATH: '/usr/bin:/bin' },
    };
    let starts = 0;
    const mockStart = (wanted, mutation = {}) => ({
      pm_exec_path: wanted.exec, args: wanted.args, pm_cwd: wanted.cwd,
      exec_interpreter: wanted.interpreter,
      env: { ...wanted.env, unique_id: `pm2-${++starts}`, ...mutation },
    });
    const installed = definitionWithPreload(snapshot, synthetic);
    verifyDefinition(mockStart(installed), installed, synthetic);
    verifyDefinition(mockStart(snapshot), snapshot);
    assert.throws(() => verifyDefinition(mockStart(installed, { DISPLAY: ':9' }), installed, synthetic));
    assert.throws(() => verifyDefinition(mockStart(installed, { EXTRA: 'unexpected' }), installed, synthetic));
    for (const uniqueId of ['', 'unsafe/id']) {
      assert.throws(() => verifyDefinition(mockStart(installed, { unique_id: uniqueId }), installed, synthetic));
      assert.throws(() => verifyDefinition(mockStart(snapshot, { unique_id: uniqueId }), snapshot));
    }

    const marker = join(root, 'preload-marker');
    const source = join(root, 'marker.c');
    const helper = join(root, 'helper.c');
    const so = join(root, 'marker.so');
    const child = join(root, 'helper');
    writeFileSync(source, `#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void mark(void) { int f=open(${JSON.stringify(marker)}, O_CREAT|O_WRONLY|O_TRUNC, 0600); if(f>=0) { write(f, \"loaded\", 6); close(f); } }\n`);
    writeFileSync(helper, 'int main(void) { return 0; }\n');
    const cc = realpathSync('/root/.nix-profile/bin/cc');
    assert.equal(spawnSync(cc, ['-shared', '-fPIC', '-Wl,-z,now,-z,relro', '-o', so, source]).status, 0);
    assert.equal(spawnSync(cc, ['-Wl,-z,now,-z,relro', '-o', child, helper]).status, 0);
    assert.equal(spawnSync('/usr/bin/env', ['-i', `LD_PRELOAD=${so}`, '/usr/bin/setsid', '--wait', child], { env: {} }).status, 0);
    assert.equal(readFileSync(marker, 'utf8'), 'loaded');
    unlinkSync(marker);
    assert.equal(spawnSync('/usr/bin/env', ['-i', '/usr/bin/setsid', '--wait', child], { env: {} }).status, 0);
    assert.throws(() => readFileSync(marker));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
function envIPlan(args, expectedPreload = undefined) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    fail('qq argv must contain only strings');
  }
  if (args[0] !== '-i' || args.slice(1).includes('-i') || args.includes('--')) {
    fail('qq argv must begin with one exact env -i option and contain no --');
  }
  let command = 1;
  const names = new Set();
  while (command < args.length) {
    const match = ASSIGNMENT.exec(args[command]);
    if (!match) break;
    if (names.has(match[1])) fail('qq env -i assignments contain a duplicate variable name');
    names.add(match[1]);
    command += 1;
  }
  if (args[command] !== '/usr/bin/setsid' || args[command + 1] !== '--wait' || args[command + 2] !== '/opt/QQ/qq') {
    fail('qq argv does not match the exact env -i setsid --wait /opt/QQ/qq launcher grammar');
  }
  const preloads = args.slice(1, command).filter((arg) => arg.startsWith('LD_PRELOAD='));
  if (expectedPreload === undefined && preloads.length !== 0) fail('qq env -i argv already has LD_PRELOAD');
  if (expectedPreload !== undefined && (preloads.length !== 1 || args[1] !== `LD_PRELOAD=${expectedPreload}`)) {
    fail('qq argv does not contain exactly one LD_PRELOAD immediately after -i');
  }
  return { command, preloads };
}
function definitionWithPreload(snapshot, preload) {
  envIPlan(snapshot.args);
  return { ...snapshot, env: { ...snapshot.env }, args: ['-i', `LD_PRELOAD=${preload}`, ...snapshot.args.slice(1)] };
}
function pm2List(pm2) {
  return JSON.parse(execFileSync(pm2, ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
}
function currentDefinition(pm2) {
  const apps = pm2List(pm2).filter((app) => app.name === APP);
  if (apps.length !== 1) fail('expected exactly one PM2 application named qq');
  const p = apps[0].pm2_env;
  const actualEnv = p.env;
  if (Object.hasOwn(actualEnv ?? {}, 'LD_PRELOAD')) fail('refusing to snapshot an already-preloaded qq process');
  // unique_id is PM2-generated metadata; never persist or replay it.
  const env = staticEnvironment(actualEnv);
  const definition = {
    name: APP,
    exec: p.pm_exec_path,
    args: p.args ?? [],
    cwd: p.pm_cwd,
    interpreter: p.exec_interpreter,
    env,
  };
  if (definition.exec !== '/usr/bin/env' || !isAbsolute(definition.cwd) || !Array.isArray(definition.args)) {
    fail('qq PM2 definition must execute the exact /usr/bin/env -i form');
  }
  envIPlan(definition.args);
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
  if (snapshot.name !== APP || snapshot.exec !== '/usr/bin/env' || !isAbsolute(snapshot.cwd) || !Array.isArray(snapshot.args) || !snapshot.env || Object.hasOwn(snapshot.env, 'LD_PRELOAD') || Object.hasOwn(snapshot.env, 'unique_id')) {
    fail('snapshot has an invalid or preloaded definition');
  }
  envIPlan(snapshot.args);
  staticEnvironment(snapshot.env);
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
function replace(pm2, definition) {
  const deleted = spawnSync(pm2, ['delete', APP], { stdio: 'inherit' });
  if (deleted.status !== 0) fail('PM2 failed to delete qq');
  const started = spawnSync(pm2, [
    'start', definition.exec, '--name', APP, '--cwd', definition.cwd,
    '--interpreter', definition.interpreter, '--', ...definition.args,
  ], { env: definition.env, stdio: 'inherit' });
  if (started.status !== 0) fail('PM2 failed to start qq');
}
function verifyDefinition(actual, wanted, preload = undefined) {
  assert.equal(actual.pm_exec_path, wanted.exec, 'PM2 executable mismatch');
  assert.deepEqual(actual.args ?? [], wanted.args, 'PM2 argv mismatch');
  assert.equal(actual.pm_cwd, wanted.cwd, 'PM2 cwd mismatch');
  assert.equal(actual.exec_interpreter, wanted.interpreter, 'PM2 interpreter mismatch');
  if (Object.hasOwn(actual.env ?? {}, 'LD_PRELOAD')) fail('PM2 environment must not contain LD_PRELOAD');
  assert.deepEqual(staticEnvironment(actual.env, true), wanted.env, 'PM2 saved environment mismatch');
  envIPlan(actual.args ?? [], preload);
}
function verify(pm2, wanted, preload = undefined) {
  const apps = pm2List(pm2).filter((app) => app.name === APP);
  if (apps.length !== 1) fail('qq was not restored as exactly one PM2 application');
  verifyDefinition(apps[0].pm2_env, wanted, preload);
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
    const preload = checkedPreload(argument);
    const wanted = definitionWithPreload(snapshot, preload);
    replace(pm2, wanted);
    verify(pm2, wanted, preload);
  } else if (command === 'rollback' && argument === undefined) {
    const wanted = loadSnapshot();
    replace(pm2, wanted);
    verify(pm2, wanted);
    } else fail('usage: ppapi-host-pm2.mjs {snapshot|install /absolute/preload.so|rollback}');
  }
} catch (error) {
  process.stderr.write(`ppapi-host-pm2: ${error.message}\n`);
  process.exitCode = 1;
}
