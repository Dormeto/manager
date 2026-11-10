import { ROUTER_MINIMUM } from '@dormeto/google/router';
import { describe, expect, it } from 'vitest';
import { GOOGLE_ROUTER_MINIMUM } from '../src/clouds.js';

describe('the Google Cloud router floor', () => {
  it('is declared equal in the fleet (the dashboard reads it) and in the Google package (the manager\'s calls)', () => {
    expect(GOOGLE_ROUTER_MINIMUM).toBe(ROUTER_MINIMUM);
  });
});
