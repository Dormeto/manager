// Routers known to the manager: registered in Terraform (ROUTERS: name, region, controller, account, optional onboarder)
// and installed by the manager (registry items).
import type { RouterRef } from './engine.js';
import type { Records } from './records.js';

export interface TerraformRouter {
  name: string;
  region: string;
  controller: string; // function name in the manager's account
  account: string;
  onboarder?: string;
}

const arnOf = (r: TerraformRouter, fn: string) => (fn.startsWith('arn:') ? fn : `arn:aws:lambda:${r.region}:${r.account}:function:${fn}`);

export async function routersOf(terraform: TerraformRouter[], records: Pick<Records, 'listRouters'>): Promise<RouterRef[]> {
  const listed: RouterRef[] = terraform.map((r) => ({
    name: r.name, account: r.account, region: r.region, controller: arnOf(r, r.controller), ...(r.onboarder ? { onboarder: arnOf(r, r.onboarder) } : {}), source: 'terraform',
  }));
  for (const r of await records.listRouters()) {
    if (listed.some((x) => x.account === r.account && x.region === r.region)) continue;
    listed.push({
      name: r.name, account: r.account, region: r.region, controller: r.controller, onboarder: r.onboarder, source: 'manager', version: r.version, build: r.build,
      ...(r.uninstalling ? { uninstalling: true } : {}),
    });
  }
  return listed;
}
