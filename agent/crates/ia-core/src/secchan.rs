//! Encrypted-channel frame format and the [`SecChannel`] seal/open state machine
//! (contract §1.3 "Frame format on an encrypted channel").
//!
//! Frame layout:
//! * `[0]`     version `1`
//! * `[1]`     flags (bit 0 = plaintext is UTF-8 JSON text)
//! * `[2,10)`  uint64 BE `seq` (per channel, per direction, per key generation; from 0)
//! * `[10,n)`  XChaCha20-Poly1305 ciphertext = plaintext || 16-byte tag
//!
//! Nonce (24 bytes) = `labelId || direction || u16be gen || 12 zero || u64be seq`.
//! AAD = `"ia-sec-v1" || sessionId || 0x00 || label || 0x00 || version || flags`.

use std::collections::HashSet;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

use crate::types::{sec_label_id, SecFailReason};
use crate::{CoreError, CoreResult};

const VERSION: u8 = 1;
const FLAG_TEXT: u8 = 0b0000_0001;
const HEADER_LEN: usize = 10;
const TAG_LEN: usize = 16;
/// Max plaintext per frame (contract: `secFrameMaxBytes - 26`, where 26 = 10 header + 16 tag).
pub const MAX_PLAINTEXT: usize = crate::types::limits::SEC_FRAME_MAX_BYTES - HEADER_LEN - TAG_LEN;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    DeskToAssist,
    AssistToDesk,
}

impl Direction {
    fn byte(self) -> u8 {
        match self {
            Direction::DeskToAssist => 0,
            Direction::AssistToDesk => 1,
        }
    }
}

/// Which side this channel is operated by, chosen so the send key/direction and the
/// receive key/direction are picked correctly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operator {
    Desk,
    Assist,
}

fn build_nonce(label_id: u8, dir: Direction, gen: u16, seq: u64) -> XNonce {
    let mut n = [0u8; 24];
    n[0] = label_id;
    n[1] = dir.byte();
    n[2..4].copy_from_slice(&gen.to_be_bytes());
    // n[4..16] stays zero
    n[16..24].copy_from_slice(&seq.to_be_bytes());
    *XNonce::from_slice(&n)
}

fn build_aad(session_id: &str, label: &str, flags: u8) -> Vec<u8> {
    let mut aad = Vec::with_capacity(9 + session_id.len() + 1 + label.len() + 1 + 2);
    aad.extend_from_slice(b"ia-sec-v1");
    aad.extend_from_slice(session_id.as_bytes());
    aad.push(0x00);
    aad.extend_from_slice(label.as_bytes());
    aad.push(0x00);
    aad.push(VERSION);
    aad.push(flags);
    aad
}

/// A guard that vends [`SecChannel`]s and refuses to issue two senders for the same
/// `(labelId, direction, gen)` — i.e. a second start at `seq 0` under one key generation,
/// which would reuse an XChaCha20-Poly1305 nonce (contract §1.3).
#[derive(Default)]
pub struct SecChannelSet {
    started: HashSet<(u8, u8, u16)>,
}

impl SecChannelSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a channel for `label` under this operator and key generation. Errors if a
    /// channel for the same outgoing direction and generation was already opened.
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &mut self,
        operator: Operator,
        session_id: &str,
        label: &str,
        gen: u16,
        k_d2a: [u8; 32],
        k_a2d: [u8; 32],
    ) -> CoreResult<SecChannel> {
        let label_id = sec_label_id(label)
            .ok_or_else(|| CoreError::Invalid(format!("{label} is not an encrypted label")))?;
        let send_dir = match operator {
            Operator::Desk => Direction::DeskToAssist,
            Operator::Assist => Direction::AssistToDesk,
        };
        let key = (label_id, send_dir.byte(), gen);
        if !self.started.insert(key) {
            return Err(CoreError::Invalid(format!(
                "SecChannel for {label} gen {gen} already started (nonce reuse)"
            )));
        }
        Ok(SecChannel {
            operator,
            session_id: session_id.to_string(),
            label: label.to_string(),
            label_id,
            gen,
            k_d2a,
            k_a2d,
            send_seq: 0,
            recv_next: 0,
        })
    }
}

