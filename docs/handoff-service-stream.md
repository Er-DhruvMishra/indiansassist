# Handoff: the Phase D service stream and the Phase C elevation wiring

This is a self-contained brief for a session that has a person at the machine. Everything else in
Phases A to D is built, tested and committed; this is the remaining stream. It is handed over
rather than done in the background for two reasons: the work needs a real console session to
verify (a consent prompt, a locked screen, a service restart), and a disposable machine to install
on. Do not install anything that is being built onto the development machine.

## The prompt to paste into the new session

> You are working in the IndiansAssist monorepo at `C:\xampp\htdocs\indiansassist.com`.
> Windows 11, Node 22, pnpm 11, Rust 1.99 MSVC and Go 1.27 are installed. For cargo, run
> `export PATH="$USERPROFILE/.cargo/bin:$PATH"` in every bash call. There is no Docker.
>
> Vocabulary is inverted: **Desk** is the computer being helped, **Assist** is the technician
> console.
>
> Your task is the service stream of `docs/specs/phase-d-contracts.md` (revision 4), plus the
> elevation wiring left open in `docs/specs/phase-c-contracts.md`. Read both contracts before
> writing code; they are binding and contain every shape, name and rule you need. The sections
> that define your work are:
>
> - Phase D section 4: the service and the per-session desktop worker, and how the worker reuses
>   the existing Phase C agent.
> - Phase D section 5: the capabilities the service adds, and the limits section 5.5 is honest about.
> - Phase D section 10: self-healing and tamper alerting.
> - Phase D section 11: the crates to create, their dependencies and licences, and the build rules.
> - Phase D section 12.2: what the installer expects of the service, including the dependency list
>   that `packaging/README.md` records as owed by this stream.
> - Phase D section 15.2: your test requirements, and the decision-parity fixture named there that
>   does not exist yet.
> - Phase C section 7.3: the elevation flow. Its secure channel is already built and unit-tested in
>   `agent/crates/ia-agent/src/hopipe.rs`; what is missing is connecting it to a session, which
>   `agent/README.md` records as stubbed.
>
> The server side is complete and is your fixed target: do not change it to suit the client. The
> device protocol, enrollment, policy decisions, the offline queue, wake, tamper and receipts all
> exist and are covered by `pnpm smoke:p4` (15 steps) and the api suite. Read
> `apps/api/src/fleet/*` and `packages/shared/src/fleet/*` for the shapes you must produce, and
> `scripts/smoke/flow-p4.mjs` for the exact message sequence the server accepts from a device.
>
> ### Rules
>
> - **Never install, repair or uninstall the product on this machine.** Build the installer with
>   `pnpm packaging:msi` and validate it, nothing more. Install only in a disposable virtual
>   machine or sandbox, and only with the person's agreement.
> - **Never run a playbook or script that changes this machine.** In tests use only the read-only
>   fixture catalogue at `agent/crates/ia-agent/tests/fixtures/playbook-catalogue.json`.
> - **Never trigger a real elevation prompt in an automated run.** Automated tests use the test
>   launcher seam, as `agent/crates/ia-agent/tests/hopipe.rs` already does. A real prompt is only
>   for a manual check the person approves.
> - Run the agent with `--synthetic-capture` in any automated run, so no input reaches the real
>   desktop.
> - Ports 4000 and 4100 are held by leftover test processes you must not stop. Start anything of
>   your own on another port, and stop only what you started.
> - When you start the API yourself, set `API_ORIGIN` to match the port, for example
>   `PORT=4105 API_ORIGIN=http://localhost:4105`. Otherwise the well-known document, the signal
>   URL and the download URLs all point at port 4000 and you will chase phantom failures.
> - If the permission system refuses a command, stop that line of work and report it. Do not retry
>   it with a different path or wording.
> - Do not `git add` or commit; hand the work back and let the coordinator commit.
>
> ### Deliverables
>
> 1. The crates of section 11.1, building clean, with the unit tests section 15.2 asks for.
> 2. The worker launched and adopted per section 4, joining a server-opened session with the
>    single-use credential the server already issues, and reusing the Phase C agent rather than a
>    second implementation.
> 3. The capabilities of section 5, each behind the policy flag and the audit entry the contract
>    names, and each reporting itself honestly in the device's advertised features so the console
>    greys out what a machine cannot do.
> 4. Self-healing and tamper alerting per section 10, including the signed events the server
>    already accepts.
> 5. The elevation flow of Phase C section 7.3 connected end to end, with the generation question
>    that section 5 of `agent/README.md` records resolved in the contract first if it still stands.
> 6. The cross-language decision-parity fixture of section 15.2, generated into
>    `packages/shared/test/fixtures/fleet/` and asserted from both sides, so the policy decision
>    cannot drift between the server and the service.
> 7. `docs/specs/phase-d-contracts.md` and `agent/README.md` updated to say what is built and what
>    is not, replacing the "not built" rows your work closes.
>
> ### Test plan
>
> Automated, which you run yourself:
>
> - `cargo fmt --all --check`, `cargo clippy --all-targets --all-features -- -D warnings`,
>   `cargo test --workspace --all-features` in `agent/`, all clean, and
>   `cargo build --release` producing binaries under the size limit of section 11.3.
> - The existing suites stay green: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`,
>   `pnpm -r test`, `pnpm test:scripts`, `pnpm license:check`, `pnpm agent:fixtures`,
>   `pnpm fleet:fixtures`, `pnpm packaging:test`.
> - Every smoke still passes against an API you start on your own port: `pnpm smoke`,
>   `smoke:p2`, `smoke:p3`, `smoke:recorder`, `smoke:p4`.
> - `pnpm e2e` and `pnpm e2e:p3` still pass, since the worker is the Phase C agent and must not
>   regress it.
> - `pnpm packaging:msi` (the strict build, not the placeholder) succeeds once the real binaries
>   exist, and the MSI passes validation.
> - A loopback or harness test for the device side of the service, in the spirit of the existing
>   `agent/crates/ia-agent/tests/*`, so the service's own protocol handling is covered without a
>   real installation.
>
> Manual, which needs the person at the machine. Ask before each, explain what will happen, and
> record the result:
>
> - Install the signed MSI in a disposable virtual machine, enroll it against a token from the
>   console, and confirm the device appears online in the fleet page with its reported features.
> - Open an unattended session from the console against that machine and confirm what the contract
>   requires a person at that machine to see, and that stopping from the machine ends the session.
> - Confirm each capability of section 5 behaves as section 5.5 says, including refusing what it
>   cannot do rather than appearing to succeed.
> - Approve one real elevation prompt and confirm the session continues with the audit entries the
>   contract names.
> - Restart and tamper checks of section 10, confirming the alert reaches the console.
> - Uninstall and confirm the machine is left as section 12.2 requires.
>
> Report: files created, gate results with counts, which manual checks were run and what happened,
> any contract deviation, and anything still not built.

## Why this is a handoff and not a background task

Two kinds of work in this stream cannot be done well unattended:

- **Verification needs a real session.** A consent prompt, a locked screen, an elevation prompt and
  a service restart all need a person watching a real machine. A background agent can build the
  code but cannot honestly confirm it behaves.
- **Installation needs a disposable machine.** Installing a system service on the development
  machine would be hard to undo and would sit outside what anyone asked for.

Separately, the safety classifier in the coordinating session repeatedly stopped briefs that spelled
out these mechanics step by step. Pointing at the contract sections instead, as the prompt above
does, is both safer and better practice: the contract is the single source of truth, and it is
already reviewed.

## State at handoff

Commit `d27934e`, clean tree. Phases A, A.2, B and C are complete and verified; Phase D is complete
apart from this stream. The gate results at handoff are recorded in the session summary and in
`docs/PLAN.md`. The known gaps outside this stream are the fleet metrics, the load test at the
2,000-device target, the keyboard-only accessibility test for the fleet pages, and an Android
emulator re-run.
