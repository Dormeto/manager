// The routers the manager knows: written in Terraform (the module's routers), then installed by the manager (operations),
// each with a unique name (the AWS name is the same in every region).
import type { InstalledRouter } from '@dormeto/operations';

export interface TerraformRouter { name: string; region: string; controller: string; account?: string }
export interface FleetRouter {
  name: string;
  region: string;
  controller: string;
  account?: string; // the manager's account until routers run in other accounts (onboarding, R4)
  source?: 'terraform' | 'manager'; // written in Terraform, or installed by the manager (operations)
  installed?: { version: string; build: string; at: string }; // what the manager's last install or upgrade put there
}

export function fleetRouters(terraform: TerraformRouter[], installed: InstalledRouter[], managerAccount: string | undefined): FleetRouter[] {
  return [
    ...terraform.map((r) => ({ ...r, source: 'terraform' as const })),
    ...installed.filter((i) => !terraform.some((t) => (t.account ?? managerAccount) === i.account && t.region === i.region)).map((i) => ({
      name: `${i.name}${i.account === managerAccount ? '' : `-${i.account}`}-${i.region}`, region: i.region, controller: i.controller, account: i.account, source: 'manager' as const,
      installed: { version: i.version, build: i.build, at: i.installedAt },
    })),
  ];
}
