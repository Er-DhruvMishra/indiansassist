//! File transfer over `ia.file` (contract §6.1; the Phase A §8.3 protocol unchanged). Pure:
//! the binary chunk codec, the `file.offer` shape, the collision-free final-name choice, and
//! a streaming receiver state machine that validates the name/size, accumulates ordered
//! chunks and verifies the sha256 on `file.done`. The agent binary wraps this with the
//! `<name>.<hex>.iapart` on-disk streaming, the Mark-of-the-Web and the `\\?\` path rules
//! (contract §6.1 F3); here it keeps the bytes in memory so the receiver can be tested and
//! the loopback can assert the saved bytes.

use std::collections::HashSet;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::files::{is_executable_name, is_passive_risk_name, validate_save_leaf};
use crate::types::limits;

/// `[0,4)` uint32 BE fileId, `[4,8)` uint32 BE chunkIndex, `[8, 8+n)` payload (n <= 16384)
/// — the A §8.3 `encodeFileChunk`.
pub fn encode_file_chunk(file_id: u32, chunk_index: u32, payload: &[u8]) -> Vec<u8> {
    debug_assert!(payload.len() <= FILE_CHUNK_SIZE);
    let mut out = Vec::with_capacity(8 + payload.len());
    out.extend_from_slice(&file_id.to_be_bytes());
    out.extend_from_slice(&chunk_index.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Decode a binary chunk frame; `None` when shorter than the header or over 8 + 16384.
pub fn decode_file_chunk(frame: &[u8]) -> Option<(u32, u32, &[u8])> {
    if frame.len() < 8 || frame.len() > 8 + FILE_CHUNK_SIZE {
        return None;
    }
    let file_id = u32::from_be_bytes(frame[0..4].try_into().ok()?);
    let chunk_index = u32::from_be_bytes(frame[4..8].try_into().ok()?);
    Some((file_id, chunk_index, &frame[8..]))
}

/// `LIMITS.fileChunkSize`.
pub const FILE_CHUNK_SIZE: usize = 16_384;

/// `file.offer` (contract §6.1 F1 / A §8.3).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FileOffer {
    #[serde(rename = "fileId")]
    pub file_id: u32,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub sha256: String,
    #[serde(rename = "chunkSize")]
    pub chunk_size: usize,
    pub chunks: u32,
}

impl FileOffer {
    pub fn parse(json_text: &str) -> Option<FileOffer> {
        let v: serde_json::Value = serde_json::from_str(json_text).ok()?;
        if v.get("t").and_then(|t| t.as_str()) != Some("file.offer") {
            return None;
        }
        serde_json::from_value(v).ok()
    }
}

/// `file.reject.reason` (contract §6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    Declined,
    TooLarge,
    Busy,
    BadName,
}

impl RejectReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RejectReason::Declined => "declined",
            RejectReason::TooLarge => "too_large",
            RejectReason::Busy => "busy",
            RejectReason::BadName => "bad_name",
        }
    }
}

/// `file.cancel.reason` (contract §6.1 / A §8.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    Aborted,
    BadChunk,
    Overflow,
    HashMismatch,
}

impl CancelReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CancelReason::Aborted => "aborted",
            CancelReason::BadChunk => "bad_chunk",
            CancelReason::Overflow => "overflow",
            CancelReason::HashMismatch => "hash_mismatch",
        }
    }
}

/// The accepted offer's prompt facts (contract §6.1 F4). The panel shows these; the agent
/// never opens an executable or passive-risk type with **Open folder**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedOffer {
    /// The collision-free final leaf the file will be saved as.
    pub final_name: String,
    /// True for an `EXECUTABLE_EXTENSIONS` type (red warning + second physical click).
    pub executable: bool,
}

/// The key a name is compared under in the `taken` set: Windows file names are
/// case-insensitive, so `Report.PDF` collides with `report.pdf`.
pub fn taken_key(name: &str) -> String {
    name.to_lowercase()
}

