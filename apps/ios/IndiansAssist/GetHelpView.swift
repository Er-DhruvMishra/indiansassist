import ReplayKit
import SwiftUI
import UIKit

/// Get help (section 17.4): enter the code, read the consent screen, then start the broadcast from the system picker.
/// The wording is said before and during sharing.
struct GetHelpView: View {
    @EnvironmentObject var model: AppModel
    @State private var scanning = false
    private let viewOnly = "The technician can see your screen. They cannot control your iPhone; Apple does not allow it."

    var body: some View {
        Form {
            if !model.consented {
                Section("Support code") {
                    TextField("12 digits or a link", text: $model.codeText)
                        .keyboardType(.asciiCapable).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onChange(of: model.codeText) { _ in model.codeError = nil }
                    HStack {
                        Button("Paste") {
                            if let s = UIPasteboard.general.string {
                                model.codeText = s
                                model.tokenSource = .clipboard
                            }
                        }
                        Spacer()
                        Button("Scan QR") { scanning = true }
                    }
                    if let e = model.codeError {
                        Text(e).foregroundStyle(.red).font(.footnote)
                    }
                }
                Section("Before you share") {
                    Text(viewOnly)
                    Text("You can stop at any time from the red bar at the top of the screen or from Control Centre.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("I understand, continue") { _ = model.consent() }
                        .disabled(model.codeText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } else {
                Section("Start sharing") {
                    Text(viewOnly)
                    Text("Tap the button below, then Start Broadcast.").font(.footnote).foregroundStyle(.secondary)
                    BroadcastPicker()
                        .frame(width: 64, height: 64)
                        .frame(maxWidth: .infinity)
                }
                if let note = model.note {
                    Section("Session") {
                        Text(note.technician.map { "\(note.state.capitalized) with \($0)" } ?? note.state.capitalized)
                        ForEach(note.chat, id: \.self) { Text($0) }
                        ForEach(note.files, id: \.self) { Label($0, systemImage: "doc") }
                    }
                }
                Section {
                    Button("Use another code", role: .cancel) { model.consented = false }
                }
            }
        }
        .navigationTitle("Get help")
        .sheet(isPresented: $scanning) {
            QRScannerView { text in
                model.codeText = text
                model.tokenSource = .manual
                scanning = false
            }
        }
        .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in model.refreshNote() }
    }
}

/// The system broadcast picker, preset to this app's extension, microphone off.
struct BroadcastPicker: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let v = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        v.preferredExtension = "com.indiansassist.ios.broadcast"
        v.showsMicrophoneButton = false
        return v
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