/// One encrypted data channel's send/receive counters and keys for a key generation.
pub struct SecChannel {
    operator: Operator,
    session_id: String,
    label: String,
    label_id: u8,
    gen: u16,
    k_d2a: [u8; 32],
    k_a2d: [u8; 32],
    send_seq: u64,
    recv_next: u64,
}

impl SecChannel {
    fn send_dir(&self) -> Direction {
        match self.operator {
            Operator::Desk => Direction::DeskToAssist,
            Operator::Assist => Direction::AssistToDesk,
        }
    }
    fn recv_dir(&self) -> Direction {
        match self.operator {
            Operator::Desk => Direction::AssistToDesk,
            Operator::Assist => Direction::DeskToAssist,
        }
    }
    fn send_key(&self) -> &[u8; 32] {
        match self.send_dir() {
            Direction::DeskToAssist => &self.k_d2a,
            Direction::AssistToDesk => &self.k_a2d,
        }
    }
    fn recv_key(&self) -> &[u8; 32] {
        match self.recv_dir() {
            Direction::DeskToAssist => &self.k_d2a,
            Direction::AssistToDesk => &self.k_a2d,
        }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    /// Seal a text (JSON) frame.
    pub fn seal_text(&mut self, plaintext: &str) -> CoreResult<Vec<u8>> {
        self.seal(plaintext.as_bytes(), true)
    }

    /// Seal a binary frame (e.g. a file chunk).
    pub fn seal_binary(&mut self, plaintext: &[u8]) -> CoreResult<Vec<u8>> {
        self.seal(plaintext, false)
    }

    fn seal(&mut self, plaintext: &[u8], text: bool) -> CoreResult<Vec<u8>> {
        if plaintext.len() > MAX_PLAINTEXT {
            return Err(CoreError::Invalid("oversize".into()));
        }
        let flags = if text { FLAG_TEXT } else { 0 };
        let seq = self.send_seq;
        let nonce = build_nonce(self.label_id, self.send_dir(), self.gen, seq);
        let aad = build_aad(&self.session_id, &self.label, flags);
        let cipher = XChaCha20Poly1305::new(self.send_key().into());
        let ct = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| CoreError::Crypto("seal failed".into()))?;

        let mut frame = Vec::with_capacity(HEADER_LEN + ct.len());
        frame.push(VERSION);
        frame.push(flags);
        frame.extend_from_slice(&seq.to_be_bytes());
        frame.extend_from_slice(&ct);
        self.send_seq += 1;
        Ok(frame)
    }

    /// Open an incoming frame, enforcing the sequence rule. On failure returns the
    /// [`SecFailReason`] the caller maps to a `sec.fail`.
    pub fn open(&mut self, frame: &[u8]) -> Result<OpenedFrame, SecFailReason> {
        if frame.len() < HEADER_LEN + TAG_LEN {
            return Err(SecFailReason::Decrypt);
        }
        if frame[0] != VERSION {
            return Err(SecFailReason::Decrypt);
        }
        let flags = frame[1];
        if flags & !FLAG_TEXT != 0 {
            return Err(SecFailReason::Decrypt); // reserved bits must be zero
        }
        let seq = u64::from_be_bytes(frame[2..10].try_into().unwrap());
        // Ordered, reliable channel: seq must be exactly the next expected value.
        if seq != self.recv_next {
            return Err(SecFailReason::Replay);
        }
        let ct = &frame[HEADER_LEN..];
        if ct.len() - TAG_LEN > MAX_PLAINTEXT {
            return Err(SecFailReason::Oversize);
        }
        let nonce = build_nonce(self.label_id, self.recv_dir(), self.gen, seq);
        let aad = build_aad(&self.session_id, &self.label, flags);
        let cipher = XChaCha20Poly1305::new(self.recv_key().into());
        let plaintext = cipher
            .decrypt(&nonce, Payload { msg: ct, aad: &aad })
            .map_err(|_| SecFailReason::Decrypt)?;
        self.recv_next += 1;
        Ok(OpenedFrame {
            text: flags & FLAG_TEXT != 0,
            plaintext,
        })
    }
}

/// A decrypted frame's payload and whether it was a text frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedFrame {
    pub text: bool,
    pub plaintext: Vec<u8>,
}

