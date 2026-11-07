# Contributing

Thank you for helping with IndiansAssist.

## Licence of contributions

IndiansAssist is licensed under the **GNU Affero General Public License, version 3 only** (AGPL-3.0-only; see
[LICENSE](LICENSE) and [NOTICE](NOTICE)). By opening a pull request you agree that your contribution is licensed under
AGPL-3.0-only, and you confirm that you wrote it or have the right to submit it under that licence.

Do not copy code from projects whose licence is not compatible, and do not copy code from RustDesk or MinIO (reference
reading only, see [docs/LICENSE-REGISTER.md](docs/LICENSE-REGISTER.md)). A new dependency needs a row in
`docs/LICENSE-REGISTER.md`, with its licence, in the same change; `pnpm license:check` checks this.

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
