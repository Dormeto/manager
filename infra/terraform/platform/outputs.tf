output "dashboard_url" {
  value = module.manager.dashboard_url
}

output "user_pool_id" {
  value = module.manager.user_pool_id
}

output "dashboard_client_id" {
  value = module.manager.dashboard_client_id
}

output "api_endpoint" {
  description = "Direct HTTP API endpoint (browsers use /api/* on the dashboard host)."
  value       = module.manager.api_endpoint
}

output "alerts_topic_arn" {
  value = module.manager.alerts_topic_arn
}
