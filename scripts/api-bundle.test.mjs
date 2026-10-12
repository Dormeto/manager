// The API bundles the Cognito client (review of R6c, I3): AdminDeleteSoftwareToken (August 2026) must not depend on the
// SDK version of the Lambda runtime; an ESM bundle of the SDK needs a require.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the API bundle carries the Cognito client, with a require for its CommonJS parts', () => {
  const build = JSON.parse(readFileSync(new URL('../packages/api/package.json', import.meta.url), 'utf8')).scripts.build.split(' && ')[0];
  assert.doesNotMatch(build, /--external:@aws-sdk\/\*|client-cognito-identity-provider/);
  assert.match(build, /--banner:js=import \{ createRequire \} from 'node:module'; const require = createRequire\(import\.meta\.url\);/);
});
