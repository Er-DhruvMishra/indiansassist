# Contributing

Thank you for helping with IndiansAssist.

## Licence of contributions

IndiansAssist is licensed under the **GNU Affero General Public License, version 3 only** (AGPL-3.0-only; see
[LICENSE](LICENSE) and [NOTICE](NOTICE)). Your contribution is licensed under AGPL-3.0-only too.

Do not copy code from projects whose licence is not compatible, and do not copy code from RustDesk or MinIO (reference
reading only, see [docs/LICENSE-REGISTER.md](docs/LICENSE-REGISTER.md)). A new dependency needs a row in
`docs/LICENSE-REGISTER.md`, with its licence, in the same change; `pnpm license:check` checks this.

### Sign off every commit

Every commit in a pull request must end with a `Signed-off-by:` line in your real name and an email address you can be
reached at, the same as the commit author. `git commit -s` adds it for you:

```
git commit -s -m "Fix the panel's close button"
```

which writes, at the end of the commit message:

```
Signed-off-by: Jane Example <jane@example.test>
```

To add it to commits you already made on your branch: `git rebase --signoff master` (then force-push your branch). CI
checks every commit of a pull request and fails if one has no sign-off.

By adding the sign-off you agree to two things:

**1. The Developer Certificate of Origin 1.1** (from https://developercertificate.org, reproduced unchanged):

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

The open source licence it refers to is AGPL-3.0-only.

**2. The app-store permission.** The project publishes its own apps through app stores, and those stores' terms add
conditions that AGPL-3.0-only alone does not allow. So that the project can keep doing that once other people's code is
in the apps, you also agree to this:

> I license my contribution under AGPL-3.0-only. In addition, I permit the IndiansAssist project to distribute my
> contribution, as part of the IndiansAssist project's own apps, through app stores (such as the Apple App Store and
> Google Play) under those stores' terms.

That permission is deliberately narrow, and it is **not a dual licence**:

- It covers one thing: the IndiansAssist project distributing its own apps through app stores. It gives nobody else any
  right, and it does not cover any other product or any other way of distributing.
- Your contribution stays **AGPL-3.0-only for everyone**, including in those apps. Anyone who gets an app from a store
  can still get its complete source code under AGPL-3.0-only, and nothing about the permission lets anyone take the
  code proprietary.
- The project offers no other licence of your contribution, commercial or otherwise. You keep your copyright.

## How changes are reviewed

- Committers are trusted to change the source code without further review. Today the only committer is Dhruv Mishra
  ([Er-DhruvMishra](https://github.com/Er-DhruvMishra)); see [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).
- **Every change from anyone else is reviewed by a committer** before it is merged. Open a pull request against
  `master`; please keep it focused on one change and describe what it does and how you tested it.
- Releases are built by CI from tagged commits, and each release is approved by hand before it is signed.

## Before you open a pull request

```
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm license:check
```

The Rust agent has its own checks (`pnpm agent:test`, `pnpm agent:clippy`); see [README.md](README.md).

## Issues and security

Bugs and feature requests: [GitHub issues](https://github.com/Er-DhruvMishra/indiansassist/issues). **Security
problems:** never in a public issue; follow [SECURITY.md](SECURITY.md).
