# Development

Building, testing and running the manager in a development environment, and releasing it. The design notes live in the Dormeto/vision repository (private): the manager MVP design (`docs/specs/2026-10-04-manager-mvp-design.md`) and its target architecture (`docs/architecture/manager.md`).

## Environments

| Environment | Dashboard | Sign-in | Routers |
|---|---|---|---|
| `dev` | `https://app.dev.dormeto.com` | `https://auth.app.dev.dormeto.com` | `dmt-dev` |

Roles come from the Cognito groups: `dmt-viewer` (read), `dmt-operator` (nap, wake), `dmt-admin` (users, audit).
Users are invited by administrators; the first administrators are listed in `env/<env>.local.tfvars` (not committed).

## Usage

Requirements: Node.js ≥ 24, Terraform 1.16.5 (tfenv reads `.terraform-version`), AWS CLI v2, profile
`kloudy-dormeto-prd`.

```bash
npm install
npm test && npm run typecheck
npm run build                                   # API, discovery and operations bundles, dashboard (published by Terraform)
(cd ../router && npm run package)               # the router bundle the manager installs (sibling repository)
npm run artifacts                               # dist/artifacts: the module's layout, as a release carries it
cd infra/terraform/platform
echo 'admin_emails = ["you@example.com"]' > env/dev.local.tfvars
tfenv exec init -backend-config=env/dev.backend.hcl
tfenv exec plan -var-file=env/dev.tfvars -var-file=env/dev.local.tfvars -out=dev.tfplan
tfenv exec apply dev.tfplan
cd ../../.. && node scripts/smoke.mjs --env dev  # API checks as the smoke user
npm run dev -w @dormeto/manager-dashboard       # local dashboard on http://localhost:5173 against the dev API
npm run dev:mock -w @dormeto/manager-dashboard  # the dashboard with demo data, no sign-in (development only)
# its organization is generated: http://localhost:5173/?demo=acme,workloads=60,routers=5 (or VITE_MOCK_SCENARIO), see src/mock/scenario.ts
```

Screenshots of the dashboard (the website's, for example), signed in as the smoke user, with example values in place of
real identifiers (account ids, email addresses, organization ids, and the names listed in a mask file kept outside the
repository: `{ "replacements": [["real name", "Example"]] }`); an image where one remains is not written:

```bash
node scripts/screenshots.mjs --env dev --width 1280 --height 800 --scale 2 --format webp --theme dark \
  --mask ~/dormeto-mask.json --out /tmp/shots --route / --route /discovery
```

While SES is in the sandbox, an invited address must be a verified SES identity: inviting from the dashboard creates
the identity (AWS sends a verification email), and the administrator resends the invitation once it is verified.

## Release

A release is built from a commit whose `package.json` names the new version (and `dormeto.router` the router it
carries, built in the sibling repository), with its section in `CHANGELOG.md`:

```bash
(cd ../router && npm run package)
AWS_PROFILE=kloudy-dormeto-prd node scripts/release/release.mjs --publish --bucket dmt-releases-121014831971
```

It builds, assembles `dist/release/<version>/` (the module archive with its artifacts, the access and organization
modules, the AWS CLI script, the organization policy, `SHA256SUMS`, the changelog section), refuses a version already
published, uploads it to `releases.dormeto.com/manager/<version>/`, moves `latest.json` forward and tags `v<version>`
(pushed with the commits). Then update the website's pages to the new version.

The Dormeto CLI (the savings estimate in Go, `../cli`) is pinned to the product's Node code by shared cases this
repository writes. After any change to the idle window replay (`packages/fleet/src/idle.ts`), the prices
(`prices.ts`, `savings.ts`, `packages/api/src/spot.ts`), discovery's scan (`packages/discovery/src/scan.ts`,
`kubernetes.ts`, `filters.ts`, `org.ts`) or the router's description of what a nap stops (`../router`
`lambda/src/lib/stopped.mjs`, `kubernetes.mjs`), and before each release, export them again from a committed tree
(the cases name its commit) with `../router` at the router the manager carries, and commit them in the CLI:

```bash
node scripts/parity/export.mjs --out ../cli/testdata/parity
(cd ../cli && git add testdata/parity && git commit -m "test: shared cases exported from manager $(git -C ../manager rev-parse --short HEAD)")
```

A result that changed then fails the CLI's tests until its Go code is ported, and the CLI's release refuses cases older
than the manager's latest release. The corpus is `scripts/parity/cases/`; `npm test` checks the export (deterministic,
every case replayed from its recorded answers alone).
