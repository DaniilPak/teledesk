# TeleDesk

Support tickets for iOS apps and websites, answered from Telegram.

Customers write in a chat (iOS SDK or web widget) → you get a ticket in Telegram → you **reply to the bot's message** → the customer sees the answer in the chat.

```
iOS app (TeleDesk SDK) ─┐                    ┌─ Telegram (owner / team group)
                        ├─► API Gateway ─► Lambda ◄── Telegram webhook
Website (widget.js) ────┘        │             │
                                 │         DynamoDB
SaaS dashboard (S3 + CloudFront) ┘
```

| Part | Path | Stack |
|---|---|---|
| API + Telegram bot | `backend/src` | Node.js 22 Lambda, no dependencies (AWS SDK v3 from the runtime) |
| Infrastructure | `infra` | Terraform: DynamoDB, Lambda, HTTP API, S3 + CloudFront |
| SaaS dashboard | `web/dashboard` | Vanilla HTML/JS (sign up, projects, Telegram connect, tickets, settings) |
| Web chat widget | `web/widget/widget.js` | One script tag, Shadow DOM, no dependencies |
| iOS SDK | `Package.swift`, `ios/` | Swift Package, SwiftUI chat UI, iOS 16+ |

## Deploy (platform operator, once)

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`).
2. Configure and apply:
   ```bash
   cp infra/terraform.tfvars.example infra/terraform.tfvars   # set token + username
   cd infra && terraform init && terraform apply
   ```
3. Open the `dashboard_url` output. Terraform also registers the bot webhook and commands
   (set `register_telegram_webhook = false` to skip; it replaces any existing webhook on that bot).

Default region is `ap-southeast-2`. Everything is pay-per-request; idle cost is ~zero.

## Setup for owners (what your users do — ~2 minutes)

1. **Sign up** on the dashboard and create a project.
2. **Connect Telegram** → *Open in Telegram* → press **Start**. (Or *Add to a group* so the whole team sees tickets.)
3. **Install** the snippet shown on the Setup tab:

   **Website**
   ```html
   <script src="https://<cdn>/widget.js" data-key="pk_..." async></script>
   <script>
     window.TeleDesk = window.TeleDesk || function () { (TeleDesk.q = TeleDesk.q || []).push(arguments) };
     TeleDesk('identify', { name: 'Jane', email: 'jane@example.com', meta: { plan: 'pro' } }); // optional
     // TeleDesk('open') / TeleDesk('close') / TeleDesk('toggle')
   </script>
   ```
   Optional attributes: `data-position="left"`.

   **iOS** — Xcode → *Add Package Dependencies* → `https://github.com/DaniilPak/teledesk` (version 0.2.0 or later).
   ```swift
   import TeleDesk

   TeleDesk.configure(publicKey: "pk_...", apiURL: URL(string: "https://<api>")!)
   TeleDesk.identify(name: "Jane", email: "jane@example.com", meta: ["plan": "pro"])

   ```
   Then pick how customers open the chat (combine freely):

   | Entry point | SwiftUI | UIKit |
   |---|---|---|
   | Floating button over the app | `ContentView().teleDeskFloatingButton()` | `TeleDesk.showFloatingButton()` |
   | Row in your Settings screen (icon, unread badge, chevron) | `Form { TeleDeskSupportRow() }` (push) or `TeleDeskSupportRow(presentation: .sheet)` | — |
   | Your own button | `TeleDeskButton("Contact support")` or `TeleDeskButton { Label(...) }` | `TeleDesk.present(from: self)` |
   | Embed the chat directly | `TeleDeskChatView()` | `TeleDesk.makeViewController()` |

   Call `TeleDesk.reset()` on logout. `TeleDesk.unreadCount` gives unread agent replies.
   See `ios/Example/ExampleApp.swift`.

## Answering in Telegram

**Group with Topics (recommended for teams / volume).** Turn on *Topics* in the group and make the bot an admin with *Manage topics* (the dashboard's "Team group" link asks for that right). Then:
- Every ticket opens its own topic, `🟢 #12 · Jane`, with the customer's details.
- **Write in the topic** to answer — no reply needed. 👍 confirms delivery.
- **✅ Close** / `/close` renames it `✅ #12 · Jane` and closes it (or deletes it — Telegram page setting). History stays in the dashboard.

**Private chat or group without Topics.** Tickets arrive as messages; **reply** to one to answer. The bot detects when you enable Topics or promote it and switches automatically.

Commands: `/tickets` lists open tickets · `/close`, `/reopen` · `/help`. You can also answer from the dashboard; replies are mirrored to Telegram.

**Bursts.** Telegram lets a bot post ~20 messages/minute per group. When it's throttled, deliveries wait in an SQS queue and go out in order as soon as Telegram allows — nothing is dropped, and customers' messages are visible in the dashboard immediately.

## Push notifications (iOS)

1. Apple Developer → Keys → create an APNs key, download the `.p8`.
2. Dashboard → Settings → *iOS push notifications*: upload it with Key ID, Team ID and bundle ID.
3. In the app: Push Notifications capability, then
   ```swift
   // AppDelegate
   UNUserNotificationCenter.current().delegate = TeleDesk.notificationDelegate   // or forward from yours
   func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
       TeleDesk.setDeviceToken(token)
   }
   await TeleDesk.requestPushAuthorization()   // when it makes sense
   ```
   Or let the SDK ask when the customer opens the chat: `TeleDesk.configure(.init(publicKey: …, apiURL: …, requestsPushOnChatOpen: true))`.
   Replies from support then notify the customer; tapping opens the chat. While the chat is on screen, no banner is shown.
   With your own delegate, use `TeleDesk.presentationOptions(for:)` and `TeleDesk.handleNotificationResponse(_:)`.

## Live dashboard

The dashboard keeps a WebSocket open (API Gateway WebSockets) and refreshes instantly on new tickets, messages and status changes; the green dot in the sidebar shows it's connected.

## Local development

```bash
npm test        # end-to-end backend flow test (in-memory store, fake Telegram)
npm run dev     # http://localhost:8787 — dashboard; /demo.html?key=pk_... — widget demo
```
The dev server keeps data in memory and logs Telegram calls instead of sending them.
Simulate a Telegram update with `curl localhost:8787/dev/telegram -d '<Update JSON>'`.

iOS tests: `xcodebuild test -scheme TeleDesk -destination 'platform=iOS Simulator,name=iPhone 18 Pro'`

## API

Client (public key): `GET /v1/client/config?key=`, `POST /v1/client/messages {key, visitorId, text, name?, email?, meta?}`, `GET /v1/client/messages?key=&visitorId=&after=<cursor>`.
Dashboard (Bearer JWT): `/v1/auth/{signup,login}`, `/v1/me`, `/v1/projects[/:id]`, `/v1/projects/:id/telegram[/link]`, `/v1/projects/:id/tickets[/:n[/reply|/status]]`.
Telegram: `POST /v1/telegram/webhook` (verified with `X-Telegram-Bot-Api-Secret-Token`).

## Notes and limits

- Customer chats poll every 3 s while open; iOS customers also get push notifications for replies.
- Visitors are identified by a random 144-bit id stored on the device/browser; anyone holding that id can read that conversation. Add HMAC identity verification before handling sensitive data.
- Text messages only (no attachments yet).
- Bot token and JWT secret are Lambda environment variables; move them to SSM/Secrets Manager for stricter setups.
