# Savings estimate

The savings estimate before install, what Dormeto would save on an AWS account or organization with read access only,
is the [Dormeto CLI](https://github.com/Dormeto/cli). Its options, phases, reports and permissions are documented there.

Install it one way (each gives the same `dormeto` binary):

```bash
brew install dormeto/tap/dormeto                        # Homebrew, macOS and Linux
curl -fsSL https://dormeto.com/install.sh | sh          # or the install script
go install github.com/Dormeto/cli/cmd/dormeto@latest    # or Go
```

On Windows, download `dormeto_<version>_windows_amd64.zip` from the
[latest release](https://github.com/Dormeto/cli/releases/latest), unzip it and put `dormeto.exe` in a folder of your
`PATH`. Then `dormeto estimate --profile <your-aws-profile> --uptime`.

This repository's `npm run estimate` and `packages/estimate` no longer exist.
