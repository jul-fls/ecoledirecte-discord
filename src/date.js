const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    numberingSystem: 'latn',
  }));
  return formatters.get(timeZone);
}

function localParts(epoch, timeZone) {
  return Object.fromEntries(formatter(timeZone).formatToParts(new Date(epoch))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function asUtc(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

// ED renvoie généralement une heure civile sans fuseau : 2026-10-05 09:30:00.
// La convertir en instant UTC avant Discord, indépendamment du TZ du conteneur.
export function messageTimestamp(raw, timeZone = 'Europe/Paris') {
  if (typeof raw !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(raw.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = '0', fraction = '', zone] = match;
  const parts = { year: +year, month: +month, day: +day, hour: +hour, minute: +minute, second: +second };
  if (parts.year < 1000) return undefined;
  const nominal = asUtc(parts);
  const date = new Date(nominal);
  if (date.getUTCFullYear() !== parts.year || date.getUTCMonth() + 1 !== parts.month
      || date.getUTCDate() !== parts.day || date.getUTCHours() !== parts.hour
      || date.getUTCMinutes() !== parts.minute || date.getUTCSeconds() !== parts.second) return undefined;
  if (zone) {
    // Un fuseau explicite fourni par ED fait autorité ; ne pas le corriger deux fois.
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second.padStart(2, '0')}${fraction ? `.${fraction}` : ''}${zone.toUpperCase()}`;
    const epoch = Date.parse(iso);
    return Number.isNaN(epoch) ? undefined : new Date(epoch).toISOString();
  }
  const offsets = new Set();
  // Échantillonner les deux côtés d'une éventuelle transition été/hiver.
  for (const delta of [-36, 0, 36]) {
    const sample = nominal + delta * 3600000;
    offsets.add(asUtc(localParts(sample, timeZone)) - sample);
  }
  const candidates = [...offsets].map(offset => nominal - offset).filter(epoch => {
    const actual = localParts(epoch, timeZone);
    return Object.keys(parts).every(key => actual[key] === parts[key]);
  });
  // Une heure inexistante au passage à l'été est omise plutôt que décalée.
  if (!candidates.length) return undefined;
  // Au passage à l'hiver, une heure répétée sans offset reste ambiguë : premier instant.
  return new Date(Math.min(...candidates) + Number(fraction.padEnd(3, '0'))).toISOString();
}
