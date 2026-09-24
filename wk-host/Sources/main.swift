// Native WebKit host for RPG Maker MV games (built for Fear & Hunger 2: Termina).
//
// - Serves the game's files from Contents/Resources/app.nw on 127.0.0.1:7777.
// - Shows them in a WKWebView (WebKit, native arm64).
// - POST /rpc {"method","params"} (token in X-Bridge-Token) is forwarded into the page
//   as window.ClaudeBridge.call(method, params), so the same MCP server works unchanged.
import Cocoa
import Network
import WebKit

let port: UInt16 = 7777

func log(_ s: String) { fputs("[FungerWK] \(s)\n", stderr) }

// MARK: - Token shared with the MCP server

func loadToken() -> String {
    let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".fear-hunger-bridge-token")
    if let s = try? String(contentsOf: url, encoding: .utf8) {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
    }
    var bytes = [UInt8](repeating: 0, count: 24)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    let token = bytes.map { String(format: "%02x", $0) }.joined()
    try? token.write(to: url, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    return token
}

// MARK: - HTTP server (static files + /rpc)

struct Request {
    var method = ""
    var target = ""
    var headers: [String: String] = [:]
    var body = Data()
}

final class GameServer {
    let root: String
    let token: String
    let queue = DispatchQueue(label: "game-server")
    var listener: NWListener?
    /// body -> completion(json response body, http status)
    var onRPC: ((Data, @escaping (Data, Int) -> Void) -> Void)?

    init(root: String, token: String) {
        self.root = root
        self.token = token
    }

