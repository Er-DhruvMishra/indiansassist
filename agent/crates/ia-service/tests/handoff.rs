//! The §4.2 handoff over **real named pipes** (contract §15.2: "a new loopback test drives the
//! §4.2 handoff (service writes a blob, worker presents its worker credential and reaches
//! `active`, then a `sign_sas` round trip)").
//!
//! The "worker" is this test binary re-launched with `std::process::Command` running the
//! ignored `worker_half` entry, exactly as `ia-agent`'s `tests/hopipe.rs` does for the C
//! hand-over pipe. That keeps the image check honest (both ends run the same exe) and means
//! **no privileged call is made**: nothing here launches `CreateProcessAsUser`, presses
//! `SendSAS`, blocks input or opens a socket. The parts of "reaching active" that need a
//! server — the credential the server mints and spends — are covered by `pnpm smoke:p4`; what
//! this test owns is the device side: the blob arrives intact, the credential is carried but
//! never logged, the service signs the attestation for its own session and refuses anything
//! else, and both ends survive a frame they do not understand.
#![cfg(all(windows, feature = "service"))]

use std::io::BufReader;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ia_core::fleet::Secret;
use ia_core::policy::{ConsentDecision, UnattendedMode, UnattendedPolicy};
use ia_platform::DesktopTarget;
use ia_service::devicesock::SessionOpen;
use ia_service::identity::Identity;
use ia_service::worker::{answer_worker, blob_for, WorkerAction};
use ia_session0::blob::LaunchBlob;
use ia_session0::pipe::{PipeClient, PipeServer};
use ia_session0::proto::{read_frame, write_frame, ServiceFrame, WorkerFrame};

const CRED: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SESSION: &str = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
const DEVICE: &str = "0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a";
const SAS: &str = "042917";

fn open(decision: ConsentDecision) -> SessionOpen {
    SessionOpen {
        session_id: SESSION.into(),
        assist_name: "Asha".into(),
        reason: Some("unattended disk check".into()),
        unattended: true,
        decision,
        policy: UnattendedPolicy {
            mode: UnattendedMode::Allow,
            allow_input_lock: true,
            ..Default::default()
        },
        recording_mode: "server".into(),
        credential: Secret::new(CRED),
        credential_expires_at: "2026-11-01T10:02:00.000Z".into(),
    }
}

fn blob(decision: ConsentDecision, gen: u16) -> LaunchBlob {
    let o = open(decision);
    blob_for(
        &o,
        DEVICE,
        "http://localhost:4105",
        "ws://localhost:4105/signal",
        &[1],
        gen,
        DesktopTarget::ConsoleDefault { session_id: 1 },
        &o.credential,
        &o.credential_expires_at,
    )
}

