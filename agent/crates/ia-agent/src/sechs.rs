//! The `ia.sec` handshake driver (contract §1.3 steps 1-6, 9).
//!
//! A pure state machine over [`ia_core::sec`]: it owns the ephemeral key, the commit/hello
//! ordering ("commit first; hello only after the peer's commit is held"), the fingerprint
//! and commit checks, HKDF derivation and the confirmation MAC. It emits the JSON strings
//! to put on the `ia.sec` channel and consumes the peer's, yielding the [`SessionKeys`] and
//! the SAS once `established`. No webrtc or OS calls, so it is tested without a peer.

use ia_core::sec::{
    commit_hash, transcript_hash, verify_hello, EphemeralKey, SecCommit, SecConfirm, SecFail,
    SecHello, SessionKeys, Side, SideInfo, SEC_SUITE,
};
use ia_core::types::SecFailReason;

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Driver state. Construct with [`SecHandshake::start`], feed peer frames to
/// [`SecHandshake::on_message`], and read [`SecHandshake::take_established`] when done.
pub struct SecHandshake {
    side: Side,
    session_id: String,
    gen: u16,
    key: EphemeralKey,
    own: SideInfo,
    observed_remote_fpr: String,
    peer_commit_h: Option<String>,
    sent_hello: bool,
    peer_hello: Option<SideInfo>,
    keys: Option<SessionKeys>,
    transcript: Option<[u8; 32]>,
    sent_confirm: bool,
    peer_confirmed: bool,
}

impl SecHandshake {
    /// Begin the handshake. Returns the driver and the `sec.commit` JSON to send first
    /// (step 2a); the hello is withheld until the peer's commit arrives (step 2b).
    pub fn start(
        side: Side,
        session_id: &str,
        gen: u16,
        own_fpr: &str,
        remote_fpr: &str,
    ) -> (Self, String) {
        let key = EphemeralKey::generate();
        let epk = key.epk_b64();
        let h = commit_hash(side, SEC_SUITE, &epk, own_fpr);
        let own = SideInfo {
            h: h.clone(),
            epk,
            fpr: own_fpr.to_string(),
        };
        let commit = SecCommit {
            t: "sec.commit".into(),
            v: 1,
            session_id: session_id.to_string(),
            side,
            h,
            gen,
            ts: now_ms(),
        };
        let json = serde_json::to_string(&commit).expect("commit serialises");
        (
            Self {
                side,
                session_id: session_id.to_string(),
                gen,
                key,
                own,
                observed_remote_fpr: remote_fpr.to_string(),
                peer_commit_h: None,
                sent_hello: false,
                peer_hello: None,
                keys: None,
                transcript: None,
                sent_confirm: false,
                peer_confirmed: false,
            },
            json,
        )
    }

    pub fn established(&self) -> bool {
        self.sent_confirm && self.peer_confirmed
    }

    /// The security code to display once derived (step 7), `483 920` form.
    pub fn sas_display(&self) -> Option<String> {
        self.keys.as_ref().map(|k| k.sas_display())
    }

    /// Take the derived keys once `established` (the driver no longer needs them).
    pub fn take_established(&mut self) -> Option<(SessionKeys, String)> {
        if self.established() {
            self.keys.take().map(|k| {
                let sas = k.sas.clone();
                (k, sas)
            })
        } else {
            None
        }
    }

    fn hello_json(&self) -> String {
        let hello = SecHello {
            t: "sec.hello".into(),
            v: 1,
            session_id: self.session_id.clone(),
            side: self.side,
            suite: SEC_SUITE.to_string(),
            epk: self.own.epk.clone(),
            fpr: self.own.fpr.clone(),
            ts: now_ms(),
        };
        serde_json::to_string(&hello).expect("hello serialises")
    }

