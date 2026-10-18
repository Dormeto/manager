# The manager module (packaging design §4, plan B1): what a customer installs. A missing artifact fails the plan with its
# path (review focus 5); without a domain the dashboard is on CloudFront's own domain and sign-in on Cognito's; without
# an SES identity Cognito sends the invitations itself.
mock_provider "aws" {
  # The provider still validates arguments: policies must be JSON objects.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "111122223333" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "eu-west-1" }
  }
}
mock_provider "random" {}
mock_provider "time" {}

variables {
  env             = "test"
  organization_id = "o-abcdefghij"
  admin_emails    = ["admin@example.com"]
  artifacts_dir   = "tests/artifacts"
}

run "without_a_domain_nor_ses" {
  command = plan

  assert {
    condition     = aws_cloudfront_distribution.dashboard.aliases == null || length(aws_cloudfront_distribution.dashboard.aliases) == 0
    error_message = "Without a domain, the dashboard has no alias."
  }
  assert {
    condition     = aws_cloudfront_distribution.dashboard.viewer_certificate[0].cloudfront_default_certificate == true
    error_message = "Without a domain, CloudFront's own certificate."
  }
  assert {
    condition     = aws_cognito_user_pool_domain.main.domain == "dmt-test-manager-111122223333" && aws_cognito_user_pool_domain.main.certificate_arn == null
    error_message = "Without a domain, sign-in on a Cognito prefix domain."
  }
  assert {
    condition     = length(aws_route53_record.dashboard) == 0 && length(aws_route53_record.auth) == 0
    error_message = "Without a hosted zone, no DNS record."
  }
  assert {
    condition     = aws_cognito_user_pool.main.email_configuration[0].email_sending_account == "COGNITO_DEFAULT" && length(aws_ses_identity_policy.cognito) == 0
    error_message = "Without an SES identity, Cognito sends the invitations itself."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.EMAIL_SENDER == "cognito" && length([for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SesSandbox"]) == 0
    error_message = "Without an SES identity, the API invites through Cognito and has no SES permission."
  }
  assert {
    condition     = aws_lambda_function.access_check.handler == "check.handler" && aws_lambda_function.access_check.filename == "tests/artifacts/lambda/access-check.zip" && aws_lambda_function.api.filename == "tests/artifacts/lambda/api.zip" && aws_s3_object.router_bundle["router.zip"].key == "router/0.0.0-test/router.zip"
    error_message = "The release's bundles and versions are used."
  }
  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "ACTIVE" && aws_dynamodb_table.manager.deletion_protection_enabled == true
    error_message = "The users and the table (routers installed, operations, audit) are protected from a mistaken destroy by default."
  }
}

# Event-driven refresh (packaging design §5): forwarded load balancer changes to a queue read in 5-minute batches by
# discovery; the connections a run decides passed to the operations, which start their executions.
run "event_driven_refresh" {
  command = plan

  # The state machine's definition holds the functions' ARNs: known at plan here.
  override_resource {
    target          = aws_lambda_function.discovery
    override_during = plan
    values          = { arn = "arn:aws:lambda:eu-west-1:111122223333:function:dmt-test-manager-discovery" }
  }
  override_resource {
    target          = aws_sqs_queue.refresh_failed
    override_during = plan
    values          = { arn = "arn:aws:sqs:eu-west-1:111122223333:dmt-test-manager-refresh-failed" }
  }
  override_resource {
    target          = aws_lambda_function.operations
    override_during = plan
    values          = { arn = "arn:aws:lambda:eu-west-1:111122223333:function:dmt-test-manager-operations" }
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.refresh.event_pattern) == { source = ["aws.elasticloadbalancing"], "detail-type" = ["AWS API Call via CloudTrail"] } && aws_cloudwatch_event_rule.refresh.event_bus_name == aws_cloudwatch_event_bus.manager.name
    error_message = "The manager's bus sends the forwarded load balancer changes to the refresh queue."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.refresh.maximum_batching_window_in_seconds == 300 && aws_lambda_event_source_mapping.refresh.batch_size == 10000 && aws_lambda_event_source_mapping.refresh.scaling_config[0].maximum_concurrency == 2 && aws_lambda_event_source_mapping.refresh.function_response_types == toset(["ReportBatchItemFailures"])
    error_message = "Discovery reads the refresh queue in 5-minute batches, giving back the events it could not handle."
  }
  assert {
    # Above the discovery Lambda's timeout and the batching window (R5c review I2).
    condition     = aws_sqs_queue.refresh.visibility_timeout_seconds >= 1200 && jsondecode(aws_sqs_queue.refresh.redrive_policy).maxReceiveCount >= 5
    error_message = "A batch being handled is never delivered twice; an event given back is retried before its dead-letter queue."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.discovery.statement : s if s.sid == "RefreshQueue"]) == 1
    error_message = "Discovery may read the refresh queue."
  }
  assert {
    condition     = jsondecode(aws_sfn_state_machine.discovery.definition).States.Finalize.Next == "Connect?" && jsondecode(aws_sfn_state_machine.discovery.definition).States.Connections.Parameters.Payload == { task = "connections", "runId.$" = "$.startedAt" }
    error_message = "After finalize, the operations read the run's connections by its id (never the lists through Step Functions)."
  }
  assert {
    condition     = aws_lambda_function.operations.environment[0].variables.OPERATIONS_STATE_MACHINE == "arn:aws:states:eu-west-1:111122223333:stateMachine:dmt-test-manager-operations"
    error_message = "The operations Lambda starts the executions of the operations it creates."
  }
}

