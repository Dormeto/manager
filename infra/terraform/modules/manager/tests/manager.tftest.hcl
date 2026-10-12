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
    target = data.aws_region.current
    values = { region = "eu-west-1" }
  }
}
mock_provider "archive" {}
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
    condition     = aws_lambda_function.access_check.handler == "check.handler" && aws_s3_object.router_bundle["router.zip"].key == "router/0.0.0-test/router.zip"
    error_message = "The release's bundles and versions are used."
  }
  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "ACTIVE"
    error_message = "The users are protected from a mistaken destroy by default."
  }
}

run "uninstall_lifts_the_users_protection" {
  command = plan
  variables {
    deletion_protection = false
  }

  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "INACTIVE"
    error_message = "deletion_protection = false lets terraform destroy remove the user pool."
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
}

run "missing_artifacts_fail_the_plan_with_their_paths" {
  command = plan
  variables {
    artifacts_dir = "tests/no-such-release"
  }
  expect_failures = [
    data.archive_file.api,
    data.archive_file.discovery,
    data.archive_file.operations,
    data.archive_file.access_check,
    data.archive_file.fleet,
    aws_s3_object.router_bundle,
    aws_s3_object.config,
  ]
}
