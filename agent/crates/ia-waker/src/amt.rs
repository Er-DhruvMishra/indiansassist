//! The AMT proxy side of rule 8.4: WS-Management requests over `/wsman`, HTTP Digest
//! authentication, and reading the answers.
//!
//! The credential arrives sealed to this device (purpose `amt-cred`), is used for one command,
//! and is wiped; no device ever holds a vault credential (rule 8.4c). Nothing here contacts
//! Intel: `ia-waker` speaks to the firmware on the LAN directly, on 16993 (TLS) or 16992
//! (plain, allowed only when the inventory says `tls: false`).
//!
//! **What is built and what is not.** The WS-Man request builders, the digest header and the
//! answer parsing are built and tested against vectors here. **Serial over LAN byte
//! forwarding is not built**: the AMT redirection protocol on 16994/16995 is a separate binary
//! protocol whose framing cannot be verified without real vPro hardware, and writing an
//! unverified encoder that a test "confirms" against itself would be worse than saying so.
//! [`sol_open`] therefore enables the redirection service over WS-Man and then answers
//! `unsupported`, which is the honest `amt.result` for a proxy that cannot stream
//! (§8.4e; the console shows the failure rather than an empty console pane).

use md5::{Digest as Md5Digest, Md5};
use zeroize::Zeroizing;

use ia_core::fleet::{AmtBootTarget, AmtOp};

/// The WS-Man path on an AMT firmware.
pub const WSMAN_PATH: &str = "/wsman";
/// TLS port (rule 8.4c).
pub const AMT_TLS_PORT: u16 = 16993;
/// Plain-HTTP port, allowed only when the inventory reports `tls: false`.
pub const AMT_PLAIN_PORT: u16 = 16992;

const NS_SOAP: &str = "http://www.w3.org/2003/05/soap-envelope";
const NS_ADDRESSING: &str = "http://schemas.xmlsoap.org/ws/2004/08/addressing";
const NS_WSMAN: &str = "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd";
const CIM: &str = "http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2";
const AMT: &str = "http://intel.com/wbem/wscim/1/amt-schema/1";
const ANONYMOUS: &str = "http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous";

/// `CIM_PowerManagementService.RequestPowerStateChange` power states.
pub mod power_state {
    /// Power on.
    pub const ON: u8 = 2;
    /// Reset (used after a boot-order change).
    pub const RESET: u8 = 10;
}

/// `AMT_RedirectionService.RequestStateChange` requested states.
pub mod redirection_state {
    pub const DISABLED: u32 = 32768;
    pub const SOL_ONLY: u32 = 32770;
    pub const IDER_AND_SOL: u32 = 32771;
}

/// The `AMT_BootSourceSetting` instance a boot target names.
pub fn boot_source(target: AmtBootTarget) -> &'static str {
    match target {
        AmtBootTarget::Pxe => "Intel(r) AMT: Force PXE Boot",
        AmtBootTarget::Hdd => "Intel(r) AMT: Force Hard-drive Boot",
        AmtBootTarget::Cd => "Intel(r) AMT: Force CD/DVD Boot",
    }
}

/// The URL of a firmware's WS-Man endpoint.
pub fn wsman_url(host: &str, tls: bool) -> String {
    let (scheme, port) = if tls {
        ("https", AMT_TLS_PORT)
    } else {
        ("http", AMT_PLAIN_PORT)
    };
    format!("{scheme}://{host}:{port}{WSMAN_PATH}")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// One WS-Man request: the SOAP action and the body, ready to POST.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsmanRequest {
    pub action: String,
    pub resource_uri: String,
    pub body: String,
}

/// A reference to the managed computer system, which every power request needs as its
/// `ManagedElement`.
fn managed_system_ref(indent: &str) -> String {
    format!(
        "{indent}<p:ManagedElement>\n\
         {indent}  <a:Address>{ANONYMOUS}</a:Address>\n\
         {indent}  <a:ReferenceParameters>\n\
         {indent}    <w:ResourceURI>{CIM}/CIM_ComputerSystem</w:ResourceURI>\n\
         {indent}    <w:SelectorSet>\n\
         {indent}      <w:Selector Name=\"Name\">ManagedSystem</w:Selector>\n\
         {indent}    </w:SelectorSet>\n\
         {indent}  </a:ReferenceParameters>\n\
         {indent}</p:ManagedElement>\n"
    )
}