run "the_smoke_user_is_named_at_plan_without_a_domain" {
  command = plan
  variables {
    smoke_user = true
  }

  # Not from CloudFront's host, unknown until the distribution exists (the provider fails on an unknown attribute map;
  # found by B4's install).
  assert {
    condition     = aws_cognito_user.smoke[0].username == "smoke@dmt-test-manager.invalid" && aws_cognito_user.smoke[0].attributes.email == "smoke@dmt-test-manager.invalid"
    error_message = "Without a domain, the smoke user is smoke@<name>.invalid."
  }
}

run "uninstall_lifts_the_users_protection" {
  command = plan
  variables {
    deletion_protection = false
  }

  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "INACTIVE" && aws_dynamodb_table.manager.deletion_protection_enabled == false
    error_message = "deletion_protection = false lets terraform destroy remove the user pool and the table."
  }
}

run "with_a_domain_and_ses" {
  command = plan
  variables {
    domain = {
      dashboard       = "app.example.com"
      auth            = "auth.app.example.com"
      certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/test"
      zone_id         = "Z0123456789"
    }
    ses_identity = "example.com"
    email_from   = "Dormeto <no-reply@example.com>"
  }

  assert {
    condition     = aws_cloudfront_distribution.dashboard.aliases == toset(["app.example.com"]) && aws_cloudfront_distribution.dashboard.viewer_certificate[0].acm_certificate_arn == "arn:aws:acm:us-east-1:111122223333:certificate/test"
    error_message = "The dashboard on the domain, with its certificate."
  }
  assert {
    condition     = aws_cognito_user_pool_domain.main.domain == "auth.app.example.com" && length(aws_route53_record.dashboard) == 2 && length(aws_route53_record.auth) == 1
    error_message = "Sign-in on the auth domain, with the DNS records."
  }
  assert {
    condition     = aws_cognito_user_pool.main.email_configuration[0].source_arn == "arn:aws:ses:eu-west-1:111122223333:identity/example.com" && length(aws_ses_identity_policy.cognito) == 1
    error_message = "With an SES identity, Cognito sends through it."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.EMAIL_SENDER == "ses" && length([for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SesSandbox"]) == 1
    error_message = "With an SES identity, the API verifies invited addresses while SES is in the sandbox."
  }
}

run "missing_artifacts_fail_the_plan_with_their_paths" {
  command = plan
  variables {
    artifacts_dir = "tests/no-such-release"
  }
  # One failure, naming every missing file; nothing that reads them is planned.
  expect_failures = [terraform_data.artifacts]
}

# Health alarms (R6a): the watchdog every 5 minutes, one run at a time; the alert topic with an email subscription per
# address; CloudWatch alarms on the watchdog and on the router events not stored, in and out of ALARM to the topic.
run "health_alarms" {
  command = plan

  variables {
    alert_emails = ["ops@example.com", "oncall@example.com"]
  }
  override_resource {
    target          = aws_sns_topic.alerts
    override_during = plan
    values          = { arn = "arn:aws:sns:eu-west-1:111122223333:dmt-test-manager-alerts" }
  }

  assert {
    condition     = aws_scheduler_schedule.watchdog.schedule_expression == "rate(5 minutes)" && aws_lambda_function.watchdog.reserved_concurrent_executions == 1
    error_message = "The watchdog runs every 5 minutes, one run at a time."
  }
  assert {
    condition     = aws_lambda_function.watchdog.handler == "watchdog.handler" && aws_lambda_function.watchdog.filename == "tests/artifacts/lambda/watchdog.zip"
    error_message = "The watchdog runs the release's bundle."
  }
  assert {
    condition     = aws_lambda_function.watchdog.environment[0].variables.ALERTS_TOPIC == "arn:aws:sns:eu-west-1:111122223333:dmt-test-manager-alerts" && aws_lambda_function.api.environment[0].variables.ALERTS_TOPIC == "arn:aws:sns:eu-west-1:111122223333:dmt-test-manager-alerts"
    error_message = "The watchdog publishes to the alert topic; the API reads its subscriptions."
  }
  assert {
    condition     = toset([for s in aws_sns_topic_subscription.alert_email : "${s.protocol} ${s.endpoint}"]) == toset(["email ops@example.com", "email oncall@example.com"])
    error_message = "One email subscription per address of alert_emails."
  }
  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.manager)) == toset(["watchdog-errors", "watchdog-silent", "router-events-failed", "ip-lists-errors", "savings-errors", "savings-failed", "update-check-errors"])
    error_message = "Alarms on the watchdog's errors and silence, on the router events not stored, and on the list and update check functions' errors."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.manager["watchdog-silent"].treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.manager["watchdog-silent"].comparison_operator == "LessThanThreshold"
    error_message = "A watchdog never invoked is an alarm (missing data breaching)."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.manager["watchdog-errors"].datapoints_to_alarm == 1
    error_message = "Review I4: one failed run in 15 minutes is an alarm (not three in a row)."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.manager["ip-lists-errors"].treat_missing_data == "ignore"
    error_message = "Review I5: the hourly list function's alarm holds its state between runs (no OK every hour)."
  }
  assert {
    condition     = alltrue([for a in aws_cloudwatch_metric_alarm.manager : a.alarm_actions == toset(["arn:aws:sns:eu-west-1:111122223333:dmt-test-manager-alerts"]) && a.ok_actions == toset(["arn:aws:sns:eu-west-1:111122223333:dmt-test-manager-alerts"])])
    error_message = "Every alarm goes to the alert topic, in and out of ALARM."
  }
}

