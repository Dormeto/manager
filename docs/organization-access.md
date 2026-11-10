# Organization access

This page covers AWS first, then [Google Cloud](#google-cloud).

Discovery reads the AWS organization from the manager account and scans each account of its perimeter through a
read-only role, `DmtDiscoveryRole`; operations act through `DmtCommandRole` (vision
`docs/architecture/organization-iam.md`). Dormeto never deploys these roles (no CloudFormation): they are created with the
Terraform modules of `infra/terraform/modules`, published with each release, and the manager supposes them there:

- `access`, in each member account: `DmtDiscoveryRole`, `DmtCommandRole` and `DmtRouterBoundary`, trusted by the manager
  roles of every environment listed in `envs` (several environments may share an account's roles). In the manager's own
  account the manager install creates them (`create_organization_roles`); a second environment of that account sets it to
  `false` and is listed in the first one's `organization_role_envs`.
- `organization`, in the management account: the Organizations delegation policy.

Each release also publishes `dormeto-access-commands-<version>.sh`, the same with the AWS CLI (settings at its top;
`scripts/release/access-script.mjs`). Each discovery run checks both roles in every account (the command role through the access check function
`dmt-<env>-manager-access-check`, which only assumes it) and the Discovery view's Organization access panel lists what is
missing: onboarding and router installs are refused where the command role is missing.

## Google Cloud

A manager reaches Google Cloud without a key or a secret: its Lambda roles act as two service accounts of one **host
project** through workload identity federation, and every change that makes this possible is made by the CLI, never by
the manager. The manager never changes a Google Cloud IAM policy, and no `gcloud` or console command is needed.

- **The host project** holds the federation for one manager environment `<env>`: the workload identity pool `dmt-<env>`
  with its AWS provider `aws-<account>` (`<account>` is the manager's AWS account; a provider's ID is 4 to 32 characters, so `aws` alone is refused), and two service accounts, the Google twins of the AWS roles.
  The provider maps `google.subject=assertion.arn` and `attribute.aws_role=assertion.arn.extract('assumed-role/{role}/')`,
  and admits only the manager's roles, with the condition
  `assertion.arn.startsWith('arn:aws:sts::<account>:assumed-role/dmt-<env>-manager-')`.
- **`dmt-<env>-discovery@<host>.iam.gserviceaccount.com`**, twin of `DmtDiscoveryRole`, is impersonated by the manager's
  roles `dmt-<env>-manager-discovery`, `-api` and `-savings` (`roles/iam.workloadIdentityUser`, granted to the principal
  set of each role name). It holds read-only access, through the custom role `dormetoDiscovery`, at each scope: the
  projects, folders and organizations, the load balancers' parts, the Cloud Run services (the routers) and Monitoring's
  request counts. It also reads Google's list prices from the Cloud Billing Catalog (the savings job, no role needed, the host
  project's `cloudbilling.googleapis.com` API enabled).
- **`dmt-<env>-command@<host>.iam.gserviceaccount.com`**, twin of `DmtCommandRole`, is impersonated by
  `dmt-<env>-manager-operations`, `-api` and `-fleet`. In each project that has a router it holds
  `roles/run.invoker` on the router's controller (a Cloud Run service `dmtr-<region>-controller`),
  `roles/resourcemanager.tagUser` on the tag value `<project>/dormeto/managed` and the custom role `dormetoCommand` on the
  project (the tag bindings of the onboarding and the offboarding). It holds nothing else: no router install, no IAM
  policy, no backend service.
- **`dormeto gcp connect`** makes every change, as you: the host's APIs (`iam`, `iamcredentials`, `sts`,
  `cloudresourcemanager`, `cloudbilling`), the roles, the pool and provider, the accounts, the impersonation grants, the
  bindings at the scopes and on the routers. It finds the manager through its profile and environment, tests your
  permissions first, prints the plan and asks. The CLI's README has the command
  (`dormeto gcp connect --project <host> --profile <profile> --env <env>`); `dormeto gcp disconnect` removes it.
- **The scopes** are what discovery sees: `organizations/<n>`, `folders/<n>` or `projects/<id>`, repeatable; the default
  is the host project alone. A Google Cloud account without an organization has project scopes only.
- **The connection's record** (`GET|PUT|DELETE /iam/discovery/google`) is what connect writes in the manager: the host
  and its number, the pool, the provider, the scopes, the two accounts, the routers, what Google added, who connected and
  when, with which CLI. Only an IAM caller writes it (`PUT` and `DELETE` under `/iam`: connect and disconnect, with the
  operator's AWS profile; a dashboard session's write is refused), each field checked against what connect writes;
  viewers read it under `/iam` and `/api` (`{ "connection": ... }`, `null` when there is none). The Discovery settings
  show it read-only, or the command that connects one. Without a record, there is no Google Cloud scan.
- **Routers** are registered when connect writes the record (the routers at the scopes, with their controller's URL and
  version). Each discovery run then lists the Cloud Run services `dmtr-<region>-controller` of the scanned projects and
  adds, updates or removes the registrations (the version is the service's `DMT_VERSION`: the discovery account never
  calls a router). The [poll](operations.md#google-cloud-routers) removes a router whose controller no longer exists, and
  reads the version of a router too old to poll from its health, every 10 minutes.
- **Discovery of projects:** with a connection, each run lists the projects at the scopes as the discovery account
  (`projects.search`) and scans each one: its URL maps, backend services, target proxies, forwarding rules, instance
  group managers and VMs (Compute Engine's aggregated lists), then the instance groups and zonal network endpoint groups
  each backend service names, read per backend (`instanceGroups.listInstances`, `networkEndpointGroups.get` and
  `listNetworkEndpoints`), 10 reads at once, then the 7 days of its load balancers' request counts from Cloud Monitoring.
  The projects are listed once a run; the routers are looked for in the same projects. A candidate is a backend service a URL map names. It is
  eligible, ineligible with the router's own onboarding reason (the first one; a GKE workload's is `a GKE workload is
  onboarded with dormeto gcp workloads onboard, after dormeto gcp workloads access grant`), or managed when a router's
  workload names it, a napped one too (its URL map names the waker's backend service). The router's preview, at the onboarding, has the last word.
  The idle share is estimated: Google samples the load balancer's metrics; when Monitoring fails or is turned off, a
  candidate keeps the idle share it had (none if it never had one). A project whose Compute Engine is turned off has
  nothing to find; one that fails (a failed read, `projects.search` itself) is recorded in the run and no candidate of it
  becomes `gone`. A region Compute Engine answers unreachable fails where a candidate is stored or a candidate's backend
  is, and is no error elsewhere (some regions answer so on every call). A project that leaves the scopes has its
  candidates `out-of-scope` (`project no longer at the connection's scopes`), a managed one `pending-offboarding`; a
  managed backend service the scan no longer finds is `gone` (`managed backend service not found in the last scan:
  offboard it`); a listing that fails keeps the projects and their candidates as they were. A refusal of the discovery
  account's token (STS or IAM Credentials API: the federation or the account's grant gone) is a missing access, as for
  the command account below. The AWS run is
  untouched. The Region filter takes `global`; Exclude offers the backend service, the URL map and the project.
- **The Organization access panel** lists each project beside the AWS accounts, with its cloud mark: whether the
  discovery account could read it and, in a project that has a router, whether the command account holds what the manager
  does there (its chips and counts name the two service accounts, and it links to the Google Cloud connection's page). The access check function (it reads `DISC#GOOGLE`, so it needs the table) tests, as the command account,
  the 10 permissions of `dormetoCommand` on the project (Compute Engine's and Cloud SQL's tag bindings and
  `cloudsql.instances.get`), `run.routes.invoke` on each router's controller and
  `resourcemanager.tagValueBindings.create` on the tag value `<project>/dormeto/managed`. A missing one is listed
  in the reason with `dormeto gcp connect --project <host> --profile <profile> --env <env>`, which grants it. A refusal of
  the command account's token itself (Google's STS or IAM Credentials API: the federation or the account's grant) says
  that the manager can't act as the command account, with the same command, rather than listing every permission. The onboarding of a
  candidate of that project is refused with 409 and the same command. A Google failure that is no refusal keeps the last verdict.
- **A router installed later**, in a project the command account does not reach yet, is reached after
  `dormeto gcp connect` is run again; `dormeto gcp install` changes nothing about the manager. Until then, a call to that
  router is refused with the command (`no_access`).
- **After a disconnect,** the record is cleared and the manager's Google Cloud routers are unregistered. The next
  discovery run lists the projects' candidates `out-of-scope` with the reason `the Google Cloud connection was removed`,
  a managed one too: the manager can't offboard without the connection, and the workload stays on its router, run with
  the CLI. The disconnect
  removes, under the two accounts' names, every binding at the recorded scopes and router projects and at the host, the
  two custom roles where connect defined them, the accounts, the provider and the pool; the APIs stay. It looks only
  at the scopes and the host: a project that has left the scopes keeps its `dormetoCommand` role, bound to nobody, after a
  disconnect. It grants nothing; to delete it, make the project a scope again (`dormeto gcp connect --scope
  projects/<id>`) and disconnect.
