// Access check Lambda (packaging design §3): assumes an account's command role afresh, only to tell discovery whether it
// can be assumed. It runs as the operations role (the role trusts that one only) but does nothing else: discovery may
// invoke this function, never the operations function.
import { STSClient } from '@aws-sdk/client-sts';
import { checkHandler, checkRole } from './aws.js';

// A slow STS answers within the account step, never holding it for minutes.
const sts = new STSClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 } });

export const handler = checkHandler(checkRole({ sts, roleName: process.env.COMMAND_ROLE ?? 'DmtCommandRole', sessionName: `dmt-${process.env.ENV ?? 'dev'}-access` }));