run "alert_emails_must_be_addresses" {
  command = plan

  variables {
    alert_emails = ["not an address"]
  }
  expect_failures = [var.alert_emails]
}

# IP lists distributed by the manager (R6b): the catalog written from ip_lists; the list function from the router bundle,
# hourly; the bucket read by the organization's routers; installed routers given the catalog.
run "ip_lists" {
  command = plan

  variables {
    ip_lists = [
      { name = "ipsum", url = "https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt" },
      { name = "aws", url = "https://ip-ranges.amazonaws.com/ip-ranges.json", action = "ignore", refresh_hours = 12 },
    ]
  }
  override_resource {
    target          = aws_s3_bucket.lists
    override_during = plan
    values          = { id = "dmt-test-manager-ip-lists-111122223333", bucket = "dmt-test-manager-ip-lists-111122223333", arn = "arn:aws:s3:::dmt-test-manager-ip-lists-111122223333" }
  }

  assert {
    condition     = jsondecode(aws_s3_object.catalog.content) == { lists = [{ name = "ipsum", url = "https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt", action = "defer", refreshHours = 24 }, { name = "aws", url = "https://ip-ranges.amazonaws.com/ip-ranges.json", action = "ignore", refreshHours = 12 }] }
    error_message = "The catalog lists ip_lists with their defaults."
  }
  assert {
    condition     = aws_lambda_function.ip_lists.handler == "lists.handler" && aws_lambda_function.ip_lists.filename == "tests/artifacts/router/router.zip" && aws_scheduler_schedule.ip_lists.schedule_expression == "rate(1 hour)"
    error_message = "The list function runs the router bundle's code, hourly."
  }
  assert {
    condition     = aws_s3_bucket.lists.bucket == "dmt-test-manager-ip-lists-111122223333" && output.ip_lists_catalog == "s3://dmt-test-manager-ip-lists-111122223333/catalog.json"
    error_message = "The bucket and the catalog output."
  }
  assert {
    condition     = aws_lambda_function.operations.environment[0].variables.ROUTER_IP_LISTS_CATALOG == "s3://dmt-test-manager-ip-lists-111122223333/catalog.json" && aws_lambda_function.operations.environment[0].variables.ROUTER_IP_LISTS_BUCKET == "dmt-test-manager-ip-lists-111122223333"
    error_message = "Installed routers get the catalog and may read the bucket."
  }
  assert {
    condition     = flatten([for s in data.aws_iam_policy_document.lists.statement : [for c in s.condition : c.values] if s.sid == "OrganizationRouters"]) == ["o-abcdefghij"]
    error_message = "The bucket admits the organization's principals only."
  }
  assert {
    condition     = contains(keys(aws_cloudwatch_metric_alarm.manager), "ip-lists-errors") && aws_lambda_function.watchdog.environment[0].variables.LISTS_BUCKET == "dmt-test-manager-ip-lists-111122223333"
    error_message = "The list function's errors alarm; the watchdog alarms on the lists' status."
  }
}

