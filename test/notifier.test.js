import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { EcoleDirecte } from '../src/ecoledirecte.js';
import { Discord, buildNotification, readableText } from '../src/discord.js';
import { State, scopeFor } from '../src/state.js';
import { pollOnce, StateWriteError } from '../src/poller.js';

const config = () => readConfig({
  ECOLEDIRECTE_IDENTIFIANT: 'test', ECOLEDIRECTE_MDP: 'secret',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/test-token',
});
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const gtk = () => new Response('{}', { headers: { 'Set-Cookie': 'GTK=test-gtk; Path=/; HttpOnly' } });

test('configuration : valeurs par défaut et validation', () => {
  assert.equal(config().intervalMs, 60000);
  assert.equal(config().profile, 'A');
  const env = { ECOLEDIRECTE_IDENTIFIANT: 'a', ECOLEDIRECTE_MDP: 'b', DISCORD_WEBHOOK_URL: config().webhook };
  assert.throws(() => readConfig({ ...env, ECOLEDIRECTE_PROFILE: 'E' }), /P ou A/);
  assert.throws(() => readConfig({ ...env, POLL_INTERVAL_SECONDS: '0' }), /entier/);
  assert.throws(() => readConfig({ ...env, DISCORD_WEBHOOK_URL: 'https://example.com/webhook' }), /Discord/);
  assert.throws(() => readConfig({}), /obligatoire/);
});

test('login P vers A : GTK, UID, token et ID du profil renouvelé', async () => {
  const calls = [];
  const responses = [gtk(), json({ code: 200, token: 'base', data: { accounts: [{ typeCompte: 'P', id: 12, uid: 'uid' }] } }),
    json({ code: 200, token: 'teacher', data: { id: 42 } }),
    json({ code: 200, token: 'rotated', data: { messages: { received: [{ id: 1, read: false }, { id: 2, read: true }] } } })];
  const ed = new EcoleDirecte(config(), async (url, options) => { calls.push({ url, options }); return responses.shift(); });
  assert.deepEqual(await ed.unreadMessages(), [{ id: 1, read: false }]);
  assert.equal(calls[1].options.headers['X-Gtk'], 'test-gtk');
  assert.equal(calls[1].options.headers.Cookie, 'GTK=test-gtk');
  assert.deepEqual(JSON.parse(calls[2].options.body.get('data')), { profil: 'A', uid: 'uid', uuid: '' });
  assert.match(calls[3].url.pathname, /enseignants\/42\/messages.awp/);
  assert.equal(calls[3].url.searchParams.get('getAll'), '1');
  assert.equal(calls[3].options.headers['X-Token'], 'teacher');
  assert.equal(ed.token, 'rotated');
});

test('profil A direct sans renouvellement et messagerie vide normale', async () => {
  const responses = [gtk(), json({ code: 200, token: 'base', data: { accounts: [{ typeCompte: 'A', id: 8 }] } }),
    json({ code: 200, data: { messages: { received: [] } } })];
  const ed = new EcoleDirecte(config(), async () => responses.shift());
  assert.deepEqual(await ed.unreadMessages(), []);
  assert.equal(responses.length, 0);
});

test('switch A vers P sur un compte choisi explicitement', async () => {
  const cfg = { ...config(), profile: 'P', accountId: '99' };
  const calls = [];
  const responses = [gtk(), json({ code: 200, token: 'base', data: { accounts: [
    { typeCompte: 'P', id: 1 }, { typeCompte: 'A', id: 99, uid: 'chosen' },
  ] } }), json({ code: 200, token: 'p', data: { id: 88 } })];
  const ed = new EcoleDirecte(cfg, async (url, options) => { calls.push(options); return responses.shift(); });
  await ed.login();
  assert.equal(JSON.parse(calls[2].body.get('data')).profil, 'P');
  assert.equal(JSON.parse(calls[2].body.get('data')).uid, 'chosen');
  assert.equal(ed.id, 88);
});

