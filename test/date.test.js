import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { messageTimestamp } from '../src/date.js';
import { buildNotification } from '../src/discord.js';
import { readConfig } from '../src/config.js';

test('date ED du 5 octobre : 09:30 Paris devient 07:30 UTC, puis 09:30 en France', () => {
  const timestamp = messageTimestamp('2026-10-05 09:30:00');
  assert.equal(timestamp, '2026-10-05T07:30:00.000Z');
  assert.equal(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })
    .format(new Date(timestamp)), '09:30');
  assert.equal(buildNotification({ id: 1, date: '2026-10-05 09:30:00' }, { profile: 'P' })
    .payload.embeds[0].timestamp, timestamp);
});

test('été/hiver : offset calculé pour la date du message, sans soustraction fixe', () => {
  assert.equal(messageTimestamp('2026-01-05 09:30:00'), '2026-01-05T08:30:00.000Z');
  assert.equal(messageTimestamp('2026-07-05T09:30:00'), '2026-07-05T07:30:00.000Z');
  assert.equal(messageTimestamp('2026-10-05 00:30:00'), '2026-10-04T22:30:00.000Z');
});

test('offset explicite et UTC : pas de double conversion', () => {
  assert.equal(messageTimestamp('2026-10-05T09:30:00Z'), '2026-10-05T09:30:00.000Z');
  assert.equal(messageTimestamp('2026-10-05T09:30:00+02:00'), '2026-10-05T07:30:00.000Z');
  assert.equal(messageTimestamp('2026-10-05 09:30:00+0200'), '2026-10-05T07:30:00.000Z');
  assert.equal(messageTimestamp('2026-10-05T09:30:00.123+02:00'), '2026-10-05T07:30:00.123Z');
  assert.equal(messageTimestamp('2026-10-05 09:30:00.5'), '2026-10-05T07:30:00.500Z');
});

test('format minutes, dates invalides et passage à l’été', () => {
  assert.equal(messageTimestamp('2026-10-05 09:30'), '2026-10-05T07:30:00.000Z');
  for (const raw of [undefined, null, '', 'invalid', '2026-02-30 09:30:00', '2026-10-05 24:00:00', '2026-10-05', '2026-03-29 02:30:00']) {
    assert.equal(messageTimestamp(raw), undefined);
  }
  assert.equal(messageTimestamp('2026-03-29 01:30:00'), '2026-03-29T00:30:00.000Z');
  assert.equal(messageTimestamp('2026-03-29 03:30:00'), '2026-03-29T01:30:00.000Z');
});

test('heure répétée à l’automne : premier instant sans offset, offset respecté sinon', () => {
  assert.equal(messageTimestamp('2026-10-25 02:30:00'), '2026-10-25T00:30:00.000Z');
  assert.equal(messageTimestamp('2026-10-25T02:30:00+01:00'), '2026-10-25T01:30:00.000Z');
});

test('conversion identique sous conteneur UTC et machine dans un autre fuseau', () => {
  const script = `import { messageTimestamp } from ${JSON.stringify(new URL('../src/date.js', import.meta.url).href)};
    console.log(messageTimestamp('2026-10-05 09:30:00'));`;
  for (const TZ of ['UTC', 'America/New_York', 'Europe/Paris']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '2026-10-05T07:30:00.000Z');
  }
});

test('fuseau configurable et validation au démarrage', () => {
  assert.equal(messageTimestamp('2026-10-05 09:30:00', 'America/New_York'), '2026-10-05T13:30:00.000Z');
  const env = { ECOLEDIRECTE_IDENTIFIANT: 'test', ECOLEDIRECTE_MDP: 'test', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token' };
  assert.equal(readConfig(env).timeZone, 'Europe/Paris');
  assert.throws(() => readConfig({ ...env, ECOLEDIRECTE_TIMEZONE: 'Invalid/Zone' }), /IANA invalide/);
});
