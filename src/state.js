import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function scopeFor(config, accountId) {
  return createHash('sha256').update(JSON.stringify([
    config.identifier, config.profile, accountId, config.apip, config.webhook, config.threadId,
  ])).digest('hex');
}

export class State {
  constructor(file) { this.file = file; this.scopes = {}; }
  async load() {
    let raw;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('État anti-doublons illisible'); }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('État anti-doublons JSON invalide'); }
    if (data.version !== 1 || !data.scopes || typeof data.scopes !== 'object'
        || Array.isArray(data.scopes) || Object.values(data.scopes).some(ids =>
          !Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) {
      throw new Error('État anti-doublons invalide');
    }
    this.scopes = data.scopes;
  }
  has(scope, id) { return (this.scopes[scope] || []).includes(String(id)); }
  async mark(scope, id) {
    const ids = this.scopes[scope] || [];
    if (!ids.includes(String(id))) this.scopes[scope] = [...ids, String(id)];
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1, scopes: this.scopes }), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }
}
