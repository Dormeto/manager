# Savings estimate

The savings estimate before install, what Dormeto would save on an AWS account or organization with read access only,
is the [Dormeto CLI](https://github.com/Dormeto/cli). Its options, phases, reports and permissions are documented there.

```bash
brew install dormeto/tap/dormeto
npx @dormeto/cli estimate --profile <your-aws-profile> --uptime
curl -fsSL https://dormeto.com/install.sh | sh
go install github.com/Dormeto/cli/cmd/dormeto@latest
```

Then `dormeto estimate --profile <your-aws-profile> --uptime`.

This repository's `npm run estimate` and `packages/estimate` no longer exist.
