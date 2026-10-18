# Dev's certificate (us-east-1, CloudFront and the Cognito custom domain; certificate.tf), given to the CLI install of
# the dev manager (dormeto install --certificate-arn, see the certificate_arn output).
#
# The manager itself is a CLI install since 2026-10-18 (adopted: its resources are managed by the install's CodeBuild
# project dmt-dev-install, its state in s3://dmt-install-<account>-<region>/dev/manager.tfstate). Dev is updated with
# dormeto install or its dashboard (docs/development.md); never apply an old checkout's configuration that still holds
# the manager module.
