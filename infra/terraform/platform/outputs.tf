output "certificate_arn" {
  description = "Dev's validated certificate (us-east-1), the CLI install's --certificate-arn."
  value       = aws_acm_certificate_validation.edge.certificate_arn
}
