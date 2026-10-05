export async function pollOnce({ ed, discord, shouldStop = () => false }) {
  const messages = await ed.unreadMessages();
  let sent = 0;
  const processed = new Set();
  // ED fournit les messages récents en premier ; Discord conserve l'ordre chronologique.
  for (const message of [...messages].reverse()) {
    if (shouldStop()) break;
    if (message.id == null || String(message.id) === '') throw new Error('EcoleDirecte : message sans identifiant');
    if (processed.has(String(message.id))) continue;
    await discord.send(message);
    // Même en cas de SIGTERM pendant l'envoi, terminer le passage en lu du message envoyé.
    await ed.markAsRead(message);
    processed.add(String(message.id));
    sent++;
  }
  return { unread: messages.length, sent };
}
