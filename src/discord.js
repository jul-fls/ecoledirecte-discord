import { setTimeout as sleep } from 'node:timers/promises';

const clip = (text, length) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
const escapeMarkdown = text => text.replace(/([\\`*_{}\[\]()#+.!|>~])/g, '\\$1');

export function readableText(content) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(content || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildNotification(message, config) {
  let content = message.content || '';
  if (config.encoding === 'base64' && content) content = Buffer.from(content, 'base64').toString('utf8');
  const text = readableText(content);
  const sender = [message.from?.prenom, message.from?.nom].filter(Boolean).join(' ') || 'Expéditeur inconnu';
  const attachments = message.files || message.piecesJointes || [];
  const fields = [{ name: '✉️ Expéditeur', value: clip(escapeMarkdown(sender), 256), inline: true }];
  if (Array.isArray(attachments) && attachments.length) {
    fields.push({ name: '📎 Pièces jointes', value: clip(attachments.map(file =>
      escapeMarkdown(String(file.libelle || file.nom || file.name || 'Pièce jointe'))).join('\n'), 800) });
  }
  const escaped = escapeMarkdown(text);
  const long = escaped.length > 3500;
  const embed = {
    title: clip(`📬 ${escapeMarkdown(readableText(message.subject) || '(Sans objet)')}`, 256),
    color: 0x2563eb,
    description: text ? clip(escaped, 3500) : 'Un nouveau message non lu vous attend sur EcoleDirecte.',
    fields,
    url: 'https://www.ecoledirecte.com/',
    footer: { text: clip(`EcoleDirecte • Profil ${config.profile} • Message ${message.id}${long ? ' • Texte complet en pièce jointe' : ''}`, 256) },
  };
  if (message.date && !Number.isNaN(Date.parse(message.date))) embed.timestamp = new Date(message.date).toISOString();
  return {
    payload: { username: config.username, allowed_mentions: { parse: [] }, embeds: [embed] },
    fullText: long ? text : null,
  };
}

export class Discord {
  constructor(config, fetchImpl = fetch, sleepImpl = sleep) {
    this.config = config; this.fetch = fetchImpl; this.sleep = sleepImpl;
  }
  async send(message) {
    const notification = buildNotification(message, this.config);
    const url = new URL(this.config.webhook);
    url.searchParams.set('wait', 'true');
    if (this.config.threadId) url.searchParams.set('thread_id', this.config.threadId);
    for (let attempt = 0; attempt < 3; attempt++) {
      let body;
      let headers = {};
      if (notification.fullText) {
        body = new FormData();
        body.set('payload_json', JSON.stringify(notification.payload));
        body.set('files[0]', new Blob([notification.fullText], { type: 'text/plain;charset=utf-8' }), 'message-ecoledirecte.txt');
      } else {
        body = JSON.stringify(notification.payload);
        headers = { 'Content-Type': 'application/json' };
      }
      const response = await this.fetch(url, {
        method: 'POST', headers, body,
        signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'error',
      });
      if (response.status === 429 && attempt < 2) {
        const data = await response.json().catch(() => ({}));
        const seconds = Number(data.retry_after ?? response.headers.get('retry-after') ?? 1);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) {
          throw new Error('Discord : limitation de débit, nouvel essai au prochain cycle');
        }
        await this.sleep(Math.ceil(seconds * 1000) + 100);
        continue;
      }
      if (!response.ok) throw new Error(`Discord : HTTP ${response.status}`);
      // wait=true doit confirmer la création avant de mémoriser l'identifiant ED.
      const result = await response.json().catch(() => null);
      if (!result?.id) throw new Error('Discord : envoi sans confirmation');
      return;
    }
  }
}
