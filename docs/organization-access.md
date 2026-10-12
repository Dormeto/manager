# Organization access

Discovery reads the AWS organization from the manager account and scans each account of its perimeter through a
read-only role, `DmtDiscoveryRole`; operations act through `DmtCommandRole` (vision
`docs/architecture/organization-iam.md`). Dormeto never deploys these roles (no CloudFormation): they are created with the
Terraform modules of `infra/terraform/modules`, published with each release, and the manager supposes them there:

- `access`, in each member account: `DmtDiscoveryRole`, `DmtCommandRole` and `DmtRouterBoundary`, trusted by the manager
  roles of every environment listed in `envs` (several environments may share an account's roles). In the manager's own
  account the platform stack creates them (`create_organization_roles`); a second environment of that account sets it to
  `false` and is listed in the first one's `organization_role_envs`.
- `organization`, in the management account: the Organizations delegation policy.

Each release also publishes `dormeto-access-commands-<version>.sh`, the same with the AWS CLI (settings at its top;
`scripts/release/access-script.mjs`). Each discovery run checks both roles in every account (the command role through the access check function
`dmt-<env>-manager-access-check`, which only assumes it) and the Discovery view's Organization access panel lists what is
missing: onboarding and router installs are refused where the command role is missing.

Dev: the org stack applies `organization` in the management account and `access` in `command_account_id`
(038606077307), through that account's administrator profile `command_profile` (an account invited into the
organization has no `OrganizationAccountAccessRole`):

```bash
cd infra/terraform/org                         # acts in the management account (kloudy-master) and command_account_id
tfenv exec init -backend-config=env/dev.backend.hcl
tfenv exec plan -var-file=env/dev.tfvars -out=dev.tfplan
tfenv exec apply dev.tfplan
```

Apply it again after a router version that changes `dist/router-boundary.json`. The modules' tests run offline with a
mocked provider: `cd infra/terraform/modules/<module> && tfenv exec init -backend=false && tfenv exec test`.
