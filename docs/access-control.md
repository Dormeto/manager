# Access control

Who can see and act on which workload. The built-in roles keep their meaning; workload tags and groups add a way to
delegate part of the fleet to a team without giving it the rest.

## Roles

A user's role comes from their Cognito groups; the highest one wins.

| Role | Group | Workloads | Fleet |
|---|---|---|---|
| Administrator | `dmt-admin` | all: read, wake, nap | everything, including users, groups, audit, updates, tags and onboarding |
| Operator | `dmt-operator` | all: read, wake, nap | routers, discovery, exclusions, operations |
| Viewer | `dmt-viewer` | all: read | read-only views |
| Member | none of the above | only what their groups' grants give | Overview, Workloads and their workload views; nothing else |

A user in no built-in group is a **member**. The built-in roles' rights are unchanged: existing users see no difference.
Grants cover workloads only; routers, discovery, exclusions, organization access, onboarding, renaming, users, audit and
updates stay with the built-in roles (a member does not see their entries in the dashboard, and the API refuses them).

## Workload tags

Dormeto's own labels on a workload (`team=payments`, `env=staging`), never AWS tags. They live in the workload's
configuration in its router, beside its name.

- At most 50 tags; a key of 1 to 128 characters and a value of at most 256, in letters, digits, spaces and
  `_ . : / = + - @`; keys are case-sensitive; the prefix `dormeto:` is reserved.
- A workload the manager onboarded has its tags set by administrators: in the onboarding dialog (nothing is copied from AWS
  unless you press "Copy the target group's AWS tags", which takes the first value of each key, for you to edit), then
  from the workload's page (Edit tags), `PUT /api/workloads/:router/:id/tags`. A retag takes effect at once.
- A Terraform workload's tags are the `tags` of its `workload` module; the manager shows them and says "set in Terraform".
- The Workloads list has a Tags column and a tag filter (`GET /api/workloads?tag=key=value`, repeatable; all must match).

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
409).

## Records follow the workload id

History, savings days and operations are kept by workload id, not by tags. A workload that is offboarded and onboarded
again gets the same id, so it inherits its records; and what a member may read of them is decided by the tags the workload
has now. Retagging a workload changes who can read its past too.
