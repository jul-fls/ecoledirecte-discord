import path from 'node:path';

export function readConfig(env = process.env) {
  const required = name => {
    if (!env[name]?.trim()) throw new Error(`Variable obligatoire : ${name}`);
    return env[name];
  };
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} doit être un entier entre ${min} et ${max}`);
    }
    return value;
  };
  const httpsUrl = (name, fallback) => {
    let url;
    try { url = new URL(env[name] || fallback); } catch { throw new Error(`${name} : URL invalide`); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name} : HTTPS requis`);
    return url;
  };
  const webhook = httpsUrl('DISCORD_WEBHOOK_URL', required('DISCORD_WEBHOOK_URL'));
  if (!['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(webhook.hostname)
      || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(webhook.pathname)) {
    throw new Error('DISCORD_WEBHOOK_URL doit être une URL de webhook Discord');
  }
  const profile = env.ECOLEDIRECTE_PROFILE || 'A';
  if (!['P', 'A'].includes(profile)) throw new Error('ECOLEDIRECTE_PROFILE doit être P ou A');
  const encoding = env.ECOLEDIRECTE_CONTENT_ENCODING || 'plain';
  if (!['plain', 'base64'].includes(encoding)) throw new Error('ECOLEDIRECTE_CONTENT_ENCODING doit être plain ou base64');
  const username = env.DISCORD_USERNAME || 'EcoleDirecte';
  if (username.length > 80) throw new Error('DISCORD_USERNAME : 80 caractères maximum');
  return {
    identifier: required('ECOLEDIRECTE_IDENTIFIANT'), password: required('ECOLEDIRECTE_MDP'),
    profile, accountId: env.ECOLEDIRECTE_ACCOUNT_ID || '', encoding,
    api: httpsUrl('ECOLEDIRECTE_API_BASE_URL', 'https://api.ecoledirecte.com/v3').href.replace(/\/$/, ''),
    apip: httpsUrl('ECOLEDIRECTE_APIP_BASE_URL', 'https://apip.ecoledirecte.com/v3').href.replace(/\/$/, ''),
    version: env.ECOLEDIRECTE_API_VERSION || '4.98.0', webhook: webhook.href, username,
    threadId: env.DISCORD_THREAD_ID || '',
    intervalMs: integer('POLL_INTERVAL_SECONDS', 60, 10, 86400) * 1000,
    timeoutMs: integer('REQUEST_TIMEOUT_SECONDS', 20, 1, 120) * 1000,
    stateFile: path.resolve(env.STATE_FILE || './data/state.json'),
  };
}
