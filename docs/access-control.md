# Access control

Who can see and act on which workload. The built-in roles keep their meaning; workload tags and groups add a way to
delegate part of the fleet to a team without giving it the rest.

## Roles

A user's role comes from their Cognito groups; the highest one wins.

| Role | Group | Workloads | Fleet |
|---|---|---|---|
| Administrator | `dmt-admin` | all: read, wake, nap | everything, including users, groups, audit, updates, tags and onboarding; routers' descriptions, the routers' Hibernate and the manager's (Workload defaults) |
| Operator | `dmt-operator` | all: read, wake, nap | routers, discovery, exclusions, operations; workloads' descriptions and Hibernate |
| Viewer | `dmt-viewer` | all: read | read-only views |
| Member | none of the above | only what their groups' grants give | Overview, Workloads and their workload views; nothing else |

Descriptions and hibernation settings are read by whoever reads what they describe: a workload's description (and its
Hibernate row) by everyone who reads the workload, members included; a router's by the built-in roles. Every signed-in
user reads the manager's Hibernate default (`GET /api/settings/workloads`). Writing them follows the table: a
workload's description and Hibernate, operators and administrators (a Terraform workload's Hibernate is set in its
`workload` module); a router's description and Hibernate, and the manager's default, administrators.

**Joined windows** (routers 0.36.0) follow the same rights at the organization and the router: every signed-in user reads the
organization's `joinMinutes` (`GET /api/settings/workloads`), the built-in roles a router's; administrators set them
(`PUT /api/settings/workloads`, `PUT /api/routers/{router}/settings`, each write keeping what it does not send). A workload's is on
its schedule (`joinMinutes`, written with the schedule by whoever may both wake and nap it), and its settings route refuses one.

