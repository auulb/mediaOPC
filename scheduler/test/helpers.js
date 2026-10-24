import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StepExecutor } from '../lib/executor.js';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 临时仓库根：复制 contracts、skills/echo、fixtures/echo、fake-pi，避免污染真实 workspace */
export function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-pipe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(repo, 'contracts'), path.join(root, 'contracts'), { recursive: true });
  fs.cpSync(path.join(repo, 'skills/echo'), path.join(root, 'skills/echo'), { recursive: true });
  fs.cpSync(path.join(repo, 'fixtures/echo'), path.join(root, 'fixtures/echo'), { recursive: true });
  const fake = path.join(root, 'fake-pi');
  fs.copyFileSync(path.join(repo, 'scheduler/test/fixtures/fake-pi'), fake);
  fs.chmodSync(fake, 0o755);
  return { root, fake };
}

export function makeExecutor(root, fake, retry = {}) {
  return new StepExecutor({ root, piBin: fake, launcher: 'spawn', retry: { maxAttempts: 3, baseDelayMs: 10, ...retry }, pollMs: 20 });
}
