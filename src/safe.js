// Sanitizers for untrusted paste content.
// Everything here treats the paste as attacker-controlled text that will end up
// as a process argument and a filename on disk.

const WINDOWS_RESERVED =
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/**
 * Turn an arbitrary string into a filename that is safe to hand to IDMan.exe.
 * Whitelist only; anything outside [A-Za-z0-9._-] becomes "_".
 * Returns null if nothing usable survives.
 */
export function safeFilename(raw) {
  if (typeof raw !== 'string') return null;

  let name = raw;
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep raw if it is not valid percent-encoding
  }

  // Drop any directory component an attacker tried to smuggle in.
  name = name.split(/[\/]/).pop() ?? '';
  name = name.replace(/[^A-Za-z0-9._-]/g, '_');
  name = name.replace(/^[._]+/, '').replace(/[._]+$/, '');
  name = name.slice(0, 180);

  if (!name) return null;
  if (name.includes('..')) name = name.replace(/\.{2,}/g, '.');
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return name;
}

/**
 * Accept only plain http/https URLs with no embedded credentials.
 * Returns a normalized URL string, or null if the link must be rejected.
 */
export function safeUrl(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.startsWith('\\')) return null; // UNC path

  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  return u.toString();
}
