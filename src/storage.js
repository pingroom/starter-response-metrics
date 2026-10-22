import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './schema.js';

export const MAX_FILE_BYTES = 128 * 1024;

export async function privateDirectory(directory) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('The state directory must be a real directory, not a symlink.');
  await chmod(directory, 0o700);
}

export async function readJson(path, { optional = false, maxBytes = MAX_FILE_BYTES } = {}) {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) fail('A local JSON file is not a bounded regular file.');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) fail('A local JSON file is too large or invalid.');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) fail('A local JSON file exceeds its size limit.');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { fail('A local JSON file is malformed; preserve it and restore a known-good copy.'); }
  } catch (error) {
    if (error.code === 'ENOENT' && optional) return undefined;
    throw error;
  } finally { await handle?.close(); }
}

export async function atomicJson(directory, name, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > MAX_FILE_BYTES) fail('Snapshot exceeds the local storage limit.');
  const destination = join(directory, name);
  const temp = join(directory, `.${name}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temp, destination);
  } finally {
    await handle?.close();
    await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function withLock(directory, operation) {
  await privateDirectory(directory);
  const path = join(directory, 'scan.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('State is locked. Stop other instances before removing a stale .pingroom/scan.lock.'); throw error; }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    return await operation();
  } finally { await handle.close(); await unlink(path); }
}
