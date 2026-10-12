# The state of every resource of dev's platform, moved into the manager module (plan B1; review focus 2: nothing
# replaced). Two became optional (count): their one instance is [0].

moved {
  from = aws_dynamodb_table.manager
  to   = module.manager.aws_dynamodb_table.manager
}

moved {
  from = aws_iam_role.api
  to   = module.manager.aws_iam_role.api
}

moved {
  from = aws_cloudwatch_log_group.api
  to   = module.manager.aws_cloudwatch_log_group.api
}

moved {
  from = aws_iam_role_policy.api
  to   = module.manager.aws_iam_role_policy.api
}

moved {
  from = aws_lambda_function.api
  to   = module.manager.aws_lambda_function.api
}

moved {
  from = aws_apigatewayv2_api.api
  to   = module.manager.aws_apigatewayv2_api.api
}

moved {
  from = aws_apigatewayv2_authorizer.cognito
  to   = module.manager.aws_apigatewayv2_authorizer.cognito
}

moved {
  from = aws_apigatewayv2_integration.api
  to   = module.manager.aws_apigatewayv2_integration.api
}

moved {
  from = aws_apigatewayv2_route.health
  to   = module.manager.aws_apigatewayv2_route.health
}

moved {
  from = aws_apigatewayv2_route.api
  to   = module.manager.aws_apigatewayv2_route.api
}

moved {
  from = aws_apigatewayv2_stage.default
  to   = module.manager.aws_apigatewayv2_stage.default
}

moved {
  from = aws_lambda_permission.api
  to   = module.manager.aws_lambda_permission.api
}

moved {
  from = aws_ses_identity_policy.cognito
  to   = module.manager.aws_ses_identity_policy.cognito[0]
}

moved {
  from = aws_cognito_user_pool.main
  to   = module.manager.aws_cognito_user_pool.main
}

moved {
  from = aws_cognito_user_group.role
  to   = module.manager.aws_cognito_user_group.role
}

moved {
  from = aws_cognito_user_pool_client.dashboard
  to   = module.manager.aws_cognito_user_pool_client.dashboard
}

moved {
  from = aws_cognito_user_pool_domain.main
  to   = module.manager.aws_cognito_user_pool_domain.main
}

moved {
  from = aws_route53_record.auth
  to   = module.manager.aws_route53_record.auth[0]
}

moved {
  from = aws_cognito_managed_login_branding.dashboard
  to   = module.manager.aws_cognito_managed_login_branding.dashboard
}

moved {
  from = time_sleep.ses_policy
  to   = module.manager.time_sleep.ses_policy
}

moved {
  from = aws_cognito_user.admin
  to   = module.manager.aws_cognito_user.admin
}

moved {
  from = aws_cognito_user_in_group.admin
  to   = module.manager.aws_cognito_user_in_group.admin
}

moved {
  from = aws_cognito_user_pool_client.smoke
  to   = module.manager.aws_cognito_user_pool_client.smoke
}

moved {
  from = random_password.smoke
  to   = module.manager.random_password.smoke
}

moved {
  from = aws_cognito_user.smoke
  to   = module.manager.aws_cognito_user.smoke
}

moved {
  from = aws_cognito_user_in_group.smoke
  to   = module.manager.aws_cognito_user_in_group.smoke
}

moved {
  from = aws_ssm_parameter.smoke
  to   = module.manager.aws_ssm_parameter.smoke
}

moved {
  from = module.organization_roles
  to   = module.manager.module.organization_roles
}

moved {
  from = aws_iam_role.discovery
  to   = module.manager.aws_iam_role.discovery
}

moved {
  from = aws_iam_role_policy.discovery
  to   = module.manager.aws_iam_role_policy.discovery
}

moved {
  from = aws_cloudwatch_log_group.discovery
  to   = module.manager.aws_cloudwatch_log_group.discovery
}

moved {
  from = aws_lambda_function.discovery
  to   = module.manager.aws_lambda_function.discovery
}

moved {
  from = aws_iam_role.discovery_run
  to   = module.manager.aws_iam_role.discovery_run
}

moved {
  from = aws_iam_role_policy.discovery_run
  to   = module.manager.aws_iam_role_policy.discovery_run
}

moved {
  from = aws_sfn_state_machine.discovery
  to   = module.manager.aws_sfn_state_machine.discovery
}

moved {
  from = aws_sqs_queue.discovery_failures
  to   = module.manager.aws_sqs_queue.discovery_failures
}

moved {
  from = aws_iam_role.discovery_scheduler
  to   = module.manager.aws_iam_role.discovery_scheduler
}

moved {
  from = aws_iam_role_policy.discovery_scheduler
  to   = module.manager.aws_iam_role_policy.discovery_scheduler
}