**Workload settings at scale** (routers 0.37.0) follow the same rights: every signed-in user reads the organization's
defaults (`GET /api/settings/workloads`) and the workload types (`GET /api/settings/types`); administrators set them (`PUT`
on both) and a router's (`PUT /api/routers/{router}/settings` with `defaults`), and read what a level reaches
(`GET /api/settings/reach`); operators and administrators set a manager workload's own settings and type (`PUT
/api/workloads/{router}/{id}/settings`). A Terraform workload's are set in its `workload` module.

The **waiting page** (routers 0.35.0) is read at the organization (`/api/settings/waiting-page`, by every signed-in user, as
the Hibernate default is), the router (`/api/routers/{router}/waiting-page`, by the built-in roles) and the workload
(`/api/workloads/{router}/{id}/waiting-page`) level; a member reads a workload's page when their groups' grants read that
workload, and no other's. A template page is set by administrators at the organization and router levels, and by operators
and administrators at the workload level. A **custom HTML page** runs scripts on the application's own address, where it can
read that site's cookies and call its API as the visitor: setting, replacing or clearing one is for administrators at every
level, and so is replacing it with a template. A write by anyone else, a member included whatever their groups grant, is
refused with a 403 and audited; the API asks the router what is stored before a write. The audit keeps the level, the mode
and, for a custom page, the size and SHA-256 of its HTML, and the same of a custom page a write removes or replaces; never
a page. Callers of the `/iam/` routes act as administrators, so a principal allowed to call them may set a custom page. A
session's role is its token's: a demoted administrator keeps it for up to the token's hour.

A user in no built-in group is a **member**. The built-in roles' rights are unchanged: existing users in a built-in group see no
difference.

The manager always keeps an enabled administrator: demoting or disabling the last one is refused with a 409 ("the last
administrator: give the admin role to another user first"), for every caller, including one signed with AWS credentials,
which is never "yourself". Give the admin role to another user first. An administrator invited who has not signed in yet
counts as another enabled administrator: while such an invitation is pending, the last administrator who has signed in can
be demoted or disabled (by a caller signed with AWS credentials, since nobody changes their own account), and the
invitation may expire unused. Such a caller can give the admin role back.

**Upgrading to 0.14.0:** before 0.14.0 a user in no built-in group was a viewer; they are now a member and see nothing until
a group grants them access. Users invited through the dashboard always have a built-in group, so only users created by hand
in Cognito are concerned: add them to `dmt-viewer`, or to a custom group.
Grants cover workloads only; routers, discovery, exclusions, organization access, onboarding, renaming, writing
descriptions and hibernation settings, users, audit and updates stay with the built-in roles (a member does not see their
entries in the dashboard, and the API refuses them).

## Workload tags

Dormeto's own labels on a workload (`team=payments`, `env=staging`), never AWS tags. They live in the workload's
configuration in its router, beside its name.

- At most 50 tags; a key of 1 to 128 characters and a value of at most 256, in letters, digits, spaces and
  `_ . : / = + - @`; keys are case-sensitive; the prefix `dormeto:` is reserved.
- A workload the manager onboarded has its tags set by administrators: in the onboarding dialog (nothing is copied from AWS
  unless you press "Copy the target group's AWS tags", which takes the first value of each key, for you to edit), then
  from the workload's page (Edit tags), `PUT /api/workloads/:router/:id/tags`. A retag takes effect at once. An operator cannot set tags at onboarding: the API refuses (403, audited) an onboarding with
  tags from anyone but an administrator, and the dialog shows them the Tags section only to administrators.
- A Terraform workload's tags are the `tags` of its `workload` module; the manager shows them and says "set in Terraform".
- The Workloads list has a Tags column and a tag filter (`GET /api/workloads?tag=key=value`, repeatable; all must match). The filter takes `key=value` only (free text is refused in the dashboard, 400 from the API) and splits
  at the first `=`, so a key containing `=` cannot be filtered.

## Groups and grants

Administrators manage groups in the Users view: a name (1 to 48 lower-case letters, digits and hyphens; `dmt-` is
reserved), a description (at most 200 characters), up to 20 grants, at most 100 groups. A group is a Cognito group of the
manager's user pool; its grants are kept in the manager's table. A user can belong to several groups.

A **grant** is a tag selector and the permissions it gives:

- the selector's tags must all match the workload's; **`{}` (no tag) means every workload**, untagged ones included, and a
  selector with tags never matches an untagged workload;
- permissions: `read` (the workload in lists and counts, its status, history, idle window, savings, alerts and
  operations), `wake`, and `nap` (nap, pause and resume);
- `wake` and `nap` imply `read`;
- **a pause that wakes the workload** (without "leave it asleep") **also needs `wake`**: a nap-only grant pauses with the
  workload left asleep.

A user's access is the union of their built-in role's implicit grant (every workload) and their groups' grants. A workload
no grant matches does not exist for them: lists leave it out, counts, savings and alerts never include it, and its
address answers 404. A readable workload without the permission answers 403, and the refusal is audited (`result:
refused`, with the reason). Every audit entry also records the caller's groups.

Workload payloads carry `can: { wake, nap }`, and `GET /api/me` the `role`, `groups` and effective `grants`, so that the
dashboard shows only the actions the user may take.

### Two-step verification

Under the `operators` MFA mode, a user needs a multi-factor session when their role is operator or administrator, or when
any grant gives `wake` or `nap`. Without it they keep `read` grants only.

### When changes apply

| Change | Applies |
|---|---|
| A user's groups (membership) | at their next token, within an hour (the groups travel in the sign-in token) |
| A group's grants, or its deletion | within a minute (the API keeps them 60 seconds per instance); a deleted group's grants stop applying even while tokens still name it |
| A workload's tags | at once |

## Older routers

Routers before 0.30.0 report no tags. Their workloads are seen only by the built-in roles and by grants with an empty
selector (`{}`), until the router is upgraded (the Routers view offers it); tags cannot be set on them (the API answers
409). The API returns no `tags` for such a workload and the workload's page says "Tags unknown (router before 0.30.0)"; an
onboarding with tags fails at its preview on such a router ("upgrade it to onboard with tags").

## Records follow the workload id

History, savings days and operations are kept by workload id, not by tags. A workload that is offboarded and onboarded
again gets the same id, so it inherits its records; and what a member may read of them is decided by the tags the workload
has now. Retagging a workload changes who can read its past too.
