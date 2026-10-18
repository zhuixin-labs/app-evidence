# Security

## Authorized use

Analyze only applications you own or have explicit permission to inspect. You are
responsible for complying with applicable licenses, terms, and law.

## Credentials

AppTrace never asks the agent for Apple passwords, 2FA codes, cookies, or keychain
passphrases. Authentication happens in the user's terminal.

## Execution boundary

- AppTrace does not execute the target application.
- Installers and extracted scripts are not run.
- Network endpoints discovered in a package are not contacted.
- Encrypted code is marked as protected and is not presented as trustworthy source.

## Local data

Artifacts, Evidence, reports, and the local database stay in the user's workspace.
AppTrace does not upload them to a hosted service by default.

## Reporting a vulnerability

Please report security issues privately to the repository maintainers. Do not include
real credentials, private application packages, or personal data in a public issue.
