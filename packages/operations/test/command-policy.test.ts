// The command role's policy against the calls the operations make in a member account (packaging design §5).
import { describe, expect, it } from 'vitest';
import { ACCOUNT, FORWARDER_CALLS, allows, role } from './command-policy.js';

describe('the command role\'s policy', () => {
  it('allows every call the forwarder\'s installation and removal make, and passes router roles to EventBridge only as such', () => {
    for (const [action, resource, context] of FORWARDER_CALLS) expect(allows(action, resource, context), `${action} ${resource}`).toBe(true);
    // Never a role outside the routers' path, never to another service than those the routers use.
    expect(allows('iam:PassRole', `arn:aws:iam::${ACCOUNT}:role/Admin`, { 'iam:PassedToService': 'events.amazonaws.com' })).toBe(false);
    expect(allows('iam:PassRole', role, { 'iam:PassedToService': 'ec2.amazonaws.com' })).toBe(false);
    expect(allows('iam:CreateRole', role)).toBe(false);
    expect(allows('events:PutRule', `arn:aws:events:eu-west-3:${ACCOUNT}:rule/customer-rule`)).toBe(false);
  });
});