run "ip_lists_are_validated" {
  command = plan

  variables {
    ip_lists = [{ name = "bad name", url = "ftp://x/list", action = "block" }]
  }
  expect_failures = [var.ip_lists]
}

# The MFA policy (R6c): operators by default (the user pool optional, the API enforces it for administrators and
# operators); required turns the user pool's MFA on; the dashboard may set up the user's own authenticator.
run "mfa_operators_by_default" {
  command = plan

  variables {
    smoke_user = true
  }

  assert {
    condition     = aws_cognito_user_pool.main.mfa_configuration == "OPTIONAL" && aws_lambda_function.api.environment[0].variables.MFA_MODE == "operators"
    error_message = "By default the user pool's MFA is optional and the API enforces it for administrators and operators."
  }
  assert {
    condition     = contains(aws_cognito_user_pool_client.dashboard.allowed_oauth_scopes, "aws.cognito.signin.user.admin")
    error_message = "The dashboard's access token may set up the user's own authenticator."
  }
  assert {
    condition     = !contains(aws_cognito_user_pool_client.dashboard.write_attributes, "email") && length(aws_cognito_user_pool_client.dashboard.write_attributes) > 0 && !contains(aws_cognito_user_pool_client.smoke[0].write_attributes, "email")
    error_message = "Review I1: no token may change the account's email (a stolen access token would otherwise take the account over, around MFA)."
  }
  assert {
    condition     = aws_cognito_user_pool.main.user_attribute_update_settings[0].attributes_require_verification_before_update == toset(["email"])
    error_message = "An email changed by an administrator is kept until the new address is verified."
  }
  assert {
    condition     = length(setsubtract(["cognito-idp:AdminSetUserMFAPreference", "cognito-idp:AdminDeleteSoftwareToken"], flatten([for s in data.aws_iam_policy_document.api.statement : s.actions if s.sid == "Users"]))) == 0
    error_message = "An administrator resets another user's MFA through the API."
  }
}

run "mfa_required" {
  command = plan

  variables {
    mfa = "required"
  }
  assert {
    condition     = aws_cognito_user_pool.main.mfa_configuration == "ON" && aws_lambda_function.api.environment[0].variables.MFA_MODE == "required"
    error_message = "required: managed login asks everyone for an authenticator."
  }
}

# Passkeys (design 2026-10-18): choice-based sign-in with WebAuthn on the pool and the client in the optional and operators
# modes; required leaves the pool, the client and the dashboard as they were. Both pool blocks update in place (checked in
# the provider 6.67 source: no ForceNew).
run "passkeys_by_default" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool.main.sign_in_policy[0].allowed_first_auth_factors == toset(["PASSWORD", "WEB_AUTHN"])
    error_message = "Passkeys: the pool allows a password or a passkey as the first factor."
  }
  assert {
    condition     = aws_cognito_user_pool.main.web_authn_configuration[0].user_verification == "required" && aws_cognito_user_pool.main.web_authn_configuration[0].relying_party_id == null
    error_message = "Passkeys: user verification is required; without a custom domain the relying party is Cognito's default."
  }
  assert {
    condition     = toset(aws_cognito_user_pool_client.dashboard.explicit_auth_flows) == toset(["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_USER_AUTH"])
    error_message = "Passkeys: the dashboard client allows choice-based sign-in."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.PASSKEYS == "true"
    error_message = "Passkeys: the API is told."
  }
}

