// Minimal host app: create an iOS App in Xcode, add the TeleDesk package, and replace the App file with this.
import SwiftUI
import TeleDesk

@main
struct ExampleApp: App {
    init() {
        TeleDesk.configure(
            publicKey: "pk_YOUR_PUBLIC_KEY",
            apiURL: URL(string: "https://YOUR-API.execute-api.ap-southeast-2.amazonaws.com")!
        )
        TeleDesk.identify(name: "Jane Appleseed", email: "jane@example.com", meta: ["plan": "pro"])
    }

    var body: some Scene {
        WindowGroup {
            TabView {
                HomeView().tabItem { Label("Home", systemImage: "house") }
                SettingsView().tabItem { Label("Settings", systemImage: "gear") }
            }
        }
    }
}

/// Option 1: floating chat button over any screen.
struct HomeView: View {
    var body: some View {
        NavigationStack {
            List(1...30, id: \.self) { Text("Item \($0)") }
                .navigationTitle("Home")
        }
        .teleDeskFloatingButton()
    }
}

/// Option 2: a row in Settings. Option 3: a regular button anywhere.
struct SettingsView: View {
    var body: some View {
        NavigationStack {
            Form {
                Section("Help") {
                    TeleDeskSupportRow()                         // pushes the chat
                }
                Section {
                    TeleDeskButton("Report a problem")           // opens the chat in a sheet
                }
            }
            .navigationTitle("Settings")
        }
    }
}

// UIKit apps:
//   TeleDesk.showFloatingButton()      // floating button on the key window
//   TeleDesk.present(from: self)       // from any button action
