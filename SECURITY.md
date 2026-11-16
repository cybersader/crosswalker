# Security policy

## Supported versions

Security fixes target the latest release of Crosswalker. If a problem affects an
older release, report it only when the latest release has it too.

## Report a vulnerability privately

Use this repository's **Security → Report a vulnerability** form on GitHub.
It sends the report privately to the maintainer.

Do not open a public issue containing exploit details, secrets or private data.
Include the affected version, the impact and minimal steps to reproduce it. Do
not send live credentials. We aim to acknowledge a report within seven days and
agree a coordinated disclosure timeline after triage. This is not a guaranteed
time to a fix.

## Scope

In scope: anything in the plugin or its command line that reads or writes files
outside the chosen vault, runs code taken from imported data, or exposes vault
content to anyone who should not see it.