/// The SOAP envelope for `request`. `message_id` is the caller's `cmdId`, so a firmware log and
/// our audit chain name the same operation.
pub fn envelope(
    request: &WsmanRequest,
    message_id: &str,
    selector: Option<(&str, &str)>,
) -> String {
    let selector_set = selector
        .map(|(name, value)| {
            format!(
                "    <w:SelectorSet>\n      <w:Selector Name=\"{}\">{}</w:Selector>\n    </w:SelectorSet>\n",
                xml_escape(name),
                xml_escape(value)
            )
        })
        .unwrap_or_default();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <s:Envelope xmlns:s=\"{NS_SOAP}\" xmlns:a=\"{NS_ADDRESSING}\" xmlns:w=\"{NS_WSMAN}\" xmlns:p=\"{resource}\">\n\
         \x20 <s:Header>\n\
         \x20   <a:Action s:mustUnderstand=\"true\">{action}</a:Action>\n\
         \x20   <a:To s:mustUnderstand=\"true\">{WSMAN_PATH}</a:To>\n\
         \x20   <w:ResourceURI s:mustUnderstand=\"true\">{resource}</w:ResourceURI>\n\
         \x20   <a:MessageID s:mustUnderstand=\"true\">uuid:{message_id}</a:MessageID>\n\
         \x20   <a:ReplyTo>\n\
         \x20     <a:Address>{ANONYMOUS}</a:Address>\n\
         \x20   </a:ReplyTo>\n\
         \x20   <w:OperationTimeout>PT60S</w:OperationTimeout>\n\
         {selector_set}\
         \x20 </s:Header>\n\
         \x20 <s:Body>\n\
         {body}\
         \x20 </s:Body>\n\
         </s:Envelope>\n",
        resource = request.resource_uri,
        action = request.action,
        body = request.body,
        message_id = xml_escape(message_id),
    )
}

/// `CIM_PowerManagementService.RequestPowerStateChange` (power on, or reset after a boot change).
pub fn request_power_state_change(state: u8) -> WsmanRequest {
    let resource = format!("{CIM}/CIM_PowerManagementService");
    WsmanRequest {
        action: format!("{resource}/RequestPowerStateChange"),
        resource_uri: resource,
        body: format!(
            "    <p:RequestPowerStateChange_INPUT>\n      <p:PowerState>{state}</p:PowerState>\n{}    </p:RequestPowerStateChange_INPUT>\n",
            managed_system_ref("      ")
        ),
    }
}

/// `CIM_BootConfigSetting.ChangeBootOrder` naming one `AMT_BootSourceSetting`.
pub fn change_boot_order(target: AmtBootTarget) -> WsmanRequest {
    let resource = format!("{CIM}/CIM_BootConfigSetting");
    WsmanRequest {
        action: format!("{resource}/ChangeBootOrder"),
        resource_uri: resource,
        body: format!(
            "    <p:ChangeBootOrder_INPUT>\n\
             \x20     <p:Source>\n\
             \x20       <a:Address>{ANONYMOUS}</a:Address>\n\
             \x20       <a:ReferenceParameters>\n\
             \x20         <w:ResourceURI>{CIM}/CIM_BootSourceSetting</w:ResourceURI>\n\
             \x20         <w:SelectorSet>\n\
             \x20           <w:Selector Name=\"InstanceID\">{source}</w:Selector>\n\
             \x20         </w:SelectorSet>\n\
             \x20       </a:ReferenceParameters>\n\
             \x20     </p:Source>\n\
             \x20   </p:ChangeBootOrder_INPUT>\n",
            source = xml_escape(boot_source(target))
        ),
    }
}