/// The worker half: open the pipe, read the blob, ask for an attestation and an `os.sas`, then
/// report its protections and end. Run only when the parent test launches it.
#[test]
#[ignore = "run by the_handoff_delivers_the_blob_and_signs_the_attestation as a child process"]
fn worker_half() {
    let (Ok(suffix), Ok(parent)) = (std::env::var("IA_SVC_PIPE"), std::env::var("IA_SVC_PARENT"))
    else {
        return;
    };
    let parent: u32 = parent.parse().expect("a parent pid");
    assert_eq!(
        ia_session0::pipe::parent_pid(),
        Some(parent),
        "the worker checks that its pipe server is its own parent"
    );
    let mut session = PipeClient::connect(&suffix, parent, Duration::from_secs(10))
        .expect("the worker opens the service pipe");
    let blob: LaunchBlob =
        read_frame(&mut session.reader).expect("the blob arrives as the first line");
    blob.validate().expect("the blob is valid");
    println!("WORKER-SESSION:{}", blob.session_id);
    println!("WORKER-GEN:{}", blob.gen);
    println!("WORKER-CRED-LEN:{}", blob.worker_credential.expose().len());
    println!("WORKER-DECISION:{:?}", blob.decision);
    println!("WORKER-REASON:{}", blob.reason.clone().unwrap_or_default());
    println!(
        "WORKER-CONSENT:{:?}",
        blob.consent
            .as_ref()
            .map(|c| (c.level.clone(), c.monitors.clone()))
    );
    // A `Debug` dump of the whole blob must not carry the credential (§6 redaction).
    println!(
        "WORKER-DEBUG-HAS-CRED:{}",
        format!("{blob:?}").contains(CRED)
    );

    // Rule 3.5b: the worker cannot sign — it asks.
    write_frame(
        &mut session.writer,
        &WorkerFrame::SignSas {
            id: "1".into(),
            gen: blob.gen,
            sas: SAS.into(),
            desk_fpr: "a".repeat(64),
            assist_fpr: "b".repeat(64),
        },
    )
    .expect("the request is written");
    match read_frame::<_, ServiceFrame>(&mut session.reader).expect("an answer") {
        ServiceFrame::SasSig { re, sig } => println!("WORKER-SIG:{re}:{sig}"),
        other => panic!("expected a signature, got {other:?}"),
    }
    // An attestation the service must refuse (a code that is not six digits).
    write_frame(
        &mut session.writer,
        &WorkerFrame::SignSas {
            id: "2".into(),
            gen: blob.gen,
            sas: "not-a-code".into(),
            desk_fpr: "a".repeat(64),
            assist_fpr: "b".repeat(64),
        },
    )
    .expect("the request is written");
    match read_frame::<_, ServiceFrame>(&mut session.reader).expect("an answer") {
        ServiceFrame::Error { re, code } => println!("WORKER-REFUSED:{re}:{code}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    // §5.4: `os.sas` is the service's to perform.
    write_frame(
        &mut session.writer,
        &WorkerFrame::SendSas { id: "3".into() },
    )
    .expect("written");
    match read_frame::<_, ServiceFrame>(&mut session.reader).expect("an answer") {
        ServiceFrame::Ack { re } => println!("WORKER-SAS-ACK:{re}"),
        ServiceFrame::Error { re, code } => println!("WORKER-SAS-REFUSED:{re}:{code}"),
        other => panic!("expected an ack or a refusal, got {other:?}"),
    }
    // §5.4d: report the protection state, then end.
    write_frame(
        &mut session.writer,
        &WorkerFrame::Protections {
            input_lock: true,
            privacy_screen: false,
        },
    )
    .unwrap();
    write_frame(
        &mut session.writer,
        &WorkerFrame::Ended {
            reason: "test".into(),
        },
    )
    .unwrap();
    // The service's stop frame closes the loop.
    if let Ok(ServiceFrame::Stop { reason }) = read_frame::<_, ServiceFrame>(&mut session.reader) {
        println!("WORKER-STOP:{reason}");
    }
}

/// The service half, with the real pipe and a real device identity.
#[test]
fn the_handoff_delivers_the_blob_and_signs_the_attestation() {
    let identity = Identity::generate();
    let public_key = identity.public_key();
    let suffix = ia_platform::protocol::new_pipe_suffix();
    // The pipe exists before the worker is launched (§4.2), with the DACL for SYSTEM and the
    // worker's user. This test process is not SYSTEM, so the worker SID is its own user — the
    // same derivation the service performs for a console-session worker.
    let sid = current_user_sid();
    let server = PipeServer::create(&suffix, &sid).expect("the service creates its pipe");
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "worker_half", "--ignored", "--nocapture"])
        .env("IA_SVC_PIPE", &suffix)
        .env("IA_SVC_PARENT", std::process::id().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the worker half");
    let session = server
        .accept(child.id(), Duration::from_secs(20))
        .expect("the launched worker is accepted");
    let mut reader = session.reader;
    let writer = Arc::new(Mutex::new(session.writer));
    {
        let mut w = writer.lock().unwrap();
        write_frame(&mut *w, &blob(ConsentDecision::AutoGrant, 2)).expect("the blob is written");
    }
    // Serve the duplex channel exactly as `ia_service::session` does: every frame goes through
    // `answer_worker`, which is the only thing that holds the device key.
    let mut sas_sent = false;
    while let Ok(frame) = read_frame::<_, WorkerFrame>(&mut reader) {
        let action = answer_worker(&frame, SESSION, &identity);
        let mut w = writer.lock().unwrap();
        match action {
            WorkerAction::Reply(reply) => write_frame(&mut *w, &reply).unwrap(),
            WorkerAction::SendSas { id } => {
                // The real service calls `SendSAS` here. This test must not (§15.2), so it
                // answers as a machine without it would: an honest refusal.
                sas_sent = true;
                write_frame(
                    &mut *w,
                    &ServiceFrame::Error {
                        re: id,
                        code: "not_supported".into(),
                    },
                )
                .unwrap();
            }
            WorkerAction::Ended { .. } => {
                write_frame(
                    &mut *w,
                    &ServiceFrame::Stop {
                        reason: "session_end".into(),
                    },
                )
                .unwrap();
                break;
            }
            _ => {}
        }
    }
    assert!(
        sas_sent,
        "the worker asked the service to press Ctrl+Alt+Del"
    );

    let out = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let line = |prefix: &str| -> String {
        stdout
            .lines()
            .find(|l| l.starts_with(prefix))
            .unwrap_or_else(|| panic!("no {prefix} line in:\n{stdout}\n{stderr}"))
            .trim_end()
            .to_string()
    };

    // 1) The blob arrived intact, including the generation a rebuild needs.
    assert_eq!(line("WORKER-SESSION:"), format!("WORKER-SESSION:{SESSION}"));
    assert_eq!(line("WORKER-GEN:"), "WORKER-GEN:2");
    assert_eq!(line("WORKER-CRED-LEN:"), "WORKER-CRED-LEN:43");
    assert_eq!(line("WORKER-DECISION:"), "WORKER-DECISION:AutoGrant");
    // Revision 5: the reason reaches the worker, which is the only process that can show it to
    // the person at the machine (rule 6.2a).
    assert_eq!(
        line("WORKER-REASON:"),
        "WORKER-REASON:unattended disk check"
    );
    assert!(
        line("WORKER-CONSENT:").contains("control"),
        "the settled consent is carried"
    );
    // 2) ...and a debug dump of it does not carry the credential.
    assert_eq!(
        line("WORKER-DEBUG-HAS-CRED:"),
        "WORKER-DEBUG-HAS-CRED:false"
    );
    // 3) The credential is never printed by either side.
    assert!(!stdout.contains(CRED), "the credential leaked to stdout");
    assert!(!stderr.contains(CRED), "the credential leaked to stderr");

    // 4) The attestation the service signed verifies as rule 3.5b's, for this session only.
    let sig = line("WORKER-SIG:")
        .trim_start_matches("WORKER-SIG:1:")
        .to_string();
    let input =
        ia_core::devsig::input::sas(SESSION, 2, SAS, &"a".repeat(64), &"b".repeat(64)).unwrap();
    assert!(
        ia_core::devsig::verify_device_signature(&input, &sig, &public_key),
        "the console must be able to verify this with session.created.device.publicKey"
    );
    let other_session =
        ia_core::devsig::input::sas(DEVICE, 2, SAS, &"a".repeat(64), &"b".repeat(64)).unwrap();
    assert!(
        !ia_core::devsig::verify_device_signature(&other_session, &sig, &public_key),
        "the signature is bound to the session the worker was launched for"
    );
    // 5) An implausible attestation was refused rather than signed.
    assert_eq!(line("WORKER-REFUSED:"), "WORKER-REFUSED:2:bad_request");
    // 6) `os.sas` was refused honestly by a service that cannot press it.
    assert_eq!(
        line("WORKER-SAS-REFUSED:"),
        "WORKER-SAS-REFUSED:3:not_supported"
    );
    // 7) The stop frame reached the worker.
    assert_eq!(line("WORKER-STOP:"), "WORKER-STOP:session_end");
    assert!(
        out.status.success(),
        "the worker half exited cleanly:\n{stderr}"
    );
}

/// A worker that is not the process the service launched never receives the blob (§4.2's pid
/// and image checks, the same family as C §7.2).
#[test]
fn a_pipe_client_that_is_not_the_launched_worker_is_refused() {
    let suffix = ia_platform::protocol::new_pipe_suffix();
    let server = PipeServer::create(&suffix, &current_user_sid()).unwrap();
    let me = std::process::id();
    let s2 = suffix.clone();
    // This process connects; the service is expecting another pid.
    let client = std::thread::spawn(move || PipeClient::connect(&s2, me, Duration::from_secs(5)));
    let refused = server.accept(me.wrapping_add(4), Duration::from_secs(5));
    let verdict = match &refused {
        Err(e) => format!("{e}"),
        Ok(_) => "accepted".to_string(),
    };
    assert!(
        matches!(refused, Err(ia_session0::pipe::PipeError::Peer(_))),
        "expected a peer refusal, got {verdict}"
    );
    // Whatever the client got, no blob was written to it.
    if let Ok(mut session) = client.join().unwrap() {
        let read: Result<LaunchBlob, _> = read_frame(&mut session.reader);
        assert!(
            read.is_err(),
            "the blob leaked to a client the service refused"
        );
    }
}

/// The name is taken by the first instance: a squatter cannot pre-create the service's pipe and
/// sit between the two (`FILE_FLAG_FIRST_PIPE_INSTANCE`).
#[test]
fn the_pipe_name_cannot_be_taken_twice() {
    let suffix = ia_platform::protocol::new_pipe_suffix();
    let _first = PipeServer::create(&suffix, &current_user_sid()).unwrap();
    assert!(
        PipeServer::create(&suffix, &current_user_sid()).is_err(),
        "a second server on the same name must be refused"
    );
}

/// A frame from a newer build is reported, not fatal: the two ends talk about what they share.
#[test]
fn an_unknown_frame_does_not_break_the_channel() {
    let mut stream: Vec<u8> = b"{\"t\":\"from_a_newer_service\",\"what\":1}\n".to_vec();
    write_frame(
        &mut stream,
        &ServiceFrame::Stop {
            reason: "later".into(),
        },
    )
    .unwrap();
    let mut reader = BufReader::new(stream.as_slice());
    assert!(read_frame::<_, ServiceFrame>(&mut reader).is_err());
    assert!(matches!(
        read_frame::<_, ServiceFrame>(&mut reader).unwrap(),
        ServiceFrame::Stop { .. }
    ));
}

/// This test process's own user SID. The real service passes the **console user's** SID here
/// (or `SY` for a secure-desktop worker), and the DACL is what makes the difference: a pipe
/// whose ACL names only `SYSTEM` cannot be opened by a user-level worker at all, which is why
/// this test has to use its own SID rather than the convenient `SY`.
fn current_user_sid() -> String {
    ia_agent::pbrun::win::current_user_sid().expect("the test process has a user SID")
}
