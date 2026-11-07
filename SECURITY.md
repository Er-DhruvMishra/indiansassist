# Security policy

IndiansAssist gives people remote access to computers, so security reports are taken seriously and handled first.

## Reporting a vulnerability

**Please do not report security problems in public issues, discussions or pull requests.**

Report them privately through GitHub's private vulnerability reporting:

1. Open <https://github.com/Er-DhruvMishra/indiansassist/security/advisories/new> (or the repository's **Security**
   tab, then **Report a vulnerability**).
2. Describe the problem, the affected component (web app, api, recorder, an agent, an app, the extension, the
   installers or the release signing) and version, and the steps to reproduce it. A proof of concept helps.

Only the maintainers can see the report. There is no security email address; private vulnerability reporting is the
only private channel.

## What to expect

- An acknowledgement within 7 days.
- An assessment and, for a confirmed problem, a plan for the fix within 30 days. Fixes for problems that let someone
  watch or control a device without consent, bypass sign-in, or tamper with the audit chain or a release signature come
  first.
- A GitHub security advisory and a fixed release once the fix is out, crediting you unless you prefer otherwise.

Please give the project a reasonable time to fix the problem before you disclose it, and do not access data that is not
yours, disrupt services, or test against servers you do not run. Testing against your own self-hosted instance is
welcome.

## Supported versions

Security fixes go into the latest release. Operators of self-hosted servers should keep their server, agents and apps on
the latest release.

## Scope

In scope: the code in this repository and the files published on its
[GitHub Releases](https://github.com/Er-DhruvMishra/indiansassist/releases), including their signatures (see
[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)). Out of scope: how a particular operator configures and runs their own
server (report those to the operator), and third-party services (report those to their owners).
