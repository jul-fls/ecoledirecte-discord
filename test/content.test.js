import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { EcoleDirecte } from '../src/ecoledirecte.js';
import { Discord } from '../src/discord.js';
import { pollOnce } from '../src/poller.js';

const config = () => readConfig({ ECOLEDIRECTE_IDENTIFIANT: 'test', ECOLEDIRECTE_MDP: 'secret',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/test-token' });
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const fileResponse = (data = 'pdf bytes', headers = {}) => new Response(data, {
  headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="rapport.pdf"', ...headers },
});

test('détail base64, restauration non lu, téléchargement binaire et multipart Discord', async () => {
  const calls = [];
  const responses = [json({ code: 200, data: { content: Buffer.from('<p>Bonjour école</p>').toString('base64'),
    subject: 'Rapport', files: [{ id: 8, libelle: 'document' }] } }), json({ code: 200 }), fileResponse()];
  const ed = new EcoleDirecte(config(), async (url, options) => { calls.push({ url, options }); return responses.shift(); });
  ed.token = 'token'; ed.id = 42; ed.messagesYear = '2026-2027';
  const message = await ed.prepareMessage({ id: 7, from: { nom: 'Prof' } });
  assert.equal(calls[0].url.pathname, '/v3/personnels/42/messages/7.awp');
  assert.equal(calls[0].url.searchParams.get('mode'), 'destinataire');
  assert.equal(JSON.parse(calls[1].options.body.get('data')).action, 'marquerCommeNonLu');
  assert.equal(calls[2].url.pathname, '/v3/telechargement.awp');
  assert.equal(calls[2].url.searchParams.get('fichierId'), '8');
  assert.equal(calls[2].url.searchParams.get('leTypeDeFichier'), 'PIECE_JOINTE');
  assert.equal(calls[2].options.headers['X-Token'], 'token');
  assert.equal(message.content, '<p>Bonjour école</p>');
  assert.equal(message.read, false);
  const discord = new Discord(config(), async (_url, options) => {
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('files[0]').name, 'rapport.pdf');
    assert.equal(await options.body.get('files[0]').text(), 'pdf bytes');
    const payload = JSON.parse(options.body.get('payload_json'));
    assert.equal(payload.embeds[0].description, 'Bonjour école');
    assert.deepEqual(payload.attachments, [{ id: 0, filename: 'rapport.pdf' }]);
    return json({ id: 'discord-id' });
  });
  await discord.send(message);
});

test('détail perdu : tenter la restauration en non lu même si le GET échoue', async () => {
  const calls = [];
  const ed = new EcoleDirecte(config(), async (_url, options) => {
    const data = JSON.parse(options.body.get('data')); calls.push(data);
    if (calls.length === 1) throw new Error('timeout');
    return json({ code: 200 });
  });
  ed.token = 't'; ed.id = 1;
  await assert.rejects(ed.messageDetail({ id: 3 }), /timeout/);
  assert.equal(calls[1].action, 'marquerCommeNonLu');
});

test('contenu manquant : erreur explicite après restauration, aucun message de remplacement', async () => {
  const responses = [json({ code: 200, data: { subject: 'hello' } }), json({ code: 200 })];
  const ed = new EcoleDirecte(config(), async () => responses.shift()); ed.token = 't'; ed.id = 1;
  await assert.rejects(ed.prepareMessage({ id: 3 }), /contenu.*absent/);
});

test('téléchargement ED : code 403 dans X-Code refusé malgré HTTP 200', async () => {
  const ed = new EcoleDirecte(config(), async () => fileResponse('error', { 'X-Code': '403' })); ed.token = 't'; ed.id = 1;
  await assert.rejects(ed.downloadAttachment({ id: 4 }, { id: 1 }, 100), /téléchargement.*API 403/);
});

test('taille fichier contrôlée avec et sans Content-Length', async () => {
  const ed = new EcoleDirecte(config(), async () => fileResponse('123456', { 'Content-Length': '6' })); ed.token = 't';
  await assert.rejects(ed.downloadAttachment({ id: 4 }, {}, 5), /volumineuse/);
  ed.fetch = async () => fileResponse('123456');
  await assert.rejects(ed.downloadAttachment({ id: 4 }, {}, 5), /volumineuse/);
});

test('vrai nom UTF-8 reçu et aucune URL de pièce jointe distante suivie', async () => {
  let requested;
  const ed = new EcoleDirecte(config(), async url => { requested = url;
    return fileResponse('data', { 'Content-Disposition': "attachment; filename*=UTF-8''%C3%A9cole.pdf" });
  }); ed.token = 't';
  const file = await ed.downloadAttachment({ id: 4, url: 'https://other.example/secret' }, {}, 100);
  assert.equal(file.filename, 'école.pdf');
  assert.equal(requested.hostname, 'apip.ecoledirecte.com');
});

test('téléchargement expiré : reconnexion puis nouvel essai borné', async () => {
  let login = 0; let calls = 0;
  const ed = new EcoleDirecte(config(), async (_url, options) => {
    calls++;
    if (calls === 1) return fileResponse('expired', { 'X-Code': '520' });
    assert.equal(options.headers['X-Token'], 'new'); return fileResponse();
  }); ed.token = 'old'; ed.login = async () => { login++; ed.token = 'new'; };
  await ed.downloadAttachment({ id: 4 }, {}, 100);
  assert.equal(login, 1); assert.equal(calls, 2);
});

test('pièces jointes : plusieurs lots de 10, confirmation de toutes les parties', async () => {
  const calls = [];
  const discord = new Discord(config(), async (_url, options) => {
    calls.push(options.body); return json({ id: String(calls.length) });
  });
  await discord.send({ id: 1, content: 'Texte complet', attachments: Array.from({ length: 12 }, (_, i) =>
    ({ filename: `f${i}.txt`, blob: new Blob(['hello']) })) });
  assert.equal(calls.length, 2);
  assert.equal([...calls[0].keys()].filter(key => key.startsWith('files[')).length, 10);
  assert.equal([...calls[1].keys()].filter(key => key.startsWith('files[')).length, 2);
  assert.match(JSON.parse(calls[1].get('payload_json')).content, /Partie 2\/2/);
});

test('noms identiques et texte long : pièces jointes toutes conservées', async () => {
  const discord = new Discord(config(), async (_url, options) => {
    const names = ['files[0]', 'files[1]', 'files[2]'].map(key => options.body.get(key).name);
    assert.deepEqual(names, ['message-ecoledirecte.txt', 'f.txt', '1-f.txt']);
    assert.equal(await options.body.get('files[0]').text(), 'x'.repeat(5000));
    return json({ id: 'ok' });
  });
  await discord.send({ id: 1, content: 'x'.repeat(5000), attachments: [
    { filename: 'f.txt', blob: new Blob(['1']) }, { filename: 'f.txt', blob: new Blob(['2']) },
  ] });
});

test('échec téléchargement : aucun envoi Discord ni passage définitif en lu', async () => {
  const calls = [];
  const ed = { unreadMessages: async () => [{ id: 1 }], prepareMessage: async () => { throw new Error('download error'); },
    markAsRead: async () => calls.push('read') };
  await assert.rejects(pollOnce({ ed, discord: { send: async () => calls.push('send') } }), /download/);
  assert.deepEqual(calls, []);
});

test('toutes les parties Discord doivent réussir avant le passage définitif en lu', async () => {
  let posts = 0; let read = 0;
  const message = { id: 1, content: 'hi', attachments: Array.from({ length: 11 }, (_, i) =>
    ({ filename: `${i}.txt`, blob: new Blob(['hi']) })) };
  const discord = new Discord(config(), async () => { posts++; return posts === 1 ? json({ id: 'ok' }) : new Response('', { status: 500 }); });
  const ed = { unreadMessages: async () => [{ id: 1 }], prepareMessage: async () => message, markAsRead: async () => read++ };
  await assert.rejects(pollOnce({ ed, discord }), /500/);
  assert.equal(read, 0);
});
