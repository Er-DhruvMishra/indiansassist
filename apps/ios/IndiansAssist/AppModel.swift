import Foundation
import IASession

/// The app's state: the server addresses, the code being entered, and the hand-off to the broadcast extension.
@MainActor
final class AppModel: ObservableObject {
    enum Route: Hashable { case getHelp, giveHelp }

    @Published var route: [Route] = []
    @Published var codeText = ""
    @Published var tokenSource: TokenSource = .manual
    @Published var codeError: String?
    @Published var consented = false
    @Published var note: SessionNote?
    @Published var apiOrigin: String {
        didSet { UserDefaults.standard.set(apiOrigin, forKey: "server.api") }
    }
    @Published var webOrigin: String {
        didSet { UserDefaults.standard.set(webOrigin, forKey: "server.web") }
    }

    private let group = UserDefaults(suiteName: JoinHandoff.appGroup)
    private let handoffs = HandoffStore.appGroup()

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        apiOrigin = UserDefaults.standard.string(forKey: "server.api") ?? (info["IAApiOrigin"] as? String ?? "")
        webOrigin = UserDefaults.standard.string(forKey: "server.web") ?? (info["IAWebOrigin"] as? String ?? "")
        // A code never stays on disk: a hand-off the extension never took is removed at launch.
        handoffs?.clear()
    }

    /// "Use another code": the consent is withdrawn and any hand-off not yet taken is removed.
    func cancel() {
        handoffs?.clear()
        consented = false
    }

    /// Hosts a web join link may come from: the configured web origin's host (with its port when it has one).
    var allowedHosts: Set<String> {
        guard let u = URLComponents(string: webOrigin), let h = u.host?.lowercased() else { return [] }
        return u.port.map { [h, "\(h):\($0)"] } ?? [h]
    }

    /// The parsed code, or nil with `codeError` set.
    func parsedCode() -> JoinCode? {
        guard let code = JoinInput.parseAny(codeText, allowedHosts: allowedHosts) else {
            codeError = "That is not a support code. It is 12 digits, or a link from your technician."
            return nil
        }
        if code.kind == .shortCode && !JoinInput.isValidShortCode(code.value) {
            codeError = "Please check the 12 digits; one of them looks wrong."
            return nil
        }
        codeError = nil
        return code
    }

    /// `indiansassist://join?...`: fill the code and go to Get help.
    func open(url: URL) {
        guard JoinInput.parseLink(url.absoluteString, allowedHosts: allowedHosts) != nil else { return }
        codeText = url.absoluteString
        tokenSource = .deeplink
        cancel()
        route = [.getHelp]
    }

    /// The person accepted the consent screen: write the hand-off the extension starts from.
    func consent() -> Bool {
        guard let code = parsedCode(), let handoffs else { return false }
        let handoff = JoinHandoff(code: code.value, tokenSource: tokenSource, apiOrigin: apiOrigin, consentedAt: Date())
        guard handoff.signalUrl != nil else {
            codeError = "The server address is not valid. Check it under Server."
            return false
        }
        do {
            try handoffs.write(handoff)
        } catch {
            codeError = "The code could not be handed to the screen-sharing extension."
            return false
        }
        consented = true
        return true
    }

    func refreshNote() {
        if let group { note = SessionNote.load(from: group) }
    }
}
