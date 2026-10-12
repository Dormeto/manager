# The dev dashboard's certificate (us-east-1, CloudFront and the Cognito custom domain): the manager module is given it,
# as a customer gives theirs.
resource "aws_acm_certificate" "edge" {
  provider                  = aws.us_east_1
  domain_name               = var.dashboard_domain
  subject_alternative_names = [var.auth_domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = { for o in aws_acm_certificate.edge.domain_validation_options : o.domain_name => o }

  zone_id         = var.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "edge" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.edge.arn
  validation_record_fqdns = [for r in aws_route53_record.certificate_validation : r.fqdn]
}
