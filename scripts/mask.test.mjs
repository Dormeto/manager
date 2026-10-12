// Example values in place of real identifiers in the dashboard's screenshots (vision website v2 design §5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleAccount, identifiers, maskText } from './mask.mjs';

const replacements = [['kloudy', 'acme'], ['kloudy-master', 'Management'], ['Kloudy SAS', 'Example Corp']];

test('listed names are replaced, the longest first', () => {
  assert.equal(maskText('kloudy-master and kloudy, Kloudy SAS', replacements), 'Management and acme, Example Corp');
});

test('an account id becomes the same 12-digit example wherever it appears; other numbers stay', () => {
  const masked = maskText('arn:aws:iam::121014831971:role/x 121014831971 1234567890123 12345678901', []);
  const example = exampleAccount('121014831971');
  assert.match(example, /^[0-9]{12}$/);
  assert.notEqual(example, '121014831971');
  assert.equal(masked, `arn:aws:iam::${example}:role/x ${example} 1234567890123 12345678901`);
  assert.notEqual(exampleAccount('038606077307'), example);
});

test('email addresses and organization ids become examples; example.com stays', () => {
  const masked = maskText('ops@kloudy.fr, a@example.com, o-vvk0115ixn', []);
  assert.match(masked, /^user-[0-9]{4}@example\.com, a@example\.com, o-exampleorgid$/);
  assert.equal(maskText('ops@kloudy.fr', []), maskText('ops@kloudy.fr', []));
});

test('identifiers before masking are gone after it', () => {
  const page = 'Account 121014831971 (kloudy-master) by fabrice@kloudy.fr in o-vvk0115ixn; ok@example.com';
  const found = identifiers(page, replacements);
  assert.deepEqual(found.sort(), ['121014831971', 'fabrice@kloudy.fr', 'kloudy', 'kloudy-master', 'o-vvk0115ixn'].sort());
  const after = maskText(page, replacements);
  assert.deepEqual(found.filter((id) => after.includes(id)), []);
});

test('the functions are self-contained: the screenshot script injects their source into the page', () => {
  const inPage = new Function(`${exampleAccount}\n${maskText}\nreturn maskText;`)();
  assert.equal(inPage('121014831971', []), exampleAccount('121014831971'));
});
