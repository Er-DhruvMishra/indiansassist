# Privacy policy

Last updated: 7 November 2026. This policy covers the IndiansAssist software (the web app, the api and recorder
services, the Windows, Linux and macOS agents, the Android and iOS apps and the browser extension) and the project
website at indiansassist.com. It describes what the software does with personal data, as built in this repository.

## Who is responsible

IndiansAssist is open source software (AGPL-3.0-only) that anyone can run on their own servers.

- **Each IndiansAssist server is run by an operator** (for example a company's IT team or a service provider). The
  operator, and the organisation that signs up on that server, decide what is collected and how long it is kept. **The
  operator of a server is the controller of the data on it.** Questions about your data on a server, and requests to
  see, correct or delete it, go to that operator or to the organisation that invited you to a session.
- **The project** publishes the source code, the releases and this website. Downloading the software from GitHub
  Releases does not send the project any data about you beyond what GitHub itself records (see "Third-party services").
- **A hosted service at indiansassist.com**, if and when it is offered, is run by the project owner, Dhruv Mishra, who is
  then the operator, and so the controller, for the organisations that sign up there. This policy applies to it. Its
  default data region is India (`in-mum`).

The project does not sell personal data, does not show advertising and does not run analytics or tracking in the
software or on this website.

## What the software processes

### Accounts (technicians and administrators)

- The account record holds the email address, name, role, status, the date of the last sign-in, and, for invited
  users, a hashed invite token. Passwords are stored only as an Argon2id hash. Password reset tokens are stored only as
  a hash.
- Single sign-on, if the organisation turns it on: the identity provider's issuer and subject identifier for the user,
  and when the link was made and last used.
- Sign-in sessions: a hash of the session token, the IP address and browser user agent of the sign-in, the time it was
  created and last used, its expiry and how the user signed in. Failed and successful sign-in attempts are kept for 24
  hours (a SHA-256 hash of the email address, the IP address and whether it succeeded) to limit password guessing;
  then they are deleted.
- Cookies: `ia_session` (the sign-in session; HttpOnly, 7 days) and, only while a single sign-on login is in progress,
  a short-lived cookie that binds the login to the browser (10 minutes). No other cookies. The Desk join page and the
  phone camera page set no cookie; the join page keeps the name you typed in the browser's own storage so you do not
  have to type it again.

### Support sessions

- **Session metadata:** the session's times and state, the consent you gave and when, the name you typed on the join
  page (the "Desk label"), your browser's user agent or the agent's client type, connection statistics, and the region.
- **Screen, voice and control** travel directly between your device and the technician's browser over an encrypted
  WebRTC connection (DTLS-SRTP). When a direct connection is not possible, they pass through the operator's relay
  (TURN) server, still encrypted end to end between the two browsers or apps. The server does not see the screen unless
  server recording is on (below).
- **Chat and file transfers** go over encrypted WebRTC data channels between the two sides. The server does not store
  the chat text or the file contents. It stores, for each file, its name, size and SHA-256 hash; for chat, only a count
  of messages. Until the data channel is open, a chat message can pass through the server's signalling connection; it
  is not logged or stored there.
- **The audit chain.** Each organisation has an append-only, hash-chained record of what happened in its sessions
  (who knocked, who accepted, consent, control, files, recordings, administrative changes), so that the record cannot be
  altered unnoticed. Personal values (email addresses, Desk labels, user agents, file names) are written into the chain
  only as a keyed hash (SHA-256 with a secret per organisation), never in plain text. The technician's display name is
  written in plain text, because the chain exists to record what the technician did.
- **Installed agents (unattended access):** for a managed device, its name, operating system and agent version, a
  hardware fingerprint, the IP address it last connected from, the MAC address (encrypted, with a keyed hash for
  lookup) if wake-on-LAN is used, and an optional email address for consent receipts.

### Recordings (optional)

Recording is controlled by the organisation's administrator, who chooses one of: off; recorded by the technician's
console only when the technician clicks **Record** (the default); recorded by the server for every session; or both.
The person sharing their screen is told before and while a session is recorded. A recording is stored, with its SHA-256
hash in the audit chain, in the operator's storage: a folder on the server or an S3-compatible object store chosen by
the operator, under the organisation's data region. The administrator can set a retention period from 1 to 3650 days,
after which recordings are deleted automatically; with no period set, they are kept until deleted.

### AI summaries (optional, off by default)

Session summaries are off unless an organisation administrator turns them on. The administrator chooses the provider:

- **An in-region model** run by the operator (any server that speaks the OpenAI-style chat-completions API, such as
  vLLM, llama.cpp or Ollama). The data stays with the operator.
- **Anthropic**, only if the operator has configured an Anthropic API key and allowed it for the region, and only after
  the administrator types an exact acknowledgement that the data is processed by Anthropic, possibly outside the region.

What is sent: a list of the session's events, with people named by role and files described by type and size only.
The chat transcript is included only if the administrator also turns on "include the chat" and a notice was posted in
the chat. Before anything is sent, a redaction step (in the browser and again in the api) removes keys, tokens,
passwords and secrets, email addresses, card numbers, Aadhaar and PAN numbers, phone numbers, MAC and IP addresses,
user folder paths and long random strings. Names and postal addresses are not reliably detected and are not removed. A
transcript is held in memory for at most 30 minutes and is never written to the database; the resulting summary is
stored with the session.

### Ticketing integrations (optional, off by default)

An administrator can connect Zoho Desk, ServiceNow, Jira, Freshdesk or a webhook of their own. When a technician sends a
session to a ticket, the integration receives the title, the summary or note, a link to the session, the session's tier
and times, the technician's name, the audit chain's status, and the requester's email address only if the technician
typed it. The credentials for the integration are stored encrypted.

### Email

The server sends email only if the operator configures an SMTP server; by default it only writes mail to its log. The
messages are: invitations, password reset and its notice, single sign-on break-glass notices (including the IP address
of the sign-in), consent receipts for managed devices, and notices about organisation erasure.

### Server logs and metrics

The web server logs the requesting IP address and the path (without query string). The api logs the requesting address
and redacts request bodies, tokens, transcripts and similar fields; chat text is never logged. Metrics are counts and
timings with no user or IP labels, served on an internal port only. How long logs and backups are kept is set by the
operator.

## Data regions

An organisation chooses its data region when it signs up (India `in-mum` by default, the EU `eu-fra` or the US
`us-east`); it cannot be changed later. Each region is served by its own servers, and an organisation's database rows,
recordings and summaries stay in its region. The **Residency** page of the console lists where each kind of data lives
and which outside services, if any, the organisation has turned on (for example a third-party STUN server, Anthropic or a
ticketing service).

## Retention and deletion

- Sign-in attempts: 24 hours. Recordings: the period the administrator sets, or until deleted.
- Accounts, session metadata, the audit chain, file metadata and summaries are kept for the life of the organisation.
  An administrator can disable a user; the software has no self-service deletion of a single account, so ask the
  organisation or the operator.
- **Organisation erasure:** an administrator can erase the whole organisation (two administrators, or one with a
  confirmation by email, then a 7- or 14-day cooling-off period). Erasure deletes the stored files and recordings,
  deletes or scrubs the database rows, and destroys the organisation's audit secret, so every hashed personal value in
  the audit chain can no longer be linked to a person. The server then issues a signed erasure certificate. The audit
  entries themselves, with technicians' names and typed reasons, are kept as the record of what happened. Erasure cannot
  reach the operator's backups (they expire on the operator's backup schedule) or data already sent to a third party.