    func start() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        l.stateUpdateHandler = { state in
            log("listener state: \(state)")
        }
        l.start(queue: queue)
        listener = l
    }

    func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        readRequest(conn, buffer: Data())
    }

    func readRequest(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            guard let self = self else { return }
            var buf = buffer
            if let data = data { buf.append(data) }
            if error != nil || (done && data == nil) { conn.cancel(); return }
            guard let sep = buf.range(of: Data("\r\n\r\n".utf8)) else {
                if buf.count > 1 << 20 { conn.cancel() } else { self.readRequest(conn, buffer: buf) }
                return
            }
            let head = String(decoding: buf[buf.startIndex..<sep.lowerBound], as: UTF8.self)
            var lines = head.components(separatedBy: "\r\n")
            let first = lines.removeFirst().split(separator: " ", maxSplits: 2).map(String.init)
            guard first.count >= 2 else { conn.cancel(); return }
            var req = Request(method: first[0], target: first[1])
            for l in lines {
                if let i = l.firstIndex(of: ":") {
                    req.headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
                }
            }
            let need = Int(req.headers["content-length"] ?? "0") ?? 0
            let bodyStart = sep.upperBound
            if need > 64 << 20 { conn.cancel(); return }
            if buf.count - bodyStart < need {
                self.readRequest(conn, buffer: buf)
                return
            }
            req.body = buf[bodyStart..<(bodyStart + need)]
            self.dispatch(conn, req)
        }
    }

    func dispatch(_ conn: NWConnection, _ req: Request) {
        let keepAlive = (req.headers["connection"]?.lowercased() != "close")
        let next: () -> Void = { [weak self] in
            if keepAlive { self?.readRequest(conn, buffer: Data()) } else { conn.cancel() }
        }
        let path = req.target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"

        if path == "/rpc" {
            guard req.method == "POST", req.headers["origin"] == nil, req.headers["x-bridge-token"] == token else {
                return sendBody(conn, status: 403, type: "application/json", body: Data("{\"error\":\"forbidden\"}".utf8), next: next)
            }
            guard let rpc = onRPC else {
                return sendBody(conn, status: 503, type: "application/json", body: Data("{\"error\":\"not ready\"}".utf8), next: next)
            }
            rpc(req.body) { [weak self] body, status in
                self?.queue.async { self?.sendBody(conn, status: status, type: "application/json", body: body, next: next) }
            }
            return
        }
        if path.hasPrefix("/store/") {
            return handleStore(conn, req, path: path, next: next)
        }
        guard req.method == "GET" || req.method == "HEAD" else {
            return sendBody(conn, status: 405, type: "text/plain", body: Data("method not allowed".utf8), next: next)
        }
        serveFile(conn, req, path: path, next: next)
    }

    /// Save-file storage (replaces localStorage, which is too small for this game's saves).
    static let storeDir: String = {
        let dir = NSString(string: "~/Library/Application Support/FungerWK/store").expandingTildeInPath
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }()

    func handleStore(_ conn: NWConnection, _ req: Request, path: String, next: @escaping () -> Void) {
        let name = String(path.dropFirst("/store/".count)).removingPercentEncoding ?? ""
        let ok = !name.isEmpty && name.count < 100 && name.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || " _.-".unicodeScalars.contains($0)
        } && !name.hasPrefix(".")
        // custom header forces a CORS preflight for cross-site pages, which we never answer
        guard ok, req.headers["x-fung-store"] == "1" else {
            return sendBody(conn, status: 403, type: "text/plain", body: Data("forbidden".utf8), next: next)
        }
        let file = GameServer.storeDir + "/" + name
        switch req.method {
        case "PUT":
            do { try req.body.write(to: URL(fileURLWithPath: file), options: .atomic) } catch {
                return sendBody(conn, status: 500, type: "text/plain", body: Data("write failed".utf8), next: next)
            }
            sendBody(conn, status: 200, type: "text/plain", body: Data("ok".utf8), next: next)
        case "GET", "HEAD":
            guard let data = FileManager.default.contents(atPath: file) else {
                return sendBody(conn, status: 404, type: "text/plain", body: Data(), next: next)
            }
            sendBody(conn, status: 200, type: "text/plain", body: req.method == "HEAD" ? Data() : data, next: next)
        case "DELETE":
            try? FileManager.default.removeItem(atPath: file)
            sendBody(conn, status: 200, type: "text/plain", body: Data("ok".utf8), next: next)
        default:
            sendBody(conn, status: 405, type: "text/plain", body: Data(), next: next)
        }
    }

    static let reasons = [200: "OK", 206: "Partial Content", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
                          416: "Range Not Satisfiable", 500: "Internal Server Error", 503: "Service Unavailable"]

    func header(_ status: Int, _ fields: [(String, String)]) -> Data {
        var s = "HTTP/1.1 \(status) \(GameServer.reasons[status] ?? "OK")\r\n"
        for (k, v) in fields { s += "\(k): \(v)\r\n" }
        s += "\r\n"
        return Data(s.utf8)
    }

    func sendBody(_ conn: NWConnection, status: Int, type: String, body: Data, next: @escaping () -> Void) {
        var out = header(status, [("Content-Type", type), ("Content-Length", "\(body.count)"), ("Cache-Control", "no-store")])
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { err in
            if err != nil { conn.cancel() } else { next() }
        })
    }

    static let mime: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css",
        "json": "application/json", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "svg": "image/svg+xml", "webm": "video/webm", "mp4": "video/mp4",
        "m4a": "audio/mp4", "ogg": "audio/ogg", "mp3": "audio/mpeg", "wav": "audio/wav",
        "ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2", "ico": "image/x-icon",
        "txt": "text/plain; charset=utf-8",
    ]

    func serveFile(_ conn: NWConnection, _ req: Request, path: String, next: @escaping () -> Void) {
        var rel = path.removingPercentEncoding ?? path
        if rel == "/" { rel = "/index.html" }
        if rel.contains("..") { return sendBody(conn, status: 403, type: "text/plain", body: Data("forbidden".utf8), next: next) }
        let full = root + rel
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: full, isDirectory: &isDir), !isDir.boolValue,
              let attrs = try? FileManager.default.attributesOfItem(atPath: full),
              let size = (attrs[.size] as? NSNumber)?.uint64Value,
              let handle = FileHandle(forReadingAtPath: full)
        else { return sendBody(conn, status: 404, type: "text/plain", body: Data("not found".utf8), next: next) }

        var start: UInt64 = 0
        var end: UInt64 = size == 0 ? 0 : size - 1
        var status = 200
        if let r = req.headers["range"], r.hasPrefix("bytes=") {
            let spec = r.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
            if spec.count == 2 {
                if let a = UInt64(spec[0]) {
                    start = a
                    if let b = UInt64(spec[1]) { end = min(b, end) }
                } else if let n = UInt64(spec[1]) {   // suffix range
                    start = size > n ? size - n : 0
                }
                if start > end || start >= size {
                    try? handle.close()
                    let h = header(416, [("Content-Range", "bytes */\(size)"), ("Content-Length", "0")])
                    return conn.send(content: h, completion: .contentProcessed { _ in next() })
                }
                status = 206
            }
        }
        let length = size == 0 ? 0 : end - start + 1
        let ext = (rel as NSString).pathExtension.lowercased()
        var fields: [(String, String)] = [
            ("Content-Type", GameServer.mime[ext] ?? "application/octet-stream"),
            ("Content-Length", "\(length)"),
            ("Accept-Ranges", "bytes"),
            ("Cache-Control", "no-cache"),
        ]
        if status == 206 { fields.append(("Content-Range", "bytes \(start)-\(end)/\(size)")) }
        let head = header(status, fields)
        if req.method == "HEAD" || length == 0 {
            try? handle.close()
            return conn.send(content: head, completion: .contentProcessed { err in if err != nil { conn.cancel() } else { next() } })
        }
        try? handle.seek(toOffset: start)
        conn.send(content: head, completion: .contentProcessed { [weak self] err in
            if err != nil { try? handle.close(); conn.cancel(); return }
            self?.pump(conn, handle: handle, remaining: length, next: next)
        })
    }

    func pump(_ conn: NWConnection, handle: FileHandle, remaining: UInt64, next: @escaping () -> Void) {
        if remaining == 0 { try? handle.close(); next(); return }
        let n = Int(min(remaining, 1 << 18))
        guard let chunk = try? handle.read(upToCount: n), !chunk.isEmpty else {
            try? handle.close(); conn.cancel(); return
        }
        conn.send(content: chunk, completion: .contentProcessed { [weak self] err in
            if err != nil { try? handle.close(); conn.cancel(); return }
            self?.pump(conn, handle: handle, remaining: remaining - UInt64(chunk.count), next: next)
        })
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: GameServer!
    var activity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ note: Notification) {
        log("didFinishLaunching")
        let root = ProcessInfo.processInfo.environment["FUNGER_ROOT"]
            ?? Bundle.main.resourcePath.map { $0 + "/app.nw" } ?? "."
        server = GameServer(root: root, token: loadToken())

        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.preferences.isElementFullscreenEnabled = true
        // Keep the game ticking when the window is not frontmost (best effort; private WebKit knob).
        let sel = NSSelectorFromString("_setPageVisibilityBasedProcessSuppressionEnabled:")
        if cfg.preferences.responds(to: sel), let imp = cfg.preferences.method(for: sel) {
            typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
            unsafeBitCast(imp, to: Setter.self)(cfg.preferences, sel, false)
        }
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled, .latencyCritical],
                                                         reason: "Running the game")
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.isInspectable = true
        // Private WebKit knob: keep the page "visible" even when another window covers it, so the game
        // (and the MCP bridge) keeps running while you work in other apps.
        let occl = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if webView.responds(to: occl), let imp = webView.method(for: occl) {
            typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
            unsafeBitCast(imp, to: Setter.self)(webView, occl, false)
            log("occlusion detection disabled")
        } else {
            log("occlusion SPI unavailable")
        }
        webView.setValue(false, forKey: "drawsBackground")

        server.onRPC = { [weak self] body, done in
            DispatchQueue.main.async { self?.forward(body, done) }
        }
        do { try server.start(); log("listening on 127.0.0.1:\(port), root=\(root)") } catch {
            log("listen failed: \(error)")
            let a = NSAlert(); a.messageText = "Cannot listen on 127.0.0.1:\(port)"; a.informativeText = "\(error). Is the NW.js version of the game already running?"
            a.runModal(); NSApp.terminate(nil); return
        }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 816, height: 624),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Fear & Hunger 2: TERMINA (WebKit)"
        window.contentView = webView
        window.delegate = self
        window.collectionBehavior = [.fullScreenPrimary]
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)

        log("loading page")
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/index.html")!))
    }

    func forward(_ body: Data, _ done: @escaping (Data, Int) -> Void) {
        func fail(_ msg: String, _ status: Int = 200) {
            let obj = try? JSONSerialization.data(withJSONObject: ["error": msg])
            done(obj ?? Data("{\"error\":\"?\"}".utf8), status)
        }
        guard let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let method = obj["method"] as? String else { return fail("bad json", 400) }
        let params = (try? JSONSerialization.data(withJSONObject: obj["params"] ?? [String: Any]())) ?? Data("{}".utf8)
        let js = """
        try { return JSON.stringify({result: await window.ClaudeBridge.call(m, JSON.parse(p))}); }
        catch (e) { return JSON.stringify({error: String((e && e.message) || e)}); }
        """
        webView.callAsyncJavaScript(js, arguments: ["m": method, "p": String(decoding: params, as: UTF8.self)],
                                    in: nil, in: .page) { result in
            switch result {
            case .success(let v):
                if let s = v as? String { done(Data(s.utf8), 200) } else { fail("empty result") }
            case .failure(let e):
                fail("bridge not ready: \(e.localizedDescription)")
            }
        }
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View"); viewItem.submenu = viewMenu
        let fs = viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        let reload = viewMenu.addItem(withTitle: "Reload", action: #selector(reloadGame), keyEquivalent: "r")
        reload.target = self
        NSApp.mainMenu = main
    }

    @objc func reloadGame() { webView.reloadFromOrigin() }
    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

log("main start")
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