run "passkeys_on_a_domain" {
  command = plan
  # The configuration holds the user pool's endpoint and the client's id.
  override_resource {
    target          = aws_cognito_user_pool.main
    override_during = plan
    values = {
      id       = "eu-west-1_test"
      endpoint = "cognito-idp.eu-west-1.amazonaws.com/eu-west-1_test"
    }
  }
  override_resource {
    target          = aws_cognito_user_pool_client.dashboard
    override_during = plan
    values          = { id = "clientid" }
  }
  variables {
    local_dev = true
    domain = {
      dashboard       = "app.example.com"
      auth            = "auth.app.example.com"
      certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/test"
    }
  }

  assert {
    condition     = aws_cognito_user_pool.main.web_authn_configuration[0].relying_party_id == "auth.app.example.com"
    error_message = "With a custom domain, the relying party is the auth domain."
  }
  assert {
    condition     = contains(aws_cognito_user_pool_client.dashboard.callback_urls, "https://app.example.com/account") && contains(aws_cognito_user_pool_client.dashboard.callback_urls, "http://localhost:5173/account") && contains(aws_cognito_user_pool_client.dashboard.callback_urls, "http://localhost:5173/callback")
    error_message = "Passkeys: the registration page returns to /account (and the local development equivalent)."
  }
  assert {
    condition     = jsondecode(aws_s3_object.config.content).passkeys == true && jsondecode(aws_s3_object.config.content).authDomain == "auth.app.example.com"
    error_message = "Passkeys: the dashboard is told, with the auth domain."
  }
}

run "passkeys_off_in_required_mode" {
  command = plan
  override_resource {
    target          = aws_cognito_user_pool.main
    override_during = plan
    values = {
      id       = "eu-west-1_test"
      endpoint = "cognito-idp.eu-west-1.amazonaws.com/eu-west-1_test"
    }
  }
  override_resource {
    target          = aws_cognito_user_pool_client.dashboard
    override_during = plan
    values          = { id = "clientid" }
  }
  variables {
    mfa = "required"
    domain = {
      dashboard       = "app.example.com"
      auth            = "auth.app.example.com"
      certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/test"
    }
  }

  assert {
    condition     = length(aws_cognito_user_pool.main.sign_in_policy) == 0 && length(aws_cognito_user_pool.main.web_authn_configuration) == 0
    error_message = "required: the pool is as before."
  }
  assert {
    condition     = toset(aws_cognito_user_pool_client.dashboard.explicit_auth_flows) == toset(["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"])
    error_message = "required: the client is as before."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.PASSKEYS == "false"
    error_message = "required: no passkeys offered."
  }
  assert {
    condition     = !anytrue([for u in aws_cognito_user_pool_client.dashboard.callback_urls : endswith(u, "/account")])
    error_message = "required: no /account callback."
  }
  assert {
    condition     = jsondecode(aws_s3_object.config.content).passkeys == false
    error_message = "required: the dashboard is told no passkeys."
  }
}

run "passkeys_can_be_turned_off" {
  command = plan
  override_resource {
    target          = aws_cognito_user_pool.main
    override_during = plan
    values = {
      id       = "eu-west-1_test"
      endpoint = "cognito-idp.eu-west-1.amazonaws.com/eu-west-1_test"
    }
  }
  override_resource {
    target          = aws_cognito_user_pool_client.dashboard
    override_during = plan
    values          = { id = "clientid" }
  }
  variables {
    passkeys = false
    domain = {
      dashboard       = "app.example.com"
      auth            = "auth.app.example.com"
      certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/test"
    }
  }

  assert {
    condition     = length(aws_cognito_user_pool.main.sign_in_policy) == 0 && length(aws_cognito_user_pool.main.web_authn_configuration) == 0 && length(aws_cognito_user_pool_client.dashboard.explicit_auth_flows) == 2
    error_message = "passkeys = false: the pool and the client are as before."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.PASSKEYS == "false"
    error_message = "passkeys = false: the API is told."
  }
  assert {
    condition     = !anytrue([for u in aws_cognito_user_pool_client.dashboard.callback_urls : endswith(u, "/account")])
    error_message = "passkeys = false: no /account callback."
  }
  assert {
    condition     = jsondecode(aws_s3_object.config.content).passkeys == false
    error_message = "passkeys = false: the dashboard is told no passkeys."
  }
}

run "mfa_is_validated" {
  command = plan

  variables {
    mfa = "sometimes"
  }
  expect_failures = [var.mfa]
}

