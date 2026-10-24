// The AWS CLI procedure of a release (vision docs/specs/2026-10-06-packaging-design.md, section 3), for teams without
// Terraform: one bash script with its settings at the top, creating or updating in a member account the same roles as
// the access module, from the same documents; and the organization policy with its principal to fill.

// Bash single-quoted: the documents never expand anything.
const quoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const compact = (json) => JSON.stringify(JSON.parse(json));

export function accessScript({ version, discoveryPolicy, commandPolicy, boundary }) {
  return `#!/usr/bin/env bash
# Dormeto ${version}: the organization roles of one member account with the AWS CLI, as the access module creates them
# (https://dormeto.com/organization-access.html): DmtDiscoveryRole (read only), DmtCommandRole and the DmtRouterBoundary
# policy. Run it with administrator credentials of that account; run it again to update (after a manager upgrade).
set -euo pipefail

# Settings: here, or in the environment.
ACCOUNT="\${ACCOUNT:-}"                                # this account, 12 digits
MANAGER_ACCOUNT="\${MANAGER_ACCOUNT:-}"                # the manager's account
ENVS="\${ENVS:-}"                                      # the manager's environments, space-separated (prod staging)
ORGANIZATION="\${ORGANIZATION:-}"                      # o-…: the discovery role trusts the manager within it only
DISCOVERY_ROLE="\${DISCOVERY_ROLE:-DmtDiscoveryRole}"  # a path may precede the name (team/DmtDiscoveryRole)
COMMAND_ROLE="\${COMMAND_ROLE-DmtCommandRole}"         # empty: discovered, never napped (no command role, no boundary)
PARTITION="\${PARTITION:-aws}"

fail() { echo "dormeto: $*" >&2; exit 1; }
ROLE='^([A-Za-z0-9+=,.@_-]+/)*[A-Za-z0-9+=,.@_-]{1,64}$'
[[ $ACCOUNT =~ ^[0-9]{12}$ ]] || fail "ACCOUNT must be 12 digits"
[[ $MANAGER_ACCOUNT =~ ^[0-9]{12}$ ]] || fail "MANAGER_ACCOUNT must be 12 digits"
[[ -n $ENVS ]] || fail "ENVS must list the manager's environments"
for env in $ENVS; do [[ $env =~ ^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$ ]] || fail "environment '$env': 1 to 10 lowercase letters, digits or inner hyphens"; done
[[ -z $ORGANIZATION || $ORGANIZATION =~ ^o-[a-z0-9]{10,32}$ ]] || fail "ORGANIZATION must look like o-xxxxxxxxxx"
[[ $DISCOVERY_ROLE =~ $ROLE ]] || fail "DISCOVERY_ROLE: a role name, a path may precede it"
[[ -z $COMMAND_ROLE || $COMMAND_ROLE =~ $ROLE ]] || fail "COMMAND_ROLE: a role name, a path may precede it"
[[ $PARTITION =~ ^aws(-[a-z-]+)?$ ]] || fail "PARTITION: aws, aws-cn or aws-us-gov"
CALLER=$(aws sts get-caller-identity --query Account --output text)
[[ $CALLER == "$ACCOUNT" ]] || fail "the credentials are of account $CALLER, not $ACCOUNT"

# The manager's roles of every environment, by name in its account.
principals() { local out="" env; for env in $ENVS; do out+="\${out:+,}\\"arn:$PARTITION:iam::$MANAGER_ACCOUNT:role/dmt-$env-manager-$1\\""; done; printf '[%s]' "$out"; }
fill() { local doc=$1; doc=\${doc//'\${account}'/$ACCOUNT}; printf '%s' "\${doc//'\${partition}'/$PARTITION}"; }

# Creates the role, or updates its trust; then its inline policy.
put_role() {
  local role=$1 trust=$2 policy_name=$3 policy=$4; shift 4
  local name=\${role##*/} path=/
  [[ $role == */* ]] && path="/\${role%/*}/"
  if aws iam get-role --role-name "$name" > /dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$name" --policy-document "$trust"
  else
    aws iam create-role --role-name "$name" --path "$path" --max-session-duration 3600 --assume-role-policy-document "$trust" "$@"
  fi
  aws iam put-role-policy --role-name "$name" --policy-name "$policy_name" --policy-document "$policy"
}

ORG_CONDITION=""
[[ -n $ORGANIZATION ]] && ORG_CONDITION=",\\"StringEquals\\":{\\"aws:PrincipalOrgID\\":\\"$ORGANIZATION\\"}"
put_role "$DISCOVERY_ROLE" \\
  "{\\"Version\\":\\"2012-10-17\\",\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Action\\":\\"sts:AssumeRole\\",\\"Principal\\":{\\"AWS\\":\\"arn:$PARTITION:iam::$MANAGER_ACCOUNT:root\\"},\\"Condition\\":{\\"ArnLike\\":{\\"aws:PrincipalArn\\":$(principals discovery)}$ORG_CONDITION}}]}" \\
  discovery "$(fill ${quoted(compact(discoveryPolicy))})" \\
  --description "Dormeto discovery (read-only)" --tags Key=dormeto:component,Value=discovery

# Without a command role, the account says it is set up for discovery only (the manager counts it apart).
if [[ -z $COMMAND_ROLE ]]; then
  aws iam tag-role --role-name "\${DISCOVERY_ROLE##*/}" --tags Key=dormeto:command-role,Value=none
  echo "dormeto: $DISCOVERY_ROLE ready (discovery only: no command role)"
  exit 0
fi
aws iam untag-role --role-name "\${DISCOVERY_ROLE##*/}" --tag-keys dormeto:command-role

# The boundary of every role Dormeto creates for a router: created, or a new default version (IAM keeps five).
BOUNDARY=$(fill ${quoted(compact(boundary))})
BOUNDARY_ARN="arn:$PARTITION:iam::$ACCOUNT:policy/DmtRouterBoundary"
if aws iam get-policy --policy-arn "$BOUNDARY_ARN" > /dev/null 2>&1; then
  OLD=$(aws iam list-policy-versions --policy-arn "$BOUNDARY_ARN" --query 'Versions[?!IsDefaultVersion].VersionId' --output text)
  if (( $(wc -w <<< "$OLD") >= 4 )); then
    aws iam delete-policy-version --policy-arn "$BOUNDARY_ARN" --version-id "$(tr -s '[:space:]' '\\n' <<< "$OLD" | sort -V | head -1)"
  fi
  aws iam create-policy-version --policy-arn "$BOUNDARY_ARN" --policy-document "$BOUNDARY" --set-as-default
else
  aws iam create-policy --policy-name DmtRouterBoundary --description "Permissions boundary of every role Dormeto creates for a router." --policy-document "$BOUNDARY"
fi

put_role "$COMMAND_ROLE" \\
  "{\\"Version\\":\\"2012-10-17\\",\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Action\\":\\"sts:AssumeRole\\",\\"Principal\\":{\\"AWS\\":\\"arn:$PARTITION:iam::$MANAGER_ACCOUNT:root\\"},\\"Condition\\":{\\"ArnLike\\":{\\"aws:PrincipalArn\\":$(principals operations)}}}]}" \\
  command "$(fill ${quoted(compact(commandPolicy))})" \\
  --description "Dormeto manager: installs, upgrades and removes routers by API calls, onboards workloads through them."
echo "dormeto: $DISCOVERY_ROLE, $COMMAND_ROLE and DmtRouterBoundary ready"
`;
}

// The delegation policy of the management account, the manager's account and environment to fill in its principal.
export function organizationPolicy(document) {
  return `${JSON.stringify(JSON.parse(document.replace('"${principals}"', JSON.stringify(['arn:aws:iam::MANAGER_ACCOUNT:role/dmt-ENV-manager-discovery']))), null, 2)}\n`;
}