/// Choose the collision-free final name (contract §6.1 F3): `<stem> (2).<ext>`, `(3)`…
/// against existing files and in-flight transfers. `taken` holds [`taken_key`]s (lower-case);
/// the comparison is case-insensitive.
pub fn choose_final_name(leaf: &str, taken: &HashSet<String>) -> String {
    let is_taken = |n: &str| taken.contains(&taken_key(n)) || taken.contains(n);
    if !is_taken(leaf) {
        return leaf.to_string();
    }
    let (stem, ext) = match leaf.rfind('.') {
        Some(dot) if dot > 0 => (&leaf[..dot], &leaf[dot..]),
        _ => (leaf, ""),
    };
    let mut n = 2u32;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if !is_taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// The streaming file receiver (contract §6.1). [`Receiver::accept`] keeps the bytes in memory
/// (tests, the loopback); [`Receiver::accept_streaming`] only validates order/size and hashes,
/// while the binary writes each accepted chunk to a `<final>.<hex>.iapart` file.
#[derive(Debug)]
pub struct Receiver {
    file_id: u32,
    final_name: String,
    declared_size: u64,
    declared_sha256: String,
    expected_chunks: u32,
    next_chunk: u32,
    received: u64,
    keep_bytes: bool,
    bytes: Vec<u8>,
    hasher: Sha256,
    done: bool,
}

impl Receiver {
    /// Validate and accept an offer, choosing the final name. `Err(reason)` => `file.reject`.
    pub fn accept(
        offer: &FileOffer,
        taken: &HashSet<String>,
    ) -> Result<(Receiver, AcceptedOffer), RejectReason> {
        Self::accept_inner(offer, taken, true)
    }

    /// As [`Receiver::accept`] but nothing is buffered: the caller streams each chunk to disk
    /// after [`Receiver::on_chunk`] accepted it and calls [`Receiver::finish_streaming`].
    pub fn accept_streaming(
        offer: &FileOffer,
        taken: &HashSet<String>,
    ) -> Result<(Receiver, AcceptedOffer), RejectReason> {
        Self::accept_inner(offer, taken, false)
    }

    fn accept_inner(
        offer: &FileOffer,
        taken: &HashSet<String>,
        keep_bytes: bool,
    ) -> Result<(Receiver, AcceptedOffer), RejectReason> {
        if offer.size > limits::FILE_MAX_BYTES_NATIVE {
            return Err(RejectReason::TooLarge);
        }
        if offer.chunk_size != FILE_CHUNK_SIZE {
            return Err(RejectReason::BadName);
        }
        if offer.chunks as u64 != offer.size.div_ceil(FILE_CHUNK_SIZE as u64) {
            return Err(RejectReason::BadName);
        }
        // A passive-risk type is refused outright; everything else is sanitised to a leaf.
        if is_passive_risk_name(&offer.name) {
            return Err(RejectReason::BadName);
        }
        let leaf = validate_save_leaf(&offer.name, offer.file_id as u64)
            .map_err(|_| RejectReason::BadName)?;
        let final_name = choose_final_name(&leaf, taken);
        let executable = is_executable_name(&final_name);
        let recv = Receiver {
            file_id: offer.file_id,
            final_name: final_name.clone(),
            declared_size: offer.size,
            declared_sha256: offer.sha256.to_ascii_lowercase(),
            expected_chunks: offer.chunks,
            next_chunk: 0,
            received: 0,
            keep_bytes,
            bytes: Vec::new(),
            hasher: Sha256::new(),
            done: false,
        };
        Ok((
            recv,
            AcceptedOffer {
                final_name,
                executable,
            },
        ))
    }

    pub fn file_id(&self) -> u32 {
        self.file_id
    }

    pub fn final_name(&self) -> &str {
        &self.final_name
    }

    /// Feed one decoded chunk in order. `Err` maps to `file.cancel`.
    pub fn on_chunk(&mut self, chunk_index: u32, payload: &[u8]) -> Result<(), CancelReason> {
        if self.done {
            return Err(CancelReason::Aborted);
        }
        if chunk_index != self.next_chunk || chunk_index >= self.expected_chunks {
            return Err(CancelReason::BadChunk);
        }
        if payload.len() > FILE_CHUNK_SIZE {
            return Err(CancelReason::BadChunk);
        }
        if self.received + payload.len() as u64 > self.declared_size {
            return Err(CancelReason::Overflow);
        }
        self.hasher.update(payload);
        if self.keep_bytes {
            self.bytes.extend_from_slice(payload);
        }
        self.received += payload.len() as u64;
        self.next_chunk += 1;
        Ok(())
    }

    /// Bytes accepted so far.
    pub fn received(&self) -> u64 {
        self.received
    }

    /// The declared size of the offer.
    pub fn declared_size(&self) -> u64 {
        self.declared_size
    }

    /// The streaming `file.done` check: every chunk arrived, the size and the sha256 match.
    /// Returns the final name; the caller then commits its `.iapart` file.
    pub fn finish_streaming(mut self) -> Result<String, CancelReason> {
        self.verify()?;
        self.done = true;
        Ok(self.final_name)
    }

    fn verify(&mut self) -> Result<(), CancelReason> {
        if self.next_chunk != self.expected_chunks || self.received != self.declared_size {
            return Err(CancelReason::Aborted);
        }
        let digest = hex::encode(self.hasher.finalize_reset());
        if digest != self.declared_sha256 {
            return Err(CancelReason::HashMismatch);
        }
        Ok(())
    }

    /// `file.done`: verify every chunk arrived, the size matches and the sha256 matches.
    /// Returns the final name and the received bytes, or the cancel reason.
    pub fn finish(mut self) -> Result<(String, Vec<u8>), CancelReason> {
        self.verify()?;
        self.done = true;
        Ok((self.final_name, self.bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer_for(name: &str, bytes: &[u8]) -> FileOffer {
        let sha = hex::encode(Sha256::digest(bytes));
        FileOffer {
            file_id: 7,
            name: name.into(),
            size: bytes.len() as u64,
            mime: "application/octet-stream".into(),
            sha256: sha,
            chunk_size: FILE_CHUNK_SIZE,
            chunks: (bytes.len() as u64).div_ceil(FILE_CHUNK_SIZE as u64) as u32,
        }
    }

    #[test]
    fn chunk_codec_round_trips() {
        let payload = [1u8, 2, 3, 4];
        let frame = encode_file_chunk(0xDEAD_BEEF, 5, &payload);
        let (id, idx, p) = decode_file_chunk(&frame).unwrap();
        assert_eq!(id, 0xDEAD_BEEF);
        assert_eq!(idx, 5);
        assert_eq!(p, &payload);
        assert!(decode_file_chunk(&[0u8; 4]).is_none());
    }

    #[test]
    fn offer_parses() {
        let o = offer_for("report.pdf", b"hello");
        let json = serde_json::json!({
            "t": "file.offer", "fileId": o.file_id, "name": o.name, "size": o.size,
            "mime": o.mime, "sha256": o.sha256, "chunkSize": o.chunk_size, "chunks": o.chunks, "ts": 1
        })
        .to_string();
        let parsed = FileOffer::parse(&json).unwrap();
        assert_eq!(parsed.name, "report.pdf");
    }

    #[test]
    fn small_file_round_trips_and_name_is_sanitised() {
        let data = b"the quick brown fox".to_vec();
        let offer = offer_for("note (1).txt", &data);
        let (mut recv, accepted) = Receiver::accept(&offer, &HashSet::new()).unwrap();
        assert_eq!(accepted.final_name, "note (1).txt");
        assert!(!accepted.executable);
        recv.on_chunk(0, &data).unwrap();
        let (name, bytes) = recv.finish().unwrap();
        assert_eq!(name, "note (1).txt");
        assert_eq!(bytes, data);
    }

    #[test]
    fn multi_chunk_in_order_with_hash_check() {
        let data: Vec<u8> = (0..(FILE_CHUNK_SIZE as u32 + 10))
            .map(|i| i as u8)
            .collect();
        let offer = offer_for("big.bin", &data);
        let (mut recv, _) = Receiver::accept(&offer, &HashSet::new()).unwrap();
        recv.on_chunk(0, &data[..FILE_CHUNK_SIZE]).unwrap();
        recv.on_chunk(1, &data[FILE_CHUNK_SIZE..]).unwrap();
        let (_, bytes) = recv.finish().unwrap();
        assert_eq!(bytes, data);
    }

    #[test]
    fn out_of_order_chunk_cancels() {
        let data = vec![9u8; 100];
        let offer = offer_for("x.bin", &data);
        let (mut recv, _) = Receiver::accept(&offer, &HashSet::new()).unwrap();
        assert_eq!(recv.on_chunk(1, &data), Err(CancelReason::BadChunk));
    }

    #[test]
    fn hash_mismatch_cancels() {
        let data = vec![1u8; 32];
        let mut offer = offer_for("x.bin", &data);
        offer.sha256 = "00".repeat(32);
        let (mut recv, _) = Receiver::accept(&offer, &HashSet::new()).unwrap();
        recv.on_chunk(0, &data).unwrap();
        assert_eq!(recv.finish(), Err(CancelReason::HashMismatch));
    }

    #[test]
    fn passive_risk_and_oversize_rejected() {
        let data = vec![0u8; 10];
        let bad = offer_for("evil.url", &data);
        assert_eq!(
            Receiver::accept(&bad, &HashSet::new()).err(),
            Some(RejectReason::BadName)
        );
        let mut huge = offer_for("big.iso", &data);
        huge.size = limits::FILE_MAX_BYTES_NATIVE + 1;
        huge.chunks = (huge.size).div_ceil(FILE_CHUNK_SIZE as u64) as u32;
        assert_eq!(
            Receiver::accept(&huge, &HashSet::new()).err(),
            Some(RejectReason::TooLarge)
        );
    }

    #[test]
    fn collision_free_name_choice() {
        let mut taken = HashSet::new();
        taken.insert("report.pdf".to_string());
        assert_eq!(choose_final_name("report.pdf", &taken), "report (2).pdf");
        taken.insert("report (2).pdf".to_string());
        assert_eq!(choose_final_name("report.pdf", &taken), "report (3).pdf");
        assert_eq!(choose_final_name("fresh.txt", &taken), "fresh.txt");
        // Case-insensitive like NTFS: `Report.PDF` collides with `report.pdf`.
        assert_eq!(choose_final_name("Report.PDF", &taken), "Report (3).PDF");
    }

    #[test]
    fn streaming_receiver_hashes_without_buffering() {
        let data: Vec<u8> = (0..(FILE_CHUNK_SIZE as u32 * 2 + 3))
            .map(|i| (i % 251) as u8)
            .collect();
        let offer = offer_for("stream.bin", &data);
        let (mut recv, accepted) = Receiver::accept_streaming(&offer, &HashSet::new()).unwrap();
        assert_eq!(accepted.final_name, "stream.bin");
        for (i, c) in data.chunks(FILE_CHUNK_SIZE).enumerate() {
            recv.on_chunk(i as u32, c).unwrap();
        }
        assert_eq!(recv.received(), data.len() as u64);
        assert_eq!(recv.finish_streaming().unwrap(), "stream.bin");

        // A short transfer is aborted, a wrong hash is a mismatch.
        let (mut short, _) = Receiver::accept_streaming(&offer, &HashSet::new()).unwrap();
        short.on_chunk(0, &data[..FILE_CHUNK_SIZE]).unwrap();
        assert_eq!(short.finish_streaming(), Err(CancelReason::Aborted));
        let mut bad = offer.clone();
        bad.sha256 = "11".repeat(32);
        let (mut wrong, _) = Receiver::accept_streaming(&bad, &HashSet::new()).unwrap();
        for (i, c) in data.chunks(FILE_CHUNK_SIZE).enumerate() {
            wrong.on_chunk(i as u32, c).unwrap();
        }
        assert_eq!(wrong.finish_streaming(), Err(CancelReason::HashMismatch));
    }
}
