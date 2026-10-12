output "organization_id" {
  value = data.aws_organizations_organization.this.id
}

output "discovery_principal" {
  value = local.discovery_principal
}

output "command_role_arn" {
  value = module.access.command_role_arn
}

output "discovery_role_arn" {
  value = module.access.discovery_role_arn
}