impl OpenedFrame {
    pub fn as_text(&self) -> Option<&str> {
        if self.text {
            std::str::from_utf8(&self.plaintext).ok()
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(label: &str) -> (SecChannel, SecChannel) {
        let k_d2a = [7u8; 32];
        let k_a2d = [9u8; 32];
        let mut desk_set = SecChannelSet::new();
        let mut assist_set = SecChannelSet::new();
        let desk = desk_set
            .open(Operator::Desk, "sess", label, 0, k_d2a, k_a2d)
            .unwrap();
        let assist = assist_set
            .open(Operator::Assist, "sess", label, 0, k_d2a, k_a2d)
            .unwrap();
        (desk, assist)
    }

    #[test]
    fn text_frame_round_trip_both_directions() {
        for label in crate::types::SEC_ENCRYPTED_LABELS {
            let (mut desk, mut assist) = pair(label);
            let frame = desk.seal_text(r#"{"t":"hi"}"#).unwrap();
            let opened = assist.open(&frame).unwrap();
            assert_eq!(opened.as_text(), Some(r#"{"t":"hi"}"#));

            let back = assist.seal_text(r#"{"t":"ack"}"#).unwrap();
            let opened2 = desk.open(&back).unwrap();
            assert_eq!(opened2.as_text(), Some(r#"{"t":"ack"}"#));
        }
    }

    #[test]
    fn binary_frame_round_trip() {
        let (mut desk, mut assist) = pair("ia.file");
        let chunk = vec![0xDEu8; 16384];
        let frame = desk.seal_binary(&chunk).unwrap();
        let opened = assist.open(&frame).unwrap();
        assert!(!opened.text);
        assert_eq!(opened.plaintext, chunk);
    }

    #[test]
    fn seq_increments_and_replay_is_rejected() {
        let (mut desk, mut assist) = pair("ia.control");
        let f0 = desk.seal_text("a").unwrap();
        let f1 = desk.seal_text("b").unwrap();
        assert_eq!(&f0[2..10], &0u64.to_be_bytes());
        assert_eq!(&f1[2..10], &1u64.to_be_bytes());
        // Deliver out of order (f1 before f0) => replay reason.
        assert_eq!(assist.open(&f1), Err(SecFailReason::Replay));
        // In order works.
        assert!(assist.open(&f0).is_ok());
        assert!(assist.open(&f1).is_ok());
        // Re-deliver f0 => replay.
        assert_eq!(assist.open(&f0), Err(SecFailReason::Replay));
    }

    #[test]
    fn tamper_fails_decrypt() {
        let (mut desk, mut assist) = pair("ia.chat");
        let mut frame = desk.seal_text("secret").unwrap();
        let last = frame.len() - 1;
        frame[last] ^= 0xFF;
        assert_eq!(assist.open(&frame), Err(SecFailReason::Decrypt));
    }

    #[test]
    fn wrong_key_generation_cannot_open() {
        let k_d2a = [1u8; 32];
        let k_a2d = [2u8; 32];
        let mut s0 = SecChannelSet::new();
        let mut s1 = SecChannelSet::new();
        let mut desk_g0 = s0
            .open(Operator::Desk, "s", "ia.ctrl", 0, k_d2a, k_a2d)
            .unwrap();
        let mut assist_g1 = s1
            .open(Operator::Assist, "s", "ia.ctrl", 1, k_d2a, k_a2d)
            .unwrap();
        let frame = desk_g0.seal_text("x").unwrap();
        // gen differs -> nonce differs -> AEAD fails.
        assert_eq!(assist_g1.open(&frame), Err(SecFailReason::Decrypt));
    }

    #[test]
    fn second_channel_same_gen_refuses_seq_zero() {
        let mut set = SecChannelSet::new();
        let k = [0u8; 32];
        assert!(set.open(Operator::Desk, "s", "ia.control", 0, k, k).is_ok());
        // A second sender for the same label/direction/gen would reuse seq 0 nonces.
        assert!(set
            .open(Operator::Desk, "s", "ia.control", 0, k, k)
            .is_err());
        // A different generation is fine.
        assert!(set.open(Operator::Desk, "s", "ia.control", 1, k, k).is_ok());
    }

    #[test]
    fn oversize_plaintext_rejected() {
        let (mut desk, _) = pair("ia.control");
        let big = vec![0u8; MAX_PLAINTEXT + 1];
        assert!(desk.seal_binary(&big).is_err());
    }
}
