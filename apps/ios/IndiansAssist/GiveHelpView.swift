import SafariServices
import SwiftUI

/// Give help (section 17.4): the mobile Assist console `<origin>/app/` in an SFSafariViewController, which shares
/// Safari's cookies, so a technician already signed in there stays signed in. No native controller UI (W106).
struct GiveHelpView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if let url = consoleURL {
            SafariView(url: url).ignoresSafeArea()
        } else {
            Text("Set the console address under Server first.").padding()
        }
    }

    private var consoleURL: URL? {
        guard var u = URLComponents(string: model.webOrigin), let scheme = u.scheme?.lowercased(),
              scheme == "https" || scheme == "http", u.host != nil else { return nil }
        u.path = "/app/"
        return u.url
    }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
