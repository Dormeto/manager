output "dashboard_url" {
  value = "https://${local.dashboard_host}/"
}

output "auth_domain" {
  description = "Sign-in host (managed login)."
  value       = local.auth_host
}

output "user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "dashboard_client_id" {
  value = aws_cognito_user_pool_client.dashboard.id
}

output "api_endpoint" {
  description = "Direct HTTP API endpoint (browsers use /api/* on the dashboard host)."
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "api_iam_arn" {
  description = "The API's IAM routes (/iam/*), for the execute-api:Invoke policy of the Dormeto CLI's callers."
  value       = "${aws_apigatewayv2_api.api.execution_arn}/*/*/iam/*"
}

output "version" {
  description = "The manager's version, and the router version it installs."
  value       = { manager = local.version, router = local.router_version }
}
