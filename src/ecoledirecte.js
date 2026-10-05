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

export class EcoleDirecte {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
    this.cookies = new Map();
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
    if (!account || !result.token) throw new Error('EcoleDirecte : compte P/A ou token introuvable (vérifier ECOLEDIRECTE_ACCOUNT_ID)');
    let token = result.token;
    let id = account.id;
    if (account.typeCompte !== this.config.profile) {
      const switched = await this.request(this.url(this.config.api, 'renewtoken.awp', { verbe: 'put' }), {
        profil: this.config.profile, uid: account.uid ?? account.id, uuid: '',
      }, { 'X-Token': token }, `changement de profil vers ${this.config.profile}`);
      token = switched.token;
      id = switched.data?.id;
    }
    if (!token || id == null) throw new Error('EcoleDirecte : profil sans token ou identifiant');
    this.id = id;
    this.token = token;
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
      id => `enseignants/${encodeURIComponent(id)}/messages.awp`,
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
      id => `enseignants/${encodeURIComponent(id)}/messages.awp`, {
        action: 'marquerCommeLu', ids: [message.id],
        anneeMessages: message.anneeMessages || this.messagesYear || this.config.messagesYear || '',
      }, { verbe: 'put' }, 'passage du message en lu');
  }
}