## The apps and agents

The Windows, Linux and macOS agents, the Android and iOS apps and the browser extension talk only to the IndiansAssist
server of the organisation that set them up (and, for the media, to the other side of the session, through the
operator's relay when needed). They contain no analytics, advertising, crash reporting or update check that contacts the
project or anyone else. In an attended session nothing is captured before you give consent on the device. On a device
that an organisation manages for unattended access, its policy decides whether the person at the device must approve
each session; either way an always-on-top indicator that cannot be switched off is shown while a session is live, and a
consent receipt records the session.

The browser extension asks for access to all sites because it cannot know in advance which tab you will share; it
captures only the tabs you choose to share, only during a session you accepted.

## The website and the web app

This website (indiansassist.com, served by GitHub Pages) and the IndiansAssist web app load no third-party scripts,
fonts or analytics, and set no tracking cookies. In the provided nginx configuration, the web app's content security policy lets it load
scripts, styles, images and frames only from its own server.

## Third-party services you may meet

Each has its own privacy policy, which applies to the data it receives:

- GitHub, which hosts the source code, the releases and this website and records visitors' IP addresses:
  https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement
- Anthropic, only when an organisation turns on Anthropic summaries: https://www.anthropic.com/legal/privacy
- Ticketing services, only when an organisation connects one: Zoho (https://www.zoho.com/privacy.html), ServiceNow
  (https://www.servicenow.com/privacy-statement.html), Atlassian Jira (https://www.atlassian.com/legal/privacy-policy),
  Freshworks Freshdesk (https://www.freshworks.com/privacy/), or the operator's own webhook.
- The operator's email (SMTP) provider, which carries the mail listed above; its privacy policy is the one that the
  operator's provider publishes.
- A third-party STUN server, only if the operator configures one (the default configuration uses the operator's own
  relay server).
- Your identity provider, if your organisation uses single sign-on.

## Your rights

Depending on where you live (for example under India's Digital Personal Data Protection Act or the EU GDPR), you may
have the right to access, correct or delete your personal data. Send the request to the operator of the server or the
organisation that holds your data. For the hosted service at indiansassist.com, if offered, or a question about this
policy, open an issue at https://github.com/Er-DhruvMishra/indiansassist/issues (do not put personal data in a public
issue; say that you need a private channel and the owner will reply). To report a security problem, see
[SECURITY.md](SECURITY.md).

## Changes

Changes to this policy are made in the public repository, so every version and its date are in the history of
[PRIVACY.md](https://github.com/Er-DhruvMishra/indiansassist/commits/master/PRIVACY.md).