test('token expiré : reconnexion puis reconstruction de l’URL', async () => {
  const urls = [];
  const responses = [json({ code: 520 }), gtk(),
    json({ code: 200, token: 'new', data: { accounts: [{ typeCompte: 'A', id: 77 }] } }),
    json({ code: 200, data: { messages: { received: [] } } })];
  const ed = new EcoleDirecte(config(), async url => { urls.push(url); return responses.shift(); });
  ed.token = 'expired'; ed.id = 1;
  await ed.unreadMessages();
  assert.match(urls.at(-1).pathname, /enseignants\/77\//);
});

test('reconnexion bornée et format inattendu signalé', async () => {
  const responses = [json({ code: 520 }), gtk(),
    json({ code: 200, token: 'new', data: { accounts: [{ typeCompte: 'A', id: 77 }] } }), json({ code: 520 })];
  const ed = new EcoleDirecte(config(), async () => responses.shift());
  ed.token = 'expired'; ed.id = 1;
  await assert.rejects(ed.unreadMessages(), /520/);
  assert.equal(responses.length, 0);
  ed.fetch = async () => json({ code: 200, data: {} }); ed.token = 'test';
  await assert.rejects(ed.unreadMessages(), /format/);
});

test('erreur de connexion : la réponse distante contenant des secrets n’est pas propagée', async () => {
  const responses = [gtk(), json({ code: 250, message: 'secret' })];
  const ed = new EcoleDirecte(config(), async () => responses.shift());
  await assert.rejects(ed.login(), error => !error.message.includes('secret') && error.message.includes('250'));
});

test('embed : HTML, mentions neutralisées, limites et texte complet', () => {
  assert.equal(readableText('<p>Bonjour &amp; merci</p><script>secret</script><p>&#233;cole</p>'), 'Bonjour & merci\nécole');
  const notification = buildNotification({ id: 4, subject: '*'.repeat(500), content: '<p>' + 'x'.repeat(20000) + '</p>',
    from: { nom: '@everyone' }, files: [{ libelle: 'test.pdf' }] }, config());
  const embed = notification.payload.embeds[0];
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4096);
  assert.ok(JSON.stringify(embed).length < 6000);
  assert.deepEqual(notification.payload.allowed_mentions, { parse: [] });
  assert.equal(notification.fullText.length, 20000);
  assert.match(embed.fields[1].value, /test/);
});

test('contenu absent, date invalide et base64', () => {
  const empty = buildNotification({ id: 1, date: 'invalid' }, config());
  assert.match(empty.payload.embeds[0].description, /non lu/);
  assert.equal(empty.payload.embeds[0].timestamp, undefined);
  const encoded = buildNotification({ id: 2, content: Buffer.from('<p>Bonjour</p>').toString('base64') }, { ...config(), encoding: 'base64' });
  assert.equal(encoded.payload.embeds[0].description, 'Bonjour');
});

test('Discord : wait=true, 429 puis confirmation et fil', async () => {
  const calls = []; const delays = [];
  const discord = new Discord({ ...config(), threadId: '1234' }, async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? json({ retry_after: 0.5 }, 429) : json({ id: 'discord-id' });
  }, async delay => delays.push(delay));
  await discord.send({ id: 1 });
  assert.equal(calls[0].url.searchParams.get('wait'), 'true');
  assert.equal(calls[0].url.searchParams.get('thread_id'), '1234');
  assert.deepEqual(delays, [600]);
});

test('Discord : envoi long multipart et échec sans confirmation', async () => {
  const discord = new Discord(config(), async (_url, options) => {
    assert.ok(options.body instanceof FormData);
    assert.equal(await options.body.get('files[0]').text(), 'x'.repeat(5000));
    return json({ id: 'ok' });
  });
  await discord.send({ id: 1, content: 'x'.repeat(5000) });
  discord.fetch = async () => new Response(null, { status: 204 });
  await assert.rejects(discord.send({ id: 1 }), /confirmation/);
  discord.fetch = async () => json({}, 500);
  await assert.rejects(discord.send({ id: 1 }), /500/);
});

test('état persistant : ordre, dédoublonnage après redémarrage et isolation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ed-discord-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = config(); const file = path.join(dir, 'state.json');
  const state = new State(file); await state.load();
  const sent = [];
  const ed = { id: 2, unreadMessages: async () => [{ id: 2 }, { id: 1 }, { id: 1 }] };
  const discord = { send: async message => sent.push(message.id) };
  const deps = { config: cfg, state, ed, discord };
  assert.equal((await pollOnce(deps)).sent, 2);
  assert.deepEqual(sent, [1, 2]);
  const reloaded = new State(file); await reloaded.load();
  assert.equal((await pollOnce({ ...deps, state: reloaded })).sent, 0);
  assert.equal(reloaded.has(scopeFor({ ...cfg, profile: 'P' }, 2), 1), false);
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('secret') && !raw.includes('test-token'));
  await writeFile(file, '{broken');
  await assert.rejects(new State(file).load(), /JSON invalide/);
});

test('échec Discord : message non mémorisé puis repris au cycle suivant', async () => {
  const sent = new Set(); const cfg = config();
  const deps = { config: cfg, ed: { id: 1, unreadMessages: async () => [{ id: 1 }] },
    state: { has: (_scope, id) => sent.has(id), mark: async (_scope, id) => sent.add(id) },
    discord: { send: async () => { throw new Error('HTTP 500'); } } };
  await assert.rejects(pollOnce(deps), /500/);
  assert.equal(sent.size, 0);
  deps.discord.send = async () => {};
  assert.equal((await pollOnce(deps)).sent, 1);
});

test('échec persistance fatal et arrêt avant le message suivant', async () => {
  const deps = { config: config(), ed: { id: 1, unreadMessages: async () => [{ id: 1 }] },
    state: { has: () => false, mark: async () => { throw new Error('disk full'); } }, discord: { send: async () => {} } };
  await assert.rejects(pollOnce(deps), StateWriteError);
  assert.equal((await pollOnce({ ...deps, shouldStop: () => true })).sent, 0);
});