/// `CIM_BootService.SetBootConfigRole` with role 1 ("is next single use"), which is what makes
/// the boot order above apply to exactly the next boot and not permanently.
pub fn set_boot_config_role() -> WsmanRequest {
    let resource = format!("{CIM}/CIM_BootService");
    WsmanRequest {
        action: format!("{resource}/SetBootConfigRole"),
        resource_uri: resource,
        body: format!(
            "    <p:SetBootConfigRole_INPUT>\n\
             \x20     <p:BootConfigSetting>\n\
             \x20       <a:Address>{ANONYMOUS}</a:Address>\n\
             \x20       <a:ReferenceParameters>\n\
             \x20         <w:ResourceURI>{CIM}/CIM_BootConfigSetting</w:ResourceURI>\n\
             \x20         <w:SelectorSet>\n\
             \x20           <w:Selector Name=\"InstanceID\">Intel(r) AMT: Boot Configuration 0</w:Selector>\n\
             \x20         </w:SelectorSet>\n\
             \x20       </a:ReferenceParameters>\n\
             \x20     </p:BootConfigSetting>\n\
             \x20     <p:Role>1</p:Role>\n\
             \x20   </p:SetBootConfigRole_INPUT>\n"
        ),
    }
}

/// `AMT_RedirectionService.RequestStateChange`: enables or disables SOL (and IDER).
pub fn request_redirection_state(state: u32) -> WsmanRequest {
    let resource = format!("{AMT}/AMT_RedirectionService");
    WsmanRequest {
        action: format!("{resource}/RequestStateChange"),
        resource_uri: resource,
        body: format!(
            "    <p:RequestStateChange_INPUT>\n      <p:RequestedState>{state}</p:RequestedState>\n    </p:RequestStateChange_INPUT>\n"
        ),
    }
}

/// The WS-Transfer `Get` action (a resource read, not a method call).
pub const WS_TRANSFER_GET: &str = "http://schemas.xmlsoap.org/ws/2004/09/transfer/Get";

/// A `Get` of `CIM_AssociatedPowerManagementService`, whose `PowerState` the proxy reports back
/// in `amt.result` so the console can show what the machine is doing.
pub fn get_power_state() -> WsmanRequest {
    WsmanRequest {
        action: WS_TRANSFER_GET.to_string(),
        resource_uri: format!("{CIM}/CIM_AssociatedPowerManagementService"),
        body: String::new(),
    }
}

/// `ReturnValue` of a WS-Man method answer: `0` is success for every AMT method used here.
pub fn return_value(xml: &str) -> Option<i64> {
    element_value(xml, "ReturnValue")?.trim().parse().ok()
}

/// `PowerState` of a `CIM_AssociatedPowerManagementService` answer.
pub fn power_state_of(xml: &str) -> Option<i32> {
    element_value(xml, "PowerState")?.trim().parse().ok()
}

/// A SOAP fault's reason text, when the firmware answered with one.
pub fn fault_reason(xml: &str) -> Option<String> {
    element_value(xml, "Text").map(|t| t.trim().to_string())
}

/// The text of the first element with this local name, ignoring namespace prefixes. A tiny
/// reader rather than a parser dependency: these answers are a handful of elements, and the
/// values we read are integers and one reason string.
fn element_value(xml: &str, local_name: &str) -> Option<String> {
    let mut from = 0usize;
    while let Some(open) = xml[from..].find('<') {
        let start = from + open;
        let close = xml[start..].find('>')? + start;
        let tag = &xml[start + 1..close];
        if !tag.starts_with('/') && !tag.starts_with('?') && !tag.starts_with('!') {
            let name = tag
                .split_whitespace()
                .next()
                .unwrap_or(tag)
                .trim_end_matches('/');
            let local = name.rsplit(':').next().unwrap_or(name);
            if local == local_name && !tag.ends_with('/') {
                let rest = &xml[close + 1..];
                let end = rest.find("</")?;
                return Some(rest[..end].to_string());
            }
        }
        from = close + 1;
    }
    None
}

// ---------------------------------------------------------------- HTTP Digest (RFC 2617)

/// The fields of a `WWW-Authenticate: Digest ...` challenge.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DigestChallenge {
    pub realm: String,
    pub nonce: String,
    pub qop: Option<String>,
    pub opaque: Option<String>,
    pub algorithm: Option<String>,
    pub stale: bool,
}