moved {
  from = aws_scheduler_schedule.discovery
  to   = module.manager.aws_scheduler_schedule.discovery
}

moved {
  from = aws_s3_bucket.dashboard
  to   = module.manager.aws_s3_bucket.dashboard
}

moved {
  from = aws_s3_bucket_public_access_block.dashboard
  to   = module.manager.aws_s3_bucket_public_access_block.dashboard
}

moved {
  from = aws_s3_bucket_ownership_controls.dashboard
  to   = module.manager.aws_s3_bucket_ownership_controls.dashboard
}

moved {
  from = aws_s3_bucket_policy.dashboard
  to   = module.manager.aws_s3_bucket_policy.dashboard
}

moved {
  from = aws_s3_object.dashboard
  to   = module.manager.aws_s3_object.dashboard
}

moved {
  from = aws_s3_object.config
  to   = module.manager.aws_s3_object.config
}

moved {
  from = aws_cloudfront_origin_access_control.dashboard
  to   = module.manager.aws_cloudfront_origin_access_control.dashboard
}

moved {
  from = aws_cloudfront_function.spa
  to   = module.manager.aws_cloudfront_function.spa
}

moved {
  from = aws_cloudfront_response_headers_policy.dashboard
  to   = module.manager.aws_cloudfront_response_headers_policy.dashboard
}

moved {
  from = aws_cloudfront_distribution.dashboard
  to   = module.manager.aws_cloudfront_distribution.dashboard
}

moved {
  from = aws_route53_record.dashboard
  to   = module.manager.aws_route53_record.dashboard
}

moved {
  from = aws_cloudwatch_event_bus.manager
  to   = module.manager.aws_cloudwatch_event_bus.manager
}

moved {
  from = aws_cloudwatch_event_bus_policy.manager
  to   = module.manager.aws_cloudwatch_event_bus_policy.manager
}

moved {
  from = aws_cloudwatch_event_rule.router_events
  to   = module.manager.aws_cloudwatch_event_rule.router_events
}

moved {
  from = aws_sqs_queue.router_events_failed
  to   = module.manager.aws_sqs_queue.router_events_failed
}

moved {
  from = aws_sqs_queue.router_events
  to   = module.manager.aws_sqs_queue.router_events
}

moved {
  from = aws_sqs_queue_policy.router_events
  to   = module.manager.aws_sqs_queue_policy.router_events
}

moved {
  from = aws_cloudwatch_event_target.router_events
  to   = module.manager.aws_cloudwatch_event_target.router_events
}

moved {
  from = aws_iam_role.fleet
  to   = module.manager.aws_iam_role.fleet
}

moved {
  from = aws_iam_role_policy.fleet
  to   = module.manager.aws_iam_role_policy.fleet
}

moved {
  from = aws_cloudwatch_log_group.fleet
  to   = module.manager.aws_cloudwatch_log_group.fleet
}

moved {
  from = aws_lambda_function.fleet
  to   = module.manager.aws_lambda_function.fleet
}

moved {
  from = aws_lambda_event_source_mapping.router_events
  to   = module.manager.aws_lambda_event_source_mapping.router_events
}

moved {
  from = aws_s3_bucket.artifacts
  to   = module.manager.aws_s3_bucket.artifacts
}

moved {
  from = aws_s3_bucket_public_access_block.artifacts
  to   = module.manager.aws_s3_bucket_public_access_block.artifacts
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.artifacts
  to   = module.manager.aws_s3_bucket_server_side_encryption_configuration.artifacts
}

moved {
  from = aws_s3_object.router_bundle
  to   = module.manager.aws_s3_object.router_bundle
}

moved {
  from = aws_iam_role.operations
  to   = module.manager.aws_iam_role.operations
}

moved {
  from = aws_iam_role_policy.operations
  to   = module.manager.aws_iam_role_policy.operations
}

moved {
  from = aws_cloudwatch_log_group.operations
  to   = module.manager.aws_cloudwatch_log_group.operations
}

moved {
  from = aws_lambda_function.operations
  to   = module.manager.aws_lambda_function.operations
}

moved {
  from = aws_cloudwatch_log_group.access_check
  to   = module.manager.aws_cloudwatch_log_group.access_check
}

moved {
  from = aws_lambda_function.access_check
  to   = module.manager.aws_lambda_function.access_check
}

moved {
  from = aws_iam_role.workflow
  to   = module.manager.aws_iam_role.workflow
}

moved {
  from = aws_iam_role_policy.workflow
  to   = module.manager.aws_iam_role_policy.workflow
}

moved {
  from = aws_sfn_state_machine.operations
  to   = module.manager.aws_sfn_state_machine.operations
}
