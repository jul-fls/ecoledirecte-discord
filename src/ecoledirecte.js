// Extrait de SAC : login.script.js, helpers.common.js et DATA_URLS.APIP.MESSAGES.
const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Sec-GPC': '1',
  Origin: 'https://www.ecoledirecte.com',
  Referer: 'https://www.ecoledirecte.com/',
};

class EdError extends Error {
  constructor(code, operation, source, format = '') {
    const help = source === 'HTTP' && code === 403
      ? ' ; accès HTTP refusé, vérifier le réseau et le filtrage côté EcoleDirecte'
      : source === 'API' && code === 250
        ? ' ; validation de connexion requise (double authentification/question de sécurité)'
        : '';
    super(`EcoleDirecte : ${operation} : ${source} ${code}${format ? ` (${format})` : ''}${help}`);
    this.code = code;
    this.source = source;
  }
}

function decodeContent(content) {
  if (typeof content !== 'string') throw new Error('EcoleDirecte : contenu du message absent ou invalide');
  if (!content || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) return content;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content, 'base64'));
    return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded) ? content : decoded;
  } catch { return content; }
}

export function safeFilename(name) {
  return String(name || 'piece-jointe').replace(/[\x00-\x1f\x7f/\\:"<>|?*]/g, '_').slice(0, 200) || 'piece-jointe';
}

export class EcoleDirecte {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
    this.cookies = new Map();
    this.profile = null;
  }

  rememberCookies(response) {
    for (const cookie of response.headers.getSetCookie?.() || []) {
      const pair = cookie.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  cookieHeaders() {
    return this.cookies.size ? { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {};
  }

  async checkHttp(response, operation) {
    if (response.ok) return;
    const type = response.headers.get('content-type') || '';
    const format = /html/i.test(type) ? 'réponse HTML' : /json/i.test(type) ? 'réponse JSON' : 'réponse non JSON';
    // Ne pas copier le corps ni les en-têtes distants dans l'erreur : ils peuvent contenir des secrets.
    throw new EdError(response.status, operation, 'HTTP', format);
  }

  async request(url, data, extraHeaders = {}, operation = 'requête API') {
    const response = await this.fetch(url, {
      method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded',
        ...this.cookieHeaders(), ...extraHeaders },
      body: new URLSearchParams({ data: JSON.stringify(data) }),
      signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'error',
    });
    await this.checkHttp(response, operation);
    this.rememberCookies(response);
    let result;
    try { result = await response.json(); } catch { throw new Error(`EcoleDirecte : ${operation} : réponse JSON invalide`); }
    if (result?.code !== 200) {
      const code = Number.isInteger(result?.code) ? result.code : 'inconnu';
      throw new EdError(code, operation, 'API');
    }
    return result;
  }

  url(base, endpoint, params = {}) {
    const url = new URL(`${base}/${endpoint}`);
    url.search = new URLSearchParams({ v: this.config.version, ...params });
    return url;
  }

  async login() {
    this.token = null;
    this.profile = null;
    this.cookies.clear();
    const response = await this.fetch(this.url(this.config.api, 'login.awp', { gtk: '1' }), {
      headers: HEADERS, signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'error',
    });
    await this.checkHttp(response, 'initialisation GTK');
    this.rememberCookies(response);
    // getSetCookie évite de confondre les attributs Path/Expires avec des cookies.
    const cookies = (response.headers.getSetCookie?.() || [])
      .map(cookie => cookie.split(';', 1)[0]);
    const gtkCookie = cookies.find(cookie => /^gtk=/i.test(cookie));
    if (!gtkCookie) throw new Error('EcoleDirecte : cookie GTK absent');
    const gtk = gtkCookie.slice(gtkCookie.indexOf('=') + 1);
    const result = await this.request(this.url(this.config.api, 'login.awp'), {
      identifiant: this.config.identifier, motdepasse: this.config.password,
      isReLogin: false, uuid: '', fa: [],
    }, { 'X-Gtk': gtk, Cookie: cookies.join('; ') }, 'connexion');
    const accounts = result.data?.accounts;
    if (!Array.isArray(accounts)) throw new Error('EcoleDirecte : liste de comptes absente');
    const account = this.config.accountId
      ? accounts.find(a => String(a.id) === this.config.accountId || String(a.uid) === this.config.accountId)
      : accounts.find(a => a.typeCompte === this.config.profile)
        || accounts.find(a => ['P', 'A'].includes(a.typeCompte));
    if (!account || !['P', 'A'].includes(account.typeCompte) || !result.token) {
      throw new Error('EcoleDirecte : compte P/A ou token introuvable (vérifier ECOLEDIRECTE_ACCOUNT_ID)');
    }
    let token = result.token;
    let id = account.id;
    let profile = account.typeCompte;
    if (account.typeCompte !== this.config.profile) {
      const switched = await this.request(this.url(this.config.api, 'renewtoken.awp', { verbe: 'put' }), {
        profil: this.config.profile, uid: account.uid ?? account.id, uuid: '',
      }, { 'X-Token': token }, `changement de profil vers ${this.config.profile}`);
      token = switched.token;
      id = switched.data?.id;
      profile = switched.data?.typeCompte || this.config.profile;
      if (profile !== this.config.profile) {
        throw new Error('EcoleDirecte : changement de profil non confirmé par le serveur');
      }
    }
    if (!token || id == null) throw new Error('EcoleDirecte : profil sans token ou identifiant');
    this.id = id;
    this.token = token;
    this.profile = profile;
  }

  messageEndpoint(id) {
    // Correspondance du client web officiel : A = personnel, P = enseignant.
    const routes = { A: 'personnels', P: 'enseignants' };
    const route = routes[this.profile || this.config.profile];
    if (!route) throw new Error('EcoleDirecte : profil de messagerie non pris en charge');
    return `${route}/${encodeURIComponent(id)}/messages.awp`;
  }

  async authenticatedRequest(endpoint, data, params, operation) {
    // Une reconnexion au maximum par opération, avec reconstruction de l'URL.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.token) await this.login();
      try {
        const result = await this.request(this.url(this.config.apip, endpoint(this.id), params),
          data, { 'X-Token': this.token }, operation);
        if (result.token) this.token = result.token;
        return result;
      } catch (error) {
        // Un HTTP 403 peut être un refus réseau/filtrage : un nouveau login ne le résout pas.
        if (!(error instanceof EdError) || ![520, 521, 525, 401].includes(error.code)) throw error;
        this.token = null;
        if (attempt === 1) throw error;
      }
    }
  }

  async unreadMessages() {
    const result = await this.authenticatedRequest(
      id => this.messageEndpoint(id),
      { anneeMessages: this.config.messagesYear || '' }, {
        force: 'true', typeRecuperation: 'received', idClasseur: '0',
        orderBy: 'date', order: 'desc', query: '', onlyRead: '', getAll: '1', verbe: 'get',
      }, 'lecture des messages');
    this.messagesYear = result.data?.anneeMessages || this.config.messagesYear || '';
    const messages = result.data?.messages?.received;
    if (!Array.isArray(messages)) throw new Error('EcoleDirecte : format de messagerie inattendu');
    return messages.filter(message => message.read === false);
  }

  async markAsRead(message) {
    if (message.id == null || String(message.id) === '') throw new Error('EcoleDirecte : message sans identifiant');
    // Même action que le bouton « Marquer comme lu », sans ouvrir le détail avant l'envoi Discord.
    await this.authenticatedRequest(
      id => this.messageEndpoint(id), {
        action: 'marquerCommeLu', ids: [message.id],
        anneeMessages: message.anneeMessages || this.messagesYear || this.config.messagesYear || '',
      }, { verbe: 'put' }, 'passage du message en lu');
  }

  async markAsUnread(message) {
    await this.authenticatedRequest(id => this.messageEndpoint(id), {
      action: 'marquerCommeNonLu', ids: [message.id],
      anneeMessages: message.anneeMessages || this.messagesYear || this.config.messagesYear || '',
    }, { verbe: 'put' }, 'restauration du message en non lu');
  }

  async messageDetail(message) {
    let result;
    try {
      result = await this.authenticatedRequest(id => this.messageEndpoint(id)
        .replace(/messages\.awp$/, `messages/${encodeURIComponent(message.id)}.awp`), {
          anneeMessages: message.anneeMessages || this.messagesYear || this.config.messagesYear || '',
        }, { verbe: 'get', mode: 'destinataire' }, 'récupération du contenu du message');
    } finally {
      // Le GET de détail ED peut marquer lu, même si la réponse est perdue.
      // Restaurer avant tout téléchargement/envoi, également lorsque le GET échoue.
      await this.markAsUnread(message);
    }
    const detail = result.data;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('EcoleDirecte : détail du message invalide');
    return { ...message, ...detail, id: message.id, read: false,
      anneeMessages: message.anneeMessages || this.messagesYear || this.config.messagesYear || '',
      content: decodeContent(detail.content), contentEncoding: 'plain' };
  }

  async downloadAttachment(file, message, maxBytes) {
    if (file.id == null || String(file.id) === '') throw new Error('EcoleDirecte : pièce jointe sans identifiant');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.token) await this.login();
      const response = await this.fetch(this.url(this.config.apip, 'telechargement.awp', {
        verbe: 'get', fichierId: String(file.id), leTypeDeFichier: 'PIECE_JOINTE',
      }), {
        method: 'POST', headers: { ...HEADERS, ...this.cookieHeaders(), 'X-Token': this.token,
          'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: JSON.stringify({ forceDownload: 0,
          anneeMessages: message.anneeMessages || this.messagesYear || this.config.messagesYear || '',
        }) }), signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'error',
      });
      const edCode = Number(response.headers.get('x-code') || 200);
      if (([520, 521, 525].includes(edCode) || response.status === 401) && attempt === 0) {
        await response.body?.cancel(); this.token = null; continue;
      }
      await this.checkHttp(response, 'téléchargement de pièce jointe');
      if (edCode !== 200) {
        await response.body?.cancel();
        throw new EdError(Number.isInteger(edCode) ? edCode : 'inconnu', 'téléchargement de pièce jointe', 'API');
      }
      this.rememberCookies(response);
      const token = response.headers.get('x-token');
      if (token) this.token = token;
      const disposition = response.headers.get('content-disposition') || '';
      const utf8Name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      let serverName = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
      serverName = serverName?.[1] || serverName?.[2]?.trim();
      if (utf8Name) { try { serverName = decodeURIComponent(utf8Name); } catch { /* Utiliser le nom classique. */ } }
      let name = serverName || file.libelle || file.nom || file.name || `piece-jointe-${file.id}`;
      const extension = String(file.extension || '').replace(/^\./, '');
      if (!serverName && /^[a-z0-9]{1,10}$/i.test(extension) && !String(name).toLowerCase().endsWith(`.${extension.toLowerCase()}`)) name += `.${extension}`;
      const filename = safeFilename(name);
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      if (/text\/html/i.test(contentType) && !response.headers.get('content-disposition') && !/\.html?$/i.test(filename)) {
        await response.body?.cancel();
        throw new Error('EcoleDirecte : téléchargement de pièce jointe : page HTML reçue au lieu du fichier');
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new Error('EcoleDirecte : pièce jointe trop volumineuse (limite ATTACHMENT_MAX_MB / ATTACHMENTS_TOTAL_MAX_MB)');
      }
      if (!response.body) throw new Error('EcoleDirecte : téléchargement de pièce jointe vide');
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error('EcoleDirecte : pièce jointe trop volumineuse (limite ATTACHMENT_MAX_MB / ATTACHMENTS_TOTAL_MAX_MB)');
        }
        chunks.push(value);
      }
      return { filename, blob: new Blob(chunks, { type: contentType }) };
    }
  }

  async prepareMessage(message) {
    const detail = await this.messageDetail(message);
    const files = detail.files ?? detail.piecesJointes ?? [];
    if (!Array.isArray(files)) throw new Error('EcoleDirecte : format de pièces jointes invalide');
    const attachments = []; let total = 0;
    for (const file of files) {
      const remaining = this.config.attachmentsTotalMaxBytes - total;
      if (remaining <= 0) throw new Error('EcoleDirecte : limite totale de pièces jointes dépassée (ATTACHMENTS_TOTAL_MAX_MB)');
      const attachment = await this.downloadAttachment(file, detail, Math.min(this.config.attachmentMaxBytes, remaining));
      total += attachment.blob.size;
      attachments.push(attachment);
    }
    return { ...detail, attachments };
  }
}