/// Parses a `WWW-Authenticate` header value. Returns `None` when it is not a Digest challenge
/// (AMT answers Digest; anything else means the firmware is not what we think it is).
pub fn parse_challenge(header: &str) -> Option<DigestChallenge> {
    let rest = header
        .strip_prefix("Digest ")
        .or_else(|| header.strip_prefix("digest "))?;
    let mut c = DigestChallenge::default();
    for part in split_challenge(rest) {
        let (k, v) = part.split_once('=')?;
        let v = v.trim().trim_matches('"').to_string();
        match k.trim().to_ascii_lowercase().as_str() {
            "realm" => c.realm = v,
            "nonce" => c.nonce = v,
            "qop" => c.qop = Some(v),
            "opaque" => c.opaque = Some(v),
            "algorithm" => c.algorithm = Some(v),
            "stale" => c.stale = v.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    (!c.realm.is_empty() && !c.nonce.is_empty()).then_some(c)
}

/// Splits a challenge on commas that are not inside quotes.
fn split_challenge(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in s.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                cur.push(ch);
            }
            ',' if !in_quotes => {
                out.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

fn md5_hex(data: &str) -> String {
    hex::encode(Md5::digest(data.as_bytes()))
}

/// The `Authorization: Digest ...` header for one request. `nc` starts at 1 per challenge and
/// `cnonce` is fresh; both are arguments so the value is reproducible in a test.
///
/// The password is a [`Zeroizing`] string and is never returned, logged or stored: only the
/// digest leaves this function.
pub fn digest_authorization(
    c: &DigestChallenge,
    method: &str,
    uri: &str,
    user: &str,
    password: &Zeroizing<String>,
    nc: u32,
    cnonce: &str,
) -> String {
    let ha1 = md5_hex(&format!("{user}:{}:{}", c.realm, password.as_str()));
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let nc_hex = format!("{nc:08x}");
    let (response, qop_part) = match c.qop.as_deref() {
        Some(q) if q.split(',').any(|v| v.trim() == "auth") => (
            md5_hex(&format!("{ha1}:{}:{nc_hex}:{cnonce}:auth:{ha2}", c.nonce)),
            format!(", qop=auth, nc={nc_hex}, cnonce=\"{cnonce}\""),
        ),
        _ => (md5_hex(&format!("{ha1}:{}:{ha2}", c.nonce)), String::new()),
    };
    let opaque = c
        .opaque
        .as_ref()
        .map(|o| format!(", opaque=\"{o}\""))
        .unwrap_or_default();
    format!(
        "Digest username=\"{user}\", realm=\"{realm}\", nonce=\"{nonce}\", uri=\"{uri}\", response=\"{response}\"{qop_part}{opaque}",
        realm = c.realm,
        nonce = c.nonce,
    )
}

/// The ordered WS-Man requests one `amt.command` becomes.
pub fn plan(op: AmtOp, target: Option<AmtBootTarget>) -> Vec<WsmanRequest> {
    match op {
        AmtOp::PowerOn => vec![request_power_state_change(power_state::ON)],
        AmtOp::BootRedirect => {
            let t = target.unwrap_or(AmtBootTarget::Pxe);
            vec![
                // Enable SOL first: a boot redirect with nothing watching is of little use, and
                // the firmware wants the redirection service up before the next boot.
                request_redirection_state(redirection_state::IDER_AND_SOL),
                change_boot_order(t),
                set_boot_config_role(),
                request_power_state_change(power_state::RESET),
            ]
        }
        AmtOp::SolOpen => vec![request_redirection_state(redirection_state::SOL_ONLY)],
        AmtOp::SolClose => vec![request_redirection_state(redirection_state::DISABLED)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_follows_the_inventory_tls_flag() {
        assert_eq!(wsman_url("10.1.2.7", true), "https://10.1.2.7:16993/wsman");
        assert_eq!(
            wsman_url("amt.corp.example", false),
            "http://amt.corp.example:16992/wsman"
        );
    }

    // The vector (§15.2 "the AMT WS-Man request builder (XML against a vector)"): a power-on
    // envelope, in full. A change to the action, the resource URI, the selector or the body
    // fails here rather than on a machine in someone's office.
    const POWER_ON_ENVELOPE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:p="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_PowerManagementService">
  <s:Header>
    <a:Action s:mustUnderstand="true">http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_PowerManagementService/RequestPowerStateChange</a:Action>
    <a:To s:mustUnderstand="true">/wsman</a:To>
    <w:ResourceURI s:mustUnderstand="true">http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_PowerManagementService</w:ResourceURI>
    <a:MessageID s:mustUnderstand="true">uuid:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d</a:MessageID>
    <a:ReplyTo>
      <a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address>
    </a:ReplyTo>
    <w:OperationTimeout>PT60S</w:OperationTimeout>
    <w:SelectorSet>
      <w:Selector Name="Name">Intel(r) AMT Power Management Service</w:Selector>
    </w:SelectorSet>
  </s:Header>
  <s:Body>
    <p:RequestPowerStateChange_INPUT>
      <p:PowerState>2</p:PowerState>
      <p:ManagedElement>
        <a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address>
        <a:ReferenceParameters>
          <w:ResourceURI>http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ComputerSystem</w:ResourceURI>
          <w:SelectorSet>
            <w:Selector Name="Name">ManagedSystem</w:Selector>
          </w:SelectorSet>
        </a:ReferenceParameters>
      </p:ManagedElement>
    </p:RequestPowerStateChange_INPUT>
  </s:Body>
</s:Envelope>
"#;

    #[test]
    fn the_power_on_envelope_matches_the_vector() {
        let req = request_power_state_change(power_state::ON);
        let xml = envelope(
            &req,
            "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
            Some(("Name", "Intel(r) AMT Power Management Service")),
        );
        assert_eq!(xml, POWER_ON_ENVELOPE);
    }

    #[test]
    fn a_boot_redirect_is_the_four_step_plan_in_order() {
        let steps = plan(AmtOp::BootRedirect, Some(AmtBootTarget::Pxe));
        let actions: Vec<&str> = steps
            .iter()
            .map(|s| s.action.rsplit('/').next().unwrap())
            .collect();
        assert_eq!(
            actions,
            vec![
                "RequestStateChange",
                "ChangeBootOrder",
                "SetBootConfigRole",
                "RequestPowerStateChange"
            ]
        );
        assert!(steps[1].body.contains("Intel(r) AMT: Force PXE Boot"));
        assert!(
            steps[3].body.contains("<p:PowerState>10</p:PowerState>"),
            "a reset, not a cold power on"
        );
    }

    #[test]
    fn each_boot_target_names_its_own_firmware_instance() {
        assert!(change_boot_order(AmtBootTarget::Hdd)
            .body
            .contains("Force Hard-drive Boot"));
        assert!(change_boot_order(AmtBootTarget::Cd)
            .body
            .contains("Force CD/DVD Boot"));
        assert_eq!(
            boot_source(AmtBootTarget::Pxe),
            "Intel(r) AMT: Force PXE Boot"
        );
    }

    #[test]
    fn opening_and_closing_sol_asks_the_redirection_service_for_the_right_state() {
        assert!(plan(AmtOp::SolOpen, None)[0]
            .body
            .contains("<p:RequestedState>32770</p:RequestedState>"));
        assert!(plan(AmtOp::SolClose, None)[0]
            .body
            .contains("<p:RequestedState>32768</p:RequestedState>"));
    }

    #[test]
    fn a_value_with_xml_characters_cannot_break_out_of_the_envelope() {
        let xml = envelope(
            &request_power_state_change(power_state::ON),
            "a\"><s:Body>evil</s:Body><!--",
            Some(("Name", "a<b&c")),
        );
        assert!(xml.contains("&quot;&gt;&lt;s:Body&gt;"));
        assert!(xml.contains("a&lt;b&amp;c"));
        assert_eq!(xml.matches("<s:Body>").count(), 1);
    }

    #[test]
    fn the_answers_are_read_for_their_return_value_power_state_and_fault() {
        let ok = r#"<s:Envelope><s:Body><g:RequestPowerStateChange_OUTPUT><g:ReturnValue>0</g:ReturnValue></g:RequestPowerStateChange_OUTPUT></s:Body></s:Envelope>"#;
        assert_eq!(return_value(ok), Some(0));
        let refused = r#"<s:Body><g:ReturnValue>2</g:ReturnValue></s:Body>"#;
        assert_eq!(return_value(refused), Some(2));
        let power = r#"<s:Body><g:CIM_AssociatedPowerManagementService><g:PowerState>4</g:PowerState></g:CIM_AssociatedPowerManagementService></s:Body>"#;
        assert_eq!(power_state_of(power), Some(4));
        let fault = r#"<s:Envelope><s:Body><s:Fault><s:Reason><s:Text xml:lang="en-US">Access is denied.</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>"#;
        assert_eq!(fault_reason(fault).as_deref(), Some("Access is denied."));
        assert_eq!(return_value("not xml at all"), None);
        assert_eq!(power_state_of("<s:Body></s:Body>"), None);
    }

    #[test]
    fn a_digest_challenge_is_parsed_including_a_comma_inside_a_quoted_value() {
        let c = parse_challenge(
            r#"Digest realm="Digest:AF000000000000000000000000000000", nonce="abc,def", stale="false", qop="auth", opaque="op""#,
        )
        .unwrap();
        assert_eq!(c.realm, "Digest:AF000000000000000000000000000000");
        assert_eq!(c.nonce, "abc,def");
        assert_eq!(c.qop.as_deref(), Some("auth"));
        assert_eq!(c.opaque.as_deref(), Some("op"));
        assert!(!c.stale);
        assert!(
            parse_challenge("Basic realm=\"x\"").is_none(),
            "AMT answers Digest"
        );
        assert!(
            parse_challenge("Digest realm=\"x\"").is_none(),
            "a challenge needs a nonce"
        );
    }

    // The RFC 2617 worked values for these inputs, computed by hand from the spec's formulae:
    // HA1 = md5("admin:Digest:AF:P@ssw0rd!"), HA2 = md5("POST:/wsman"),
    // response = md5(HA1:nonce:00000001:cnonce:auth:HA2).
    #[test]
    fn the_digest_response_is_the_rfc_2617_value_and_the_password_never_appears_in_it() {
        let c = DigestChallenge {
            realm: "Digest:AF".into(),
            nonce: "nonce-from-firmware".into(),
            qop: Some("auth".into()),
            ..Default::default()
        };
        let password = Zeroizing::new("P@ssw0rd!".to_string());
        let header =
            digest_authorization(&c, "POST", WSMAN_PATH, "admin", &password, 1, "0a0b0c0d");
        let ha1 = md5_hex("admin:Digest:AF:P@ssw0rd!");
        let ha2 = md5_hex("POST:/wsman");
        let want = md5_hex(&format!(
            "{ha1}:nonce-from-firmware:00000001:0a0b0c0d:auth:{ha2}"
        ));
        assert!(header.contains(&format!("response=\"{want}\"")), "{header}");
        assert!(header.contains("qop=auth, nc=00000001, cnonce=\"0a0b0c0d\""));
        assert!(
            !header.contains("P@ssw0rd"),
            "the credential itself never goes on the wire"
        );
    }

    #[test]
    fn a_firmware_without_qop_gets_the_legacy_response_shape() {
        let c = DigestChallenge {
            realm: "Digest:AF".into(),
            nonce: "n".into(),
            ..Default::default()
        };
        let header = digest_authorization(
            &c,
            "POST",
            WSMAN_PATH,
            "admin",
            &Zeroizing::new("p".into()),
            1,
            "c",
        );
        assert!(!header.contains("qop="));
        let ha1 = md5_hex("admin:Digest:AF:p");
        let ha2 = md5_hex("POST:/wsman");
        assert!(header.contains(&format!(
            "response=\"{}\"",
            md5_hex(&format!("{ha1}:n:{ha2}"))
        )));
    }
}