run "history_kept_400_days_by_default" {
  command = plan

  assert {
    condition     = aws_lambda_function.fleet.environment[0].variables.HISTORY_DAYS == "400"
    error_message = "The state history (R8) is kept 400 days by default."
  }
}

run "history_days_set" {
  command = plan

  variables {
    history_days = 90
  }
  assert {
    condition     = aws_lambda_function.fleet.environment[0].variables.HISTORY_DAYS == "90"
    error_message = "history_days reaches the fleet function."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.HISTORY_DAYS == "90"
    error_message = "history_days reaches the API function, which prices and reads the history."
  }
}

run "history_days_is_validated" {
  command = plan

  variables {
    history_days = 3
  }
  expect_failures = [var.history_days]
}

run "states_cache_an_hour_by_default" {
  command = plan

  assert {
    condition     = aws_lambda_function.api.environment[0].variables.STATES_CACHE_MINUTES == "60"
    error_message = "The bar of all workloads keeps each workload's figures an hour by default."
  }
}

run "states_cache_set" {
  command = plan

  variables {
    states_cache_minutes = 15
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.STATES_CACHE_MINUTES == "15"
    error_message = "states_cache_minutes reaches the API."
  }
}

run "states_cache_is_validated" {
  command = plan

  variables {
    states_cache_minutes = 0
  }
  expect_failures = [var.states_cache_minutes]
}

run "savings_job_daily_always_by_default" {
  command = plan

  assert {
    condition     = aws_lambda_function.savings.environment[0].variables.SAVINGS_BASELINE == "always" && aws_lambda_function.savings.environment[0].variables.SAVINGS_TIMEZONE == "UTC"
    error_message = "The savings baseline is 24/7 by default (R9)."
  }
  assert {
    condition     = aws_scheduler_schedule.savings.schedule_expression == "cron(30 0 * * ? *)"
    error_message = "The savings job runs once a day, at 00:30 UTC."
  }
  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.savings.statement : s.actions]), "pricing:GetProducts") && contains(flatten([for s in data.aws_iam_policy_document.api.statement : s.actions]), "pricing:GetProducts")
    error_message = "The job and the API read the Price List API."
  }
}

run "savings_business_hours" {
  command = plan

  variables {
    savings_baseline = "business-hours"
    savings_timezone = "Europe/Paris"
  }
  assert {
    condition     = aws_lambda_function.savings.environment[0].variables.SAVINGS_BASELINE == "business-hours" && aws_lambda_function.api.environment[0].variables.SAVINGS_TIMEZONE == "Europe/Paris"
    error_message = "The baseline reaches the job and the API."
  }
}

run "savings_baseline_is_validated" {
  command = plan

  variables {
    savings_baseline = "weekends"
  }
  expect_failures = [var.savings_baseline]
}

run "savings_timezone_is_validated" {
  command = plan

  variables {
    savings_timezone = "Paris time"
  }
  expect_failures = [var.savings_timezone]
}

run "savings_job_failures_alert" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.manager["savings-errors"].dimensions.FunctionName == "dmt-test-manager-savings" && aws_cloudwatch_metric_alarm.manager["savings-failed"].namespace == "AWS/SQS"
    error_message = "A failed savings run alerts (review I1): the function's errors and the runs the scheduler could not deliver."
  }
}

run "spot_prices_readable" {
  command = plan

  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.api.statement : s.actions if s.sid == "Prices"]), "ec2:DescribeSpotPriceHistory") && contains(flatten([for s in data.aws_iam_policy_document.savings.statement : s.actions if s.sid == "Prices"]), "ec2:DescribeSpotPriceHistory")
    error_message = "The API and the savings job read Spot prices (R9.5): ec2:DescribeSpotPriceHistory."
  }
}


run "idle_window_requests" {
  command = plan

  assert {
    condition     = contains(flatten([for s in data.aws_iam_policy_document.api.statement : s.actions if s.sid == "IdleWindowRequests"]), "lambda:InvokeFunction")
    error_message = "The API invokes the discovery function for a workload's requests (R10): lambda:InvokeFunction."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables["DISCOVERY_FUNCTION"] == "dmt-test-manager-discovery"
    error_message = "The API knows the discovery function (R10): DISCOVERY_FUNCTION."
  }
}

