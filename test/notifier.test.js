import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { EcoleDirecte } from '../src/ecoledirecte.js';
import { Discord, buildNotification, readableText } from '../src/discord.js';
import { pollOnce } from '../src/poller.js';

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

test('passage en lu : action, identifiant, année et token renouvelé', async () => {
  const calls = [];
  const ed = new EcoleDirecte(config(), async (url, options) => {
    calls.push({ url, options }); return json({ code: 200, token: 'rotated' });
  });
  ed.token = 'old'; ed.id = 42; ed.messagesYear = '2026-2027';
  await ed.markAsRead({ id: 7 });
  assert.equal(calls[0].url.pathname, '/v3/enseignants/42/messages.awp');
  assert.equal(calls[0].url.searchParams.get('verbe'), 'put');
  assert.equal(calls[0].options.headers['X-Token'], 'old');
  assert.deepEqual(JSON.parse(calls[0].options.body.get('data')), {
    action: 'marquerCommeLu', ids: [7], anneeMessages: '2026-2027',
  });
  assert.equal(ed.token, 'rotated');
});

test('expiration pendant le passage en lu : reconnexion sans renvoyer sur Discord', async () => {
  const calls = [];
  const responses = [json({ code: 525 }), gtk(),
    json({ code: 200, token: 'new', data: { accounts: [{ typeCompte: 'A', id: 77 }] } }), json({ code: 200 })];
  const ed = new EcoleDirecte(config(), async (url, options) => { calls.push({ url, options }); return responses.shift(); });
  ed.token = 'expired'; ed.id = 1;
  await ed.markAsRead({ id: 7, anneeMessages: '2026-2027' });
  assert.match(calls.at(-1).url.pathname, /enseignants\/77\//);
  assert.equal(JSON.parse(calls.at(-1).options.body.get('data')).anneeMessages, '2026-2027');
  assert.equal(calls.at(-1).options.headers['X-Token'], 'new');
});

test('ordre envoi puis lu, doublons du cycle et reprise sans fichier', async () => {
  const events = []; const read = new Set();
  const messages = [{ id: 2 }, { id: 1 }, { id: 1 }];
  const ed = {
    unreadMessages: async () => messages.filter(m => !read.has(m.id)),
    markAsRead: async m => { events.push(`read:${m.id}`); read.add(m.id); },
  };
  const discord = { send: async m => events.push(`send:${m.id}`) };
  assert.deepEqual(await pollOnce({ ed, discord }), { unread: 3, sent: 2 });
  assert.deepEqual(events, ['send:1', 'read:1', 'send:2', 'read:2']);
  assert.deepEqual(await pollOnce({ ed, discord }), { unread: 0, sent: 0 });
});

test('échec Discord : aucun passage en lu puis reprise au cycle suivant', async () => {
  const read = [];
  const deps = { ed: { unreadMessages: async () => [{ id: 1 }], markAsRead: async m => read.push(m.id) },
    discord: { send: async () => { throw new Error('HTTP 500'); } } };
  await assert.rejects(pollOnce(deps), /500/);
  assert.equal(read.length, 0);
  deps.discord.send = async () => {};
  assert.equal((await pollOnce(deps)).sent, 1);
  assert.deepEqual(read, [1]);
});

test('échec du passage en lu : cycle interrompu, message toujours non lu', async () => {
  const events = [];
  const deps = { ed: { unreadMessages: async () => [{ id: 2 }, { id: 1 }],
    markAsRead: async () => { throw new Error('EcoleDirecte : erreur 500'); } },
    discord: { send: async m => events.push(m.id) } };
  await assert.rejects(pollOnce(deps), /500/);
  assert.deepEqual(events, [1]);
  assert.equal((await pollOnce({ ...deps, shouldStop: () => true })).sent, 0);
});

test('arrêt pendant envoi : terminer le passage en lu avant de quitter', async () => {
  let stopping = false; const read = [];
  const deps = { ed: { unreadMessages: async () => [{ id: 2 }, { id: 1 }], markAsRead: async m => read.push(m.id) },
    discord: { send: async () => { stopping = true; } }, shouldStop: () => stopping };
  assert.equal((await pollOnce(deps)).sent, 1);
  assert.deepEqual(read, [1]);
});

test('HTTP 403 au bootstrap : étape identifiée, sans divulguer le corps', async () => {
  const ed = new EcoleDirecte(config(), async (_url, options) => {
    assert.equal(options.headers.Origin, 'https://www.ecoledirecte.com');
    assert.equal(options.headers.Referer, 'https://www.ecoledirecte.com/');
    assert.equal(options.headers['Content-Type'], undefined);
    return new Response('<html>secret-cookie</html>', { status: 403, headers: { 'Content-Type': 'text/html' } });
  });
  await assert.rejects(ed.login(), error => /initialisation GTK : HTTP 403.*HTML/.test(error.message)
    && !error.message.includes('secret-cookie'));
});

test('HTTP 403 à la connexion distinct d’une erreur API 403', async () => {
  let responses = [gtk(), json({ message: 'secret' }, 403)];
  const ed = new EcoleDirecte(config(), async () => responses.shift());
  await assert.rejects(ed.login(), /connexion : HTTP 403/);
  responses = [gtk(), json({ code: 403, message: 'secret' })];
  await assert.rejects(ed.login(), error => /connexion : API 403/.test(error.message) && !error.message.includes('secret'));
});

test('HTTP 403 à la messagerie : pas de login supplémentaire', async () => {
  let calls = 0;
  const ed = new EcoleDirecte(config(), async () => { calls++; return json({}, 403); });
  ed.token = 'token'; ed.id = 42;
  await assert.rejects(ed.unreadMessages(), /lecture des messages : HTTP 403/);
  assert.equal(calls, 1);
});

test('cookies de session conservés et actualisés pour profil et messagerie', async () => {
  const calls = [];
  const login = json({ code: 200, token: 'base', data: { accounts: [{ typeCompte: 'P', id: 1 }] } });
  login.headers.append('Set-Cookie', 'SESSION=renewed; Path=/; HttpOnly');
  const switched = json({ code: 200, token: 'new', data: { id: 2 } });
  switched.headers.append('Set-Cookie', 'SESSION=switched; Path=/');
  const responses = [gtk(), login, switched, json({ code: 200, data: { messages: { received: [] } } })];
  const ed = new EcoleDirecte(config(), async (_url, options) => { calls.push(options); return responses.shift(); });
  await ed.unreadMessages();
  assert.equal(calls[2].headers.Cookie, 'GTK=test-gtk; SESSION=renewed');
  assert.equal(calls[3].headers.Cookie, 'GTK=test-gtk; SESSION=switched');
  assert.equal(calls[3].headers.Origin, 'https://www.ecoledirecte.com');
});

test('code API non numérique non propagé comme texte distant', async () => {
  const ed = new EcoleDirecte(config(), async () => json({ code: 'secret-token' }));
  await assert.rejects(ed.request(new URL('https://api.ecoledirecte.com'), {}), error =>
    error.message.includes('inconnu') && !error.message.includes('secret-token'));
});