    /// Process one `ia.sec` message. Returns the JSON frames to send next (possibly empty),
    /// or the [`SecFailReason`] to put on `sec.fail` and tear down (step 9).
    pub fn on_message(&mut self, json: &str) -> Result<Vec<String>, SecFailReason> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|_| SecFailReason::Decrypt)?;
        match value.get("t").and_then(|t| t.as_str()) {
            Some("sec.commit") => self.on_commit(json),
            Some("sec.hello") => self.on_hello(json),
            Some("sec.confirm") => self.on_confirm(json),
            Some("sec.fail") => {
                let f: SecFail = serde_json::from_str(json).map_err(|_| SecFailReason::Decrypt)?;
                Err(f.reason)
            }
            _ => Err(SecFailReason::Decrypt),
        }
    }

    fn envelope_ok(&self, session_id: &str, side: Side, gen: u16) -> bool {
        session_id == self.session_id && side == self.side.peer() && gen == self.gen
    }

    fn on_commit(&mut self, json: &str) -> Result<Vec<String>, SecFailReason> {
        let c: SecCommit = serde_json::from_str(json).map_err(|_| SecFailReason::Commit)?;
        if !self.envelope_ok(&c.session_id, c.side, c.gen) {
            return Err(SecFailReason::Commit);
        }
        if self.peer_commit_h.is_some() {
            return Err(SecFailReason::Commit); // a second commit from the same side
        }
        self.peer_commit_h = Some(c.h);
        // Hello only after the peer's commit is held (step 2b).
        if !self.sent_hello {
            self.sent_hello = true;
            return Ok(vec![self.hello_json()]);
        }
        Ok(vec![])
    }

    fn on_hello(&mut self, json: &str) -> Result<Vec<String>, SecFailReason> {
        let hello: SecHello = serde_json::from_str(json).map_err(|_| SecFailReason::Suite)?;
        // `gen` is not carried on hello; only sessionId/side are checked here (step 2b).
        if hello.session_id != self.session_id || hello.side != self.side.peer() {
            return Err(SecFailReason::Suite);
        }
        if self.peer_hello.is_some() {
            return Err(SecFailReason::Suite); // a second hello from the same side
        }
        // Hello received before its sender's commit is held (step 2b).
        let committed = self.peer_commit_h.clone().ok_or(SecFailReason::Commit)?;
        // Step 3a: the revealed {side,suite,epk,fpr} must hash to the commit (constant time).
        verify_hello(&hello, &committed)?;
        // Step 3b: the fingerprint must equal the one observed on the DTLS transport.
        if hello.fpr != self.observed_remote_fpr {
            return Err(SecFailReason::Fingerprint);
        }
        let peer = SideInfo {
            h: committed,
            epk: hello.epk,
            fpr: hello.fpr,
        };
        // Step 4: X25519 agreement (all-zero => key).
        let ss = self
            .key
            .diffie_hellman(&peer.epk)
            .map_err(|_| SecFailReason::Key)?;
        let (desk, assist) = match self.side {
            Side::Desk => (&self.own, &peer),
            Side::Assist => (&peer, &self.own),
        };
        let t = transcript_hash(&self.session_id, SEC_SUITE, self.gen, desk, assist);
        let keys = SessionKeys::derive(&self.session_id, SEC_SUITE, self.gen, desk, assist, &ss);
        // Step 6: send our confirm now that keys exist.
        let mac = keys.confirm_mac(self.side, &t);
        let confirm = SecConfirm {
            t: "sec.confirm".into(),
            mac,
            ts: now_ms(),
        };
        self.transcript = Some(t);
        self.keys = Some(keys);
        self.peer_hello = Some(peer);
        self.sent_confirm = true;
        Ok(vec![
            serde_json::to_string(&confirm).expect("confirm serialises")
        ])
    }

    fn on_confirm(&mut self, json: &str) -> Result<Vec<String>, SecFailReason> {
        let c: SecConfirm = serde_json::from_str(json).map_err(|_| SecFailReason::Mac)?;
        let (keys, t) = match (self.keys.as_ref(), self.transcript.as_ref()) {
            (Some(k), Some(t)) => (k, t),
            _ => return Err(SecFailReason::Mac), // confirm before our hello completed
        };
        keys.verify_confirm(self.side.peer(), t, &c.mac)?;
        self.peer_confirmed = true;
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive both ends to `established`, exchanging frames until both are quiet.
    fn run_pair(desk_fpr: &str, assist_fpr: &str) -> (SecHandshake, SecHandshake) {
        let (mut desk, dc) = SecHandshake::start(Side::Desk, "s", 0, desk_fpr, assist_fpr);
        let (mut assist, ac) = SecHandshake::start(Side::Assist, "s", 0, assist_fpr, desk_fpr);

        // Each side's queue of frames to deliver to the other.
        let mut to_assist = vec![dc];
        let mut to_desk = vec![ac];
        for _ in 0..8 {
            let mut next_assist = vec![];
            for f in to_desk.drain(..) {
                next_assist.extend(desk.on_message(&f).unwrap());
            }
            let mut next_desk = vec![];
            for f in to_assist.drain(..) {
                next_desk.extend(assist.on_message(&f).unwrap());
            }
            to_assist = next_assist;
            to_desk = next_desk;
            if desk.established() && assist.established() {
                break;
            }
        }
        (desk, assist)
    }

    #[test]
    fn full_handshake_reaches_established_with_matching_sas() {
        let (mut desk, mut assist) = run_pair(&"11".repeat(32), &"22".repeat(32));
        assert!(desk.established() && assist.established());
        let (_, desk_sas) = desk.take_established().unwrap();
        let (_, assist_sas) = assist.take_established().unwrap();
        assert_eq!(desk_sas, assist_sas);
        assert_eq!(desk_sas.len(), 6);
    }

    #[test]
    fn tampered_fingerprint_fails() {
        // The desk is told the assist fpr is 0x99.. but the assist reveals its real fpr.
        let (mut desk, dc) =
            SecHandshake::start(Side::Desk, "s", 0, &"11".repeat(32), &"99".repeat(32));
        let (mut assist, ac) =
            SecHandshake::start(Side::Assist, "s", 0, &"22".repeat(32), &"11".repeat(32));
        // desk holds assist commit, assist holds desk commit
        let desk_hello = desk.on_message(&ac).unwrap();
        let assist_hello = assist.on_message(&dc).unwrap();
        // assist processes desk hello fine (real fprs line up for assist)
        for f in &desk_hello {
            let _ = assist.on_message(f);
        }
        // desk processes assist hello: the revealed fpr (0x22) != observed (0x99) => fingerprint
        let mut saw_fpr = false;
        for f in &assist_hello {
            if desk.on_message(f) == Err(SecFailReason::Fingerprint) {
                saw_fpr = true;
            }
        }
        assert!(saw_fpr);
    }

    #[test]
    fn hello_before_commit_is_rejected() {
        let (mut desk, _dc) =
            SecHandshake::start(Side::Desk, "s", 0, &"11".repeat(32), &"22".repeat(32));
        let stray_hello = serde_json::json!({
            "t":"sec.hello","v":1,"sessionId":"s","side":"assist",
            "suite":SEC_SUITE,"epk":"AAAA","fpr":"22".repeat(32),"ts":0
        })
        .to_string();
        assert_eq!(desk.on_message(&stray_hello), Err(SecFailReason::Commit));
    }
}