run "organization_conditions_by_default" {
  command = plan

  assert {
    condition = alltrue([
      for c in [
        [for s in data.aws_iam_policy_document.discovery.statement : s if s.sid == "AssumeDiscoveryRoles"][0].condition,
        [for s in data.aws_iam_policy_document.operations.statement : s if s.sid == "AssumeCommandRoles"][0].condition,
      ] : length(c) == 1 && one(c).variable == "aws:ResourceOrgID" && one(c).values[0] == "o-abcdefghij"
    ])
    error_message = "With an organization, the roles are assumed within it (aws:ResourceOrgID)."
  }
  assert {
    condition = alltrue([
      for c in [
        [for s in data.aws_iam_policy_document.manager_bus.statement : s if s.sid == "OrganizationRouters"][0].condition,
        [for s in data.aws_iam_policy_document.lists.statement : s if s.sid == "OrganizationRouters"][0].condition,
      ] : length(c) == 1 && one(c).variable == "aws:PrincipalOrgID" && one(c).values[0] == "o-abcdefghij"
    ])
    error_message = "With an organization, the routers' events and lists are accepted within it (aws:PrincipalOrgID)."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.DISCOVERY_MODE == "organization" && aws_lambda_function.discovery.environment[0].variables.DISCOVERY_MODE == "organization"
    error_message = "The perimeter's default mode is organization."
  }
}

run "account_deployment_without_an_organization" {
  command = plan

  variables {
    organization_id = null
    discovery_mode  = "account"
  }

  assert {
    condition = alltrue([
      for c in [
        [for s in data.aws_iam_policy_document.discovery.statement : s if s.sid == "AssumeDiscoveryRoles"][0].condition,
        [for s in data.aws_iam_policy_document.operations.statement : s if s.sid == "AssumeCommandRoles"][0].condition,
      ] : length(c) == 1 && one(c).variable == "aws:ResourceAccount" && one(c).values[0] == "111122223333"
    ])
    error_message = "Without an organization, the roles are assumed in the manager's account only (aws:ResourceAccount)."
  }
  assert {
    condition = alltrue([
      for c in [
        [for s in data.aws_iam_policy_document.manager_bus.statement : s if s.sid == "OrganizationRouters"][0].condition,
        [for s in data.aws_iam_policy_document.lists.statement : s if s.sid == "OrganizationRouters"][0].condition,
      ] : length(c) == 1 && one(c).variable == "aws:PrincipalAccount" && one(c).values[0] == "111122223333"
    ])
    error_message = "Without an organization, the routers' events and lists are accepted from the manager's account only (aws:PrincipalAccount)."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.DISCOVERY_MODE == "account" && aws_lambda_function.discovery.environment[0].variables.DISCOVERY_MODE == "account"
    error_message = "The perimeter's default mode is account."
  }
}

run "organization_mode_needs_an_organization" {
  command = plan

  variables {
    organization_id = null
  }
  expect_failures = [var.discovery_mode]
}

run "discovery_mode_is_validated" {
  command = plan

  variables {
    discovery_mode = "other"
  }
  expect_failures = [var.discovery_mode]
}

run "self_update_is_absent_without_install" {
  command = plan

  assert {
    condition     = length([for s in data.aws_iam_policy_document.api.statement : s if contains(["SelfUpdateRequests", "SelfUpdateRead", "SelfUpdateBuilds", "SelfUpdateLogs"], s.sid == null ? "" : s.sid)]) == 0
    error_message = "Without install, the API has no self-update statement."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.INSTALL_BUCKET == "" && aws_lambda_function.api.environment[0].variables.INSTALL_PROJECT == "" && aws_lambda_function.api.environment[0].variables.INSTALL_LOG_GROUP == ""
    error_message = "Without install, the three INSTALL_* variables are empty."
  }
}

