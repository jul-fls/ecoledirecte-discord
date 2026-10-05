import { scopeFor } from './state.js';

export class StateWriteError extends Error {}

export async function pollOnce({ ed, discord, state, config, shouldStop = () => false }) {
  const messages = await ed.unreadMessages();
  const scope = scopeFor(config, ed.id);
  let sent = 0;
  // ED fournit les messages récents en premier ; Discord conserve l'ordre chronologique.
  for (const message of [...messages].reverse()) {
    if (shouldStop()) break;
    if (message.id == null || String(message.id) === '') throw new Error('EcoleDirecte : message sans identifiant');
    if (state.has(scope, message.id)) continue;
    await discord.send(message);
    try { await state.mark(scope, message.id); }
    catch { throw new StateWriteError('Sauvegarde anti-doublons impossible ; arrêt du service'); }
    sent++;
  }
  return { unread: messages.length, sent };
}
