import Foundation
import IASec

/// The `/signal` WebSocket of the broadcast extension (URLSessionWebSocketTask). Every callback arrives on `queue`.
final class SignalSocket: NSObject, URLSessionWebSocketDelegate {
    private let queue: DispatchQueue
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    var onOpen: (() -> Void)?
    var onMessage: ((JSONValue) -> Void)?
    var onClose: ((Int) -> Void)?

    init(queue: DispatchQueue) {
        self.queue = queue
        super.init()
        let delegateQueue = OperationQueue()
        delegateQueue.underlyingQueue = queue
        delegateQueue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: delegateQueue)
    }

    func connect(_ url: URL) {
        task?.cancel(with: .goingAway, reason: nil)
        let t = session.webSocketTask(with: url)
        t.maximumMessageSize = 256 * 1024
        task = t
        t.resume()
        receive(t)
    }

    func send(_ msg: JSONValue) {
        task?.send(.string(CanonicalJSON.string(msg))) { _ in }
    }

    func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard t === self.task else { return }
                switch result {
                case let .success(.string(text)):
                    if let v = JSONValue.parse(text) { self.onMessage?(v) }
                    self.receive(t)
                case .success:
                    self.receive(t)
                case .failure:
                    break // didCloseWith or didCompleteWithError reports the close
                }
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        onOpen?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        task = nil
        onClose?(closeCode.rawValue)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task, error != nil else { return }
        self.task = nil
        onClose?(1006)
    }
}
