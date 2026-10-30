//! egui rendering over [`crate::model`] (contract §11.2 "UI choice: egui + eframe").
//! Compiled under the `gui` feature; built in dev/CI with a display. Kept thin — all logic
//! lives in the view-model so it is tested without a window.

use crate::model::{ConsentModel, PillModel};

/// Draw the always-on-top pill face (text + security code + chip). The host applies
/// `WS_EX_TOPMOST`/`WS_EX_NOACTIVATE` and `WDA_EXCLUDEFROMCAPTURE` to the eframe HWND.
pub fn pill_ui(ui: &mut egui::Ui, pill: &PillModel) {
    ui.horizontal(|ui| {
        ui.label(pill.face_text());
        ui.label(pill.timer_text());
        ui.label(pill.security_code_line());
        if let Some(rec) = pill.recording_label() {
            ui.colored_label(egui::Color32::RED, rec);
        }
        ui.label(pill.chip());
    });
}

/// Draw the consent window body and return `true` if **Share my screen** was clicked and
/// the form is valid (§3.3). The caller then starts capture and sends `desk.consent`.
pub fn consent_ui(ui: &mut egui::Ui, model: &mut ConsentModel) -> bool {
    ui.label(format!(
        "{} ({}) wants to see and control this computer",
        model.technician, model.org
    ));
    for m in &mut model.monitors {
        ui.checkbox(
            &mut m.checked,
            format!("{} ({}x{})", m.info.name, m.info.width, m.info.height),
        );
    }
    ui.checkbox(&mut model.clipboard, "Share clipboard text both ways");
    ui.checkbox(
        &mut model.privacy_ack,
        "I have closed or hidden anything private",
    );
    let enabled = model.can_share();
    ui.add_enabled(enabled, egui::Button::new("Share my screen"))
        .clicked()
        && enabled
}
