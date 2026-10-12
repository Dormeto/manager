output "dashboard_url" {
  value = "https://${var.dashboard_domain}/"
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
