# SignPath Foundation application checklist

Free code signing for open source projects from SignPath Foundation (<https://signpath.org>), with the SignPath.io
service (<https://about.signpath.io>). Conditions read from <https://signpath.org/terms> on 7 November 2026. This file
says where the project meets each condition and what the owner, Dhruv Mishra
([Er-DhruvMishra](https://github.com/Er-DhruvMishra)), still has to do.

## Conditions and where they are met

| # | Condition | Where the project meets it | Status |
|---|---|---|---|
| 1 | OSI-approved licence for the project, no commercial dual licensing | `LICENSE` (the official AGPL-3.0 text from gnu.org, byte for byte), `NOTICE` (AGPL-3.0-only, Copyright (C) 2026 Dhruv Mishra), `README.md` "Licence and policies", website `license.html` | Met |
| 2 | OSI-approved licences for all components | `docs/LICENSE-REGISTER.md`, section "Licence compatibility audit for AGPL-3.0-only" | Met for everything SignPath would sign (the Windows agent, service binaries and `.msi`) and for the Linux, macOS, iOS and Android builds: F1 resolved (the agents use the operating system's trust store; `webpki-roots` is gone), F2 resolved (egui's fonts replaced by Noto Sans and Noto Emoji, OFL-1.1), F3 resolved (both mobile apps use a WebRTC build whose BoringSSL is Apache-2.0: iOS M155, Android `io.github.webrtc-sdk:android` 150.7871.04, M150), F4 handled (`CONTRIBUTING.md`: DCO sign-off and a narrow app-store permission, checked by CI) | Met |
| 3 | The project is actively maintained and already released | GitHub Releases | **Owner:** publish a first release |
| 4 | The functionality is described on the download page | website `download.html`: every platform, what it does | Met |
| 5 | A code signing policy on the project's home page | website `index.html` and `download.html`, section "Code signing policy" with the sentence "Free code signing provided by SignPath.io, certificate by SignPath Foundation" (linked to about.signpath.io and signpath.org); full policy at `code-signing.html` and `CODE_SIGNING_POLICY.md` | Met; says plainly that releases are self-signed (Windows) and GPG-signed (Linux) until approval |
| 6 | Team roles with members: committers and reviewers, approvers | `CODE_SIGNING_POLICY.md` "Team roles" (all roles: Dhruv Mishra, linked GitHub profile); `CONTRIBUTING.md` (every change from a non-committer is reviewed) | Met |
| 7 | Every signing request is approved by hand | `CODE_SIGNING_POLICY.md` "Release approval"; the SignPath step of the release workflow (signing and CI work) | Met in policy; the approval is configured in SignPath after onboarding |
| 8 | Builds are verifiable: built from the public source on a CI system | `.github/workflows/release.yml` and `docs/release.md` section 4 (signing and CI work); releases built from tags | Met once the repository is public |
| 9 | Privacy: a privacy policy, or a statement that nothing is transferred | `PRIVACY.md`, website `privacy.html` (data processed, regions, retention, erasure, the operator as controller, third-party services: Anthropic, ticketing services, the mail server, GitHub) | Met |
| 10 | Multi-factor authentication for all team members on GitHub and SignPath | Stated in `CODE_SIGNING_POLICY.md` | **Owner:** turn it on |
| 11 | No malware, no unwanted behaviour, consent for remote access | Consent screens, the always-on indicator, consent receipts and the audit chain (`docs/PRD.md`, `PRIVACY.md`) | Met; expect SignPath to ask about remote access, point them at the consent design |
| 12 | Security contact | `SECURITY.md`, website `security.html`: GitHub private vulnerability reporting, no email | **Owner:** enable private vulnerability reporting |
| 13 | (AGPL, not a SignPath condition) The web app offers its source to network users, section 13 | "Source code" link in the footer of the console, the Desk pages and the public pages (`apps/web/src/components/SourceLink.tsx`) | Met |

## Before applying: the owner's checklist

1. **Make the repository public** (`Er-DhruvMishra/indiansassist`): **Settings**, **General**, **Danger Zone**,
   **Change visibility**. Before that, check that no secret is in the history.
2. **Turn on multi-factor authentication** on GitHub (**Settings**, **Password and authentication**) and, after
   onboarding, on SignPath. Optionally require it for the organisation, if the repository moves to one.
3. **Enable private vulnerability reporting:** repository **Settings**, **Security**, **Private vulnerability
   reporting**, **Enable**. `SECURITY.md` relies on it.
4. **Connect the domain and enable Pages:** follow `site/README.md` (Pages source "GitHub Actions", custom domain
   `indiansassist.com`, the DNS `A`/`AAAA` records and the `www` `CNAME`, then **Enforce HTTPS**). Check that
   <https://indiansassist.com>, `/download.html` and `/code-signing.html` load.
5. **The licence findings** in `docs/LICENSE-REGISTER.md` (audit section):
   - F1 `webpki-roots`: **resolved** (the operating system's trust store through `rustls-platform-verifier`);
   - F2 egui's default fonts: **resolved** (Noto Sans and Noto Emoji, SIL OFL 1.1, embedded in `ia-ui`);
   - F3 BoringSSL in the WebRTC builds: **resolved** for both mobile apps. iOS (`stasel/WebRTC` 155.0.0, M155) and,
     since 8 Nov 2026, Android (`io.github.webrtc-sdk:android` 150.7871.04, M150, replacing `stream-webrtc-android`
     1.3.10 at M125) both bundle a BoringSSL from after its Apache-2.0 relicensing (Android: `f91f144`, 28 May 2026,
     1,318 commits after it); the evidence is under F3 in the register;
   - F4 app-store distribution: **handled** (`CONTRIBUTING.md`: every commit carries a DCO 1.1 sign-off, which also
     grants the narrow app-store permission; CI's `signoff` job checks every pull request).
6. **Publish a first release** on GitHub Releases, built by the release workflow from a tag, with `SHA256SUMS`, the
   Linux `.asc` signatures and the self-signed Windows files; check that the public keys in `site/keys/` match the keys
   that signed it.
7. **Apply** at <https://signpath.org/apply>: project name IndiansAssist; repository
   <https://github.com/Er-DhruvMishra/indiansassist>; home page <https://indiansassist.com>; code signing policy
   <https://indiansassist.com/code-signing.html>; licence AGPL-3.0-only; what is signed: the Windows agent `.exe`, the
   service binaries and the `.msi` installer, built by GitHub Actions. Use GitHub issues or the application form for
   correspondence; do not publish a personal email address in the repository.
8. **After approval:** connect the repository to SignPath, set the release workflow's provider to `signpath`
   (`docs/release.md` section 4), and update `CODE_SIGNING_POLICY.md`, `site/code-signing.html`, `site/index.html`
   and `site/download.html` to remove the "not granted yet" status.
