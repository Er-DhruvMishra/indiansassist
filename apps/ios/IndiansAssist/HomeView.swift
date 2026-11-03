import SwiftUI

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @State private var showServer = false

    var body: some View {
        NavigationStack(path: $model.route) {
            VStack(spacing: 20) {
                Spacer()
                Text("IndiansAssist").font(.largeTitle.bold())
                Text("Remote support").foregroundStyle(.secondary)
                Spacer()
                NavigationLink(value: AppModel.Route.getHelp) {
                    Label("Get help", systemImage: "rectangle.on.rectangle")
                        .frame(maxWidth: .infinity, minHeight: 56)
                }
                .buttonStyle(.borderedProminent)
                Text("Share this screen with your technician. They can see it, not control it.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                NavigationLink(value: AppModel.Route.giveHelp) {
                    Label("Give help", systemImage: "person.fill.questionmark")
                        .frame(maxWidth: .infinity, minHeight: 56)
                }
                .buttonStyle(.bordered)
                Text("Technicians: open the support console.")
                    .font(.footnote).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(24)
            .toolbar {
                Button("Server") { showServer = true }
            }
            .navigationDestination(for: AppModel.Route.self) { route in
                switch route {
                case .getHelp: GetHelpView()
                case .giveHelp: GiveHelpView()
                }
            }
            .sheet(isPresented: $showServer) { ServerView() }
        }
    }
}

struct ServerView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Support server") {
                    TextField("API address", text: $model.apiOrigin)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Console address", text: $model.webOrigin)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section {
                    Text("Your organisation gives you these if it runs its own server.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Server")
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}
