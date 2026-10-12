// Example values in place of real identifiers in the dashboard's screenshots (vision website v2 design §5).
// Self-contained functions (no import, no outer name but each other): the screenshot script injects their source into
// the page.
export function exampleAccount(id) {
  let a = 2166136261;
  let b = 5381;
  for (const c of id) {
    a = Math.imul(a ^ c.charCodeAt(0), 16777619) >>> 0;
    b = (Math.imul(b, 33) + c.charCodeAt(0)) >>> 0;
  }
  const digits = `${a}${b}`.padStart(12, '0').slice(-12);
  return digits === id ? `${digits.slice(1)}0` : digits;
}

export function maskText(text, replacements) {
  let out = text;
  for (const [from, to] of [...replacements].sort((x, y) => y[0].length - x[0].length)) out = out.split(from).join(to);
  return out
    .replace(/(?<![0-9])[0-9]{12}(?![0-9])/g, (id) => exampleAccount(id))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (email) => (email.endsWith('@example.com') ? email : `user-${exampleAccount(email).slice(0, 4)}@example.com`))
    .replace(/\bo-[a-z0-9]{10,32}\b/g, 'o-exampleorgid');
}

export function identifiers(text, replacements) {
  const found = new Set([...text.matchAll(/(?<![0-9])[0-9]{12}(?![0-9])/g)].map((m) => m[0]));
  for (const [email] of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!email.endsWith('@example.com')) found.add(email);
  for (const [org] of text.matchAll(/\bo-[a-z0-9]{10,32}\b/g)) if (org !== 'o-exampleorgid') found.add(org);
  for (const [from] of replacements) if (text.includes(from)) found.add(from);
  return [...found];
}
