import Foundation

struct ChatMessage: Codable, Identifiable, Equatable, Sendable {
    enum Sender: String, Codable, Sendable {
        case visitor, agent, system
    }

    var id: String
    var from: Sender
    var text: String
    var agentName: String?
    var createdAt: String?
    var isPending = false

    private enum CodingKeys: String, CodingKey {
        case id, from, text, agentName, createdAt
    }
}

struct RemoteConfig: Codable, Sendable {
    var name: String
    var color: String
    var greeting: String?
    var agentName: String?
    var online: Bool
}

struct APIError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

struct APIClient: Sendable {
    let baseURL: URL
    let publicKey: String
    let visitorId: String
    var session: URLSession = .shared

    private struct MessagesResponse: Decodable { var messages: [ChatMessage] }
    private struct SendResponse: Decodable { var message: ChatMessage }
    private struct ErrorResponse: Decodable { var error: String }

    private struct SendBody: Encodable {
        var key: String
        var visitorId: String
        var text: String
        var name: String?
        var email: String?
        var meta: [String: String]
    }

    func config() async throws -> RemoteConfig {
        try await get("/v1/client/config", query: [:])
    }

    func messages(after cursor: String?) async throws -> [ChatMessage] {
        var q: [String: String] = [:]
        if let cursor { q["after"] = cursor }
        let r: MessagesResponse = try await get("/v1/client/messages", query: q)
        return r.messages
    }

    func send(text: String, name: String?, email: String?, meta: [String: String]) async throws -> ChatMessage {
        var req = URLRequest(url: baseURL.appendingPathComponent("v1/client/messages"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(
            SendBody(key: publicKey, visitorId: visitorId, text: text, name: name, email: email, meta: meta)
        )
        let r: SendResponse = try await perform(req)
        return r.message
    }

    private struct DeviceBody: Encodable {
        var key: String
        var visitorId: String
        var token: String
        var env: String
    }
    private struct DeviceResponse: Decodable { var pushEnabled: Bool }

    @discardableResult
    func registerDevice(token: String, environment: String) async throws -> Bool {
        var req = URLRequest(url: baseURL.appendingPathComponent("v1/client/device"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(DeviceBody(key: publicKey, visitorId: visitorId, token: token, env: environment))
        let r: DeviceResponse = try await perform(req)
        return r.pushEnabled
    }

    func unregisterDevice() async throws {
        var comps = URLComponents(url: baseURL.appendingPathComponent("v1/client/device"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "key", value: publicKey), URLQueryItem(name: "visitorId", value: visitorId)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "DELETE"
        let (_, response) = try await session.data(for: req)
        guard ((response as? HTTPURLResponse)?.statusCode ?? 0) < 300 else { throw APIError(message: "Unregister failed") }
    }

    private func get<T: Decodable>(_ path: String, query: [String: String]) async throws -> T {
        var comps = URLComponents(url: baseURL.appendingPathComponent(String(path.dropFirst())), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "key", value: publicKey), URLQueryItem(name: "visitorId", value: visitorId)]
            + query.map { URLQueryItem(name: $0.key, value: $0.value) }
        return try await perform(URLRequest(url: comps.url!))
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let msg = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error ?? "Request failed (\(status))"
            throw APIError(message: msg)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
