output "organization_id" {
  value = data.aws_organizations_organization.this.id
}

output "discovery_principal" {
  value = local.discovery_principal
}

output "command_role_arn" {
  value = module.command_role.role_arn
}
