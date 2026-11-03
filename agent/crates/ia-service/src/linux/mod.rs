//! The Linux half of `ia-service` (contract F §8.2, §8.3). The runtime, logind client, worker
//! spawn, `sd_notify`, paths and facts of the `linux-service` feature land here; what is present
//! today is the pure [`sealer`] mode check of §8.3b, compiled on Linux so `cargo test -p
//! ia-service` on this host covers it, and never on Windows (the §8.12 "Windows stays green"
//! rule).

pub mod sealer;
