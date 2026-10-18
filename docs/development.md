# Development

Building, testing and running the manager in a development environment, and releasing it. The design notes live in the Dormeto/vision repository (private): the manager MVP design (`docs/specs/2026-10-04-manager-mvp-design.md`) and its target architecture (`docs/architecture/manager.md`).

## Environments

| Environment | Dashboard | Sign-in | Routers |
|---|---|---|---|
| `dev` | `https://app.dev.dormeto.com` | `https://auth.app.dev.dormeto.com` | `dmt-dev` |

Roles come from the Cognito groups: `dmt-viewer` (read), `dmt-operator` (nap, wake), `dmt-admin` (users, audit).
Users are invited by administrators; the first administrators are set in the install's settings (`dev/install.json` in the install bucket, `--var` changes them).

## Usage

Requirements: Node.js ≥ 24, Terraform 1.16.5 (tfenv reads `.terraform-version`), AWS CLI v2, profile
`kloudy-dormeto-prd`.

```bash
npm install
npm test && npm run typecheck
npm run build                                   # API, discovery and operations bundles, dashboard (the release assembles them)
(cd ../router && npm run package)               # the router bundle the manager installs (sibling repository)
npm run artifacts                               # dist/artifacts: the module's layout, as a release carries it
node scripts/smoke.mjs --env dev                 # API checks as the smoke user
npm run dev -w @dormeto/manager-dashboard       # local dashboard on http://localhost:5173 against the dev API
npm run dev:mock -w @dormeto/manager-dashboard  # the dashboard with demo data, no sign-in (development only)
# its organization is generated: http://localhost:5173/?demo=acme,workloads=60,routers=5 (or VITE_MOCK_SCENARIO), see src/mock/scenario.ts
# the build refuses VITE_MOCK (vite.config.ts), and the release a dashboard holding the demo (scripts/release/artifacts.mjs)
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

## Deploy dev

Dev's manager is a CLI install since 2026-10-18 (adopted from the former Terraform configuration): its resources are
managed by the install's CodeBuild project `dmt-dev-install`, its state is `s3://dmt-install-121014831971-eu-west-1/dev/manager.tfstate`
and its settings are `dev/install.json` there. It is updated with the CLI or its dashboard, never with Terraform from
this repository.

A local build: a clean tree, a version newer than the one running, then the install from the release directory (the
settings come from the install's `install.json`; `--var` changes them). The plan is read, then confirmed (or
`dormeto install apply` without a terminal):

```bash
node scripts/release/release.mjs --version <x.y.z-dev.N> --out <dir>
dormeto install --profile kloudy-dormeto-prd --region eu-west-1 --env dev --release <dir>/<version>
```

A published release: from dev's dashboard (Administration, Update), or
`dormeto install --profile kloudy-dormeto-prd --region eu-west-1 --env dev --version <v>`.

The certificate stays in `infra/terraform/platform` (`certificate_arn` output, given to the install): plan with `-out`,
read it, apply the saved plan. It only renews with ACM. Never apply an old checkout's platform configuration that still
holds the manager module.

```bash
cd infra/terraform/platform
tfenv exec init -backend-config=env/dev.backend.hcl
tfenv exec plan -var-file=env/dev.tfvars -out=dev.tfplan
```

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
