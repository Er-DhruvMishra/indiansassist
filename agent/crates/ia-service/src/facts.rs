//! What the device tells the server about itself (§3.2 `machine`, §3.4 `device.hello.client`).
//!
//! The important thing here is **honesty**, because the console greys out every control whose
//! feature is absent (§13.4). A device that claimed `privacy_screen` and then answered
//! `not_supported` would put a live button in front of a technician that fails when they press
//! it; a device that claimed `amt` without provisioned firmware would offer "Cold power on" on
//! a machine that cannot do it. So each feature here is driven by an explicit fact, and the
//! ones this build does not implement are **absent**, with the reason recorded in
//! `agent/README.md`.
//!
//! One subtlety worth stating, because getting it wrong refuses sessions: the service
//! advertises the **envelope** — everything this build can do on this machine — while the
//! worker's `desk.hello` advertises what it actually has at that moment (a microphone it
//! found, the monitors it enumerated). The server requires the worker's features to be a
//! **subset** of the device row's (§4.2, else `capability_mismatch` + close `4403`), so the
//! envelope must never be narrower than a worker's honest report.

use ia_core::fleet::{AmtInventory, ServiceCapabilities};

/// The facts that decide what this machine can do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityFacts {
    /// Monitors the service could enumerate (at least 1).
    pub monitors: u8,
    /// Rule 8.2d: `wakerOptOut` in `config.json`.
    pub waker_opt_out: bool,
    /// Rule 8.4b: `amtProxyOptOut` in `config.json`.
    pub amt_proxy_opt_out: bool,
    /// This machine's own AMT, as the firmware reports it.
    pub amt: Option<AmtInventory>,
    /// Whether the AMT client is compiled in (the `net` feature of `ia-waker`).
    pub amt_client_built: bool,
    /// Whether a hardware video encoder was found.
    pub hw_encoder: bool,
    /// Whether this build implements the privacy-screen overlay (§5.4). When false the feature
    /// is **not** advertised and `os.privacy_screen` answers `not_supported`, which is what
    /// keeps the console's button greyed rather than broken.
    pub privacy_screen_built: bool,
    /// Whether this build implements the local input lock (`BlockInput`, §5.4).
    pub input_lock_built: bool,
    /// The service version string.
    pub service_version: String,
}