run "self_update_rights_with_install" {
  command = plan

  variables {
    install = {
      bucket    = "dmt-install-111122223333-eu-west-1"
      project   = "dmt-test-install"
      log_group = "/aws/codebuild/dmt-test-install"
    }
  }

  assert {
    condition     = aws_lambda_function.api.environment[0].variables.INSTALL_BUCKET == "dmt-install-111122223333-eu-west-1" && aws_lambda_function.api.environment[0].variables.INSTALL_PROJECT == "dmt-test-install" && aws_lambda_function.api.environment[0].variables.INSTALL_LOG_GROUP == "/aws/codebuild/dmt-test-install"
    error_message = "The three INSTALL_* variables are set."
  }
  assert {
    condition     = length([for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SelfUpdateRequests"]) == 1 && [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SelfUpdateRequests"][0].actions == toset(["s3:PutObject"]) && [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SelfUpdateRequests"][0].resources == toset(["arn:aws:s3:::dmt-install-111122223333-eu-west-1/test/requests/*"])
    error_message = "Requests: s3:PutObject on <env>/requests/* only."
  }
  assert {
    condition = [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SelfUpdateRead"][0].actions == toset(["s3:GetObject"]) && [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SelfUpdateRead"][0].resources == toset([
      "arn:aws:s3:::dmt-install-111122223333-eu-west-1/test/results/*",
      "arn:aws:s3:::dmt-install-111122223333-eu-west-1/test/plans/*/release.json",
      "arn:aws:s3:::dmt-install-111122223333-eu-west-1/test/plans/*/plan.json",
      "arn:aws:s3:::dmt-install-111122223333-eu-west-1/test/applied.json",
      "arn:aws:s3:::dmt-install-111122223333-eu-west-1/test/cli.json",
      "arn:aws:s3:::dmt-install-111122223333-eu-west-1/test/release/SHA256SUMS",
      "arn:aws:s3:::dmt-install-111122223333-eu-west-1/test/release/CHANGELOG.md",
    ])
    error_message = "Read: s3:GetObject on the results, each plan's release.json and plan.json (never its tfplan), and the four objects."
  }
  assert {
    condition     = [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SelfUpdateBuilds"][0].actions == toset(["codebuild:ListBuildsForProject", "codebuild:BatchGetBuilds"]) && [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SelfUpdateBuilds"][0].resources == toset(["arn:aws:codebuild:eu-west-1:111122223333:project/dmt-test-install"])
    error_message = "Builds: the project only."
  }
  assert {
    condition = [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SelfUpdateLogs"][0].actions == toset(["logs:GetLogEvents"]) && [for s in data.aws_iam_policy_document.api.statement : s if s.sid == "SelfUpdateLogs"][0].resources == toset([
      "arn:aws:logs:eu-west-1:111122223333:log-group:/aws/codebuild/dmt-test-install",
      "arn:aws:logs:eu-west-1:111122223333:log-group:/aws/codebuild/dmt-test-install:*",
    ])
    error_message = "Logs: logs:GetLogEvents only, on the group and its streams only."
  }
}

run "install_is_validated" {
  command = plan

  variables {
    install = {
      bucket    = "other-bucket"
      project   = "dmt-test-install"
      log_group = "/aws/codebuild/dmt-test-install"
    }
  }
  expect_failures = [var.install]
}

run "update_check_daily_through_its_own_function" {
  command = plan

  assert {
    condition     = aws_lambda_function.update_check.function_name == "dmt-test-manager-update-check" && aws_lambda_function.update_check.handler == "update-check.handler"
    error_message = "The daily update check is a function of its own, with its own handler."
  }
  assert {
    condition = alltrue([
      for k in ["TABLE", "ENV", "VERSION", "ALERTS_TOPIC", "DASHBOARD_URL"] : contains(keys(aws_lambda_function.update_check.environment[0].variables), k)
    ])
    error_message = "The check reads the table, the alert topic and the dashboard URL, and knows the version running and the environment."
  }
  assert {
    condition     = aws_cloudwatch_log_group.update_check.name == "/aws/lambda/dmt-test-manager-update-check"
    error_message = "The check's logs are in its own group."
  }
  assert {
    condition     = aws_scheduler_schedule.update_check.name == "dmt-test-manager-update-check" && aws_scheduler_schedule.update_check.schedule_expression == "cron(0 7 * * ? *)"
    error_message = "The check runs once a day, at 07:00 UTC."
  }
  assert {
    condition     = aws_scheduler_schedule.update_check.target[0].retry_policy[0].maximum_retry_attempts == 0
    error_message = "A failed run is not retried: the next day tries again."
  }
  assert {
    condition     = sort(flatten([for s in data.aws_iam_policy_document.update_check.statement : s.actions])) == sort(["dynamodb:GetItem", "dynamodb:PutItem", "sns:Publish", "logs:CreateLogStream", "logs:PutLogEvents"])
    error_message = "The check reads and writes two table items, publishes to the alert topic and writes its logs, nothing else."
  }
  assert {
    condition     = join(",", flatten([for s in data.aws_iam_policy_document.update_check_scheduler.statement : tolist(s.actions)])) == "lambda:InvokeFunction"
    error_message = "The scheduler only invokes the function."
  }
}
