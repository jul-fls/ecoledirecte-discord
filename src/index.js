import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig } from './config.js';
import { EcoleDirecte } from './ecoledirecte.js';
import { Discord } from './discord.js';
import { pollOnce } from './poller.js';

const log = (level, message, extra = {}) => console[level](JSON.stringify({
  time: new Date().toISOString(), level, message, ...extra,
}));
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  log('info', 'Arrêt demandé, fin du cycle en cours'); stop.abort();
});

async function main() {
  const config = readConfig();
  const dependencies = { ed: new EcoleDirecte(config), discord: new Discord(config),
    shouldStop: () => stop.signal.aborted };
  log('info', 'Service démarré', { profile: config.profile, intervalSeconds: config.intervalMs / 1000 });
  while (!stop.signal.aborted) {
    const started = Date.now();
    try {
      const result = await pollOnce(dependencies);
      log('info', 'Cycle terminé', result);
    } catch (error) {
      // Ne jamais afficher une réponse distante, un token ou une URL de webhook.
      const safeMessage = /^(EcoleDirecte|Discord) :/.test(error.message)
        ? error.message : 'Erreur réseau ou délai dépassé ; nouvel essai au prochain cycle';
      log('error', safeMessage);
    }
    // Aucun chevauchement ; au plus un cycle par intervalle, sans rafale de rattrapage.
    const delay = Math.max(1000, config.intervalMs - (Date.now() - started));
    await sleep(delay, undefined, { signal: stop.signal }).catch(error => {
      if (error.name !== 'AbortError') throw error;
    });
  }
}

main().catch(error => {
  log('error', error.message);
  process.exitCode = 1;
});