impl Default for CapabilityFacts {
    fn default() -> Self {
        Self {
            monitors: 1,
            waker_opt_out: false,
            amt_proxy_opt_out: false,
            amt: None,
            amt_client_built: cfg!(feature = "service"),
            hw_encoder: false,
            privacy_screen_built: false,
            input_lock_built: true,
            service_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

/// `ServiceCapabilities.features` for these facts, in the `SERVICE_FEATURES` order.
pub fn features(f: &CapabilityFacts) -> Vec<String> {
    let mut out: Vec<&str> = vec!["screen"];
    if f.monitors > 1 {
        out.push("multi_monitor");
    }
    out.extend_from_slice(&["input", "input_text", "clipboard", "files", "chat"]);
    // The envelope includes `voice`: a worker in a user's session may find a microphone the
    // service in session 0 cannot see, and its hello must stay a subset of this list.
    out.push("voice");
    // Privileged mode is reached in place in P4 (§4.3, W32), with no relaunch, but the feature
    // name the console gates on is still `elevation`.
    out.extend_from_slice(&["elevation", "playbooks"]);
    if f.input_lock_built {
        out.push("input_lock");
    }
    if f.privacy_screen_built {
        out.push("privacy_screen");
    }
    out.push("recorder");
    // The service-grade ones (§5.1, §5.2, §5.4): the worker runs as LocalSystem on the input
    // desktop, so the secure desktop is reachable and `SendSAS` exists. Policy decides whether
    // they may be *used*; the feature says only that the machine can.
    out.extend_from_slice(&["secure_desktop", "service_input", "sas"]);
    if !f.waker_opt_out {
        out.push("waker");
    }
    if f.amt.as_ref().is_some_and(|a| a.present && a.provisioned) {
        out.push("amt");
    }
    if !f.amt_proxy_opt_out && f.amt_client_built {
        out.push("amt_proxy");
    }
    out.into_iter().map(str::to_string).collect()
}

/// The whole `ServiceCapabilities` object.
pub fn capabilities(f: &CapabilityFacts) -> ServiceCapabilities {
    ServiceCapabilities {
        monitors: f.monitors.clamp(1, 16),
        elevation: "admin".to_string(),
        features: features(f),
        // The worker encodes, so this is what its build carries (C §4.2): VP8 and VP9 through
        // libvpx. H.264 and AV1 are not built (`agent/README.md`), so they are not claimed.
        encoders: vec!["vp8".to_string(), "vp9".to_string()],
        hw_encoder: f.hw_encoder,
        interpreters: vec!["powershell".to_string(), "cmd".to_string()],
        service_version: f.service_version.clone(),
    }
}

/// Whether a worker's reported features are a subset of this envelope — the check the **server**
/// makes (§4.2). The service runs it too, before launching a worker, so a mismatch is a log
/// line here rather than a closed socket and a puzzled technician.
pub fn worker_features_fit(envelope: &[String], worker: &[String]) -> Result<(), Vec<String>> {
    let extra: Vec<String> = worker
        .iter()
        .filter(|f| !envelope.contains(f))
        .cloned()
        .collect();
    if extra.is_empty() {
        Ok(())
    } else {
        Err(extra)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn amt(present: bool, provisioned: bool) -> AmtInventory {
        AmtInventory {
            present,
            provisioned,
            version: None,
            host: None,
            tls: true,
            power_state: None,
        }
    }

    #[test]
    fn a_plain_single_monitor_machine_advertises_the_service_grade_set() {
        let f = CapabilityFacts {
            amt_client_built: true,
            ..Default::default()
        };
        let got = features(&f);
        for want in [
            "screen",
            "input",
            "clipboard",
            "files",
            "chat",
            "playbooks",
            "recorder",
            "secure_desktop",
            "service_input",
            "sas",
            "waker",
            "amt_proxy",
        ] {
            assert!(
                got.contains(&want.to_string()),
                "{want} should be advertised: {got:?}"
            );
        }
        assert!(
            !got.contains(&"multi_monitor".to_string()),
            "one monitor is not multi_monitor"
        );
        assert!(
            !got.contains(&"amt".to_string()),
            "no AMT firmware, no amt feature"
        );
    }

    #[test]
    fn every_advertised_feature_is_a_known_service_feature() {
        // The list the shared `SERVICE_FEATURES` defines (enums-p4.ts + enums-p3.ts).
        const KNOWN: &[&str] = &[
            "screen",
            "multi_monitor",
            "input",
            "input_text",
            "clipboard",
            "files",
            "chat",
            "voice",
            "elevation",
            "playbooks",
            "input_lock",
            "privacy_screen",
            "recorder",
            "secure_desktop",
            "service_input",
            "waker",
            "amt",
            "amt_proxy",
            "sas",
        ];
        let f = CapabilityFacts {
            monitors: 3,
            amt: Some(amt(true, true)),
            amt_client_built: true,
            privacy_screen_built: true,
            ..Default::default()
        };
        let got = features(&f);
        for name in &got {
            assert!(
                KNOWN.contains(&name.as_str()),
                "{name} is not a SERVICE_FEATURES value"
            );
        }
        assert_eq!(
            got.len(),
            got.iter().collect::<std::collections::BTreeSet<_>>().len(),
            "no duplicates"
        );
    }

    #[test]
    fn a_feature_this_build_does_not_implement_is_not_advertised() {
        let f = CapabilityFacts {
            privacy_screen_built: false,
            input_lock_built: false,
            ..Default::default()
        };
        let got = features(&f);
        assert!(!got.contains(&"privacy_screen".to_string()));
        assert!(!got.contains(&"input_lock".to_string()));
        // And with them built, they are.
        let built = CapabilityFacts {
            privacy_screen_built: true,
            input_lock_built: true,
            ..f
        };
        let got = features(&built);
        assert!(got.contains(&"privacy_screen".to_string()));
        assert!(got.contains(&"input_lock".to_string()));
    }

    #[test]
    fn the_opt_outs_of_rule_8_2d_and_8_4b_remove_the_roles() {
        let f = CapabilityFacts {
            waker_opt_out: true,
            amt_proxy_opt_out: true,
            amt: Some(amt(true, true)),
            amt_client_built: true,
            ..Default::default()
        };
        let got = features(&f);
        assert!(!got.contains(&"waker".to_string()));
        assert!(!got.contains(&"amt_proxy".to_string()));
        assert!(
            got.contains(&"amt".to_string()),
            "its own firmware is still reported"
        );
    }

    #[test]
    fn amt_needs_firmware_that_is_both_present_and_provisioned() {
        for (present, provisioned, want) in [
            (false, false, false),
            (true, false, false),
            (true, true, true),
        ] {
            let f = CapabilityFacts {
                amt: Some(amt(present, provisioned)),
                ..Default::default()
            };
            assert_eq!(
                features(&f).contains(&"amt".to_string()),
                want,
                "present={present} provisioned={provisioned}"
            );
        }
    }

    #[test]
    fn a_proxy_is_not_advertised_when_the_client_is_not_compiled_in() {
        let f = CapabilityFacts {
            amt_client_built: false,
            ..Default::default()
        };
        assert!(!features(&f).contains(&"amt_proxy".to_string()));
    }

    #[test]
    fn the_envelope_covers_what_a_worker_can_honestly_report() {
        let envelope = features(&CapabilityFacts {
            monitors: 2,
            ..Default::default()
        });
        // A worker that found a microphone and two monitors.
        let worker = vec![
            "screen".to_string(),
            "multi_monitor".to_string(),
            "input".to_string(),
            "voice".to_string(),
            "playbooks".to_string(),
            "recorder".to_string(),
        ];
        assert_eq!(worker_features_fit(&envelope, &worker), Ok(()));
        // A worker claiming something the machine never advertised is the §4.2 mismatch.
        let lying = vec!["screen".to_string(), "amt".to_string()];
        assert_eq!(
            worker_features_fit(&envelope, &lying),
            Err(vec!["amt".to_string()])
        );
    }

    #[test]
    fn the_capabilities_object_is_the_contract_shape() {
        let c = capabilities(&CapabilityFacts {
            monitors: 20,
            ..Default::default()
        });
        assert_eq!(c.monitors, 16, "clamped to the schema's maximum");
        assert_eq!(c.elevation, "admin");
        assert_eq!(c.interpreters, vec!["powershell", "cmd"]);
        assert!(
            !c.encoders.contains(&"h264".to_string()),
            "H.264 is not built (agent/README.md)"
        );
        let text = serde_json::to_string(&c).unwrap();
        assert!(text.contains("\"serviceVersion\""));
        assert!(text.contains("\"hwEncoder\""));
    }
}
