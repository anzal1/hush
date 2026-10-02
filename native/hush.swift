// hush: a tiny internet-radio player for the Hush Claude Code mod.
//
//   hush daemon <socket>          run the player; one line commands arrive on the socket
//   hush ctl <socket> <command>   send one command, print the JSON reply
//
// Commands: play <url> <name...> | pause | resume | stop | vol <0-100> | seek <seconds>
//           duck <id> | unduck <id> | status | quit
//
// It streams with the system AVPlayer, so it needs no other software. It exits by
// itself when nothing has talked to it for 90 seconds, so it never outlives the
// Claude Code sessions that started it.

import AVFoundation
import Foundation

let duckLevel: Float = 0.35
let idleQuitSeconds: TimeInterval = 90

func jsonString(_ s: String) -> String {
    var out = "\""
    for c in s.unicodeScalars {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if c.value < 0x20 { out += String(format: "\\u%04x", c.value) } else { out.unicodeScalars.append(c) }
        }
    }
    return out + "\""
}

func unixAddress(_ path: String) -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutablePointer(to: &addr.sun_path) {
        $0.withMemoryRebound(to: CChar.self, capacity: 104) { _ = strncpy($0, path, 103) }
    }
    return addr
}

func connectSocket(_ path: String) -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { return nil }
    var addr = unixAddress(path)
    let ok = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if ok != 0 { close(fd); return nil }
    return fd
}

func readAll(_ fd: Int32) -> String {
    var data = Data()
    var buf = [UInt8](repeating: 0, count: 2048)
    while true {
        let n = read(fd, &buf, buf.count)
        if n <= 0 { break }
        data.append(buf, count: n)
        if data.last == 10 { break }
    }
    return String(decoding: data, as: UTF8.self)
}

final class Hush: NSObject, AVPlayerItemMetadataOutputPushDelegate {
    var player: AVPlayer?
    var item: AVPlayerItem?
    var station = ""
    var url = ""
    var title = ""
    var ducked = Set<String>()
    var base: Float = 0.6
    var gain: Float = 0
    var isPaused = false
    var lastContact = Date()
    var ended = false
    var endObserver: NSObjectProtocol?

    func play(url: String, name: String) {
        guard let u = URL(string: url) else { return }
        player?.pause()
        title = ""
        station = name
        self.url = url
        isPaused = false
        ended = false
        gain = 0
        let it = AVPlayerItem(url: u)
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: it, queue: .main) { [weak self] _ in self?.ended = true }
        let out = AVPlayerItemMetadataOutput(identifiers: nil)
        out.setDelegate(self, queue: .main)
        it.add(out)
        let p = AVPlayer(playerItem: it)
        p.volume = 0
        p.play()
        player = p
        item = it
    }

    func metadataOutput(_ output: AVPlayerItemMetadataOutput,
                        didOutputTimedMetadataGroups groups: [AVTimedMetadataGroup],
                        from track: AVPlayerItemTrack?) {
        for group in groups {
            for m in group.items {
                guard let s = m.stringValue, !s.isEmpty else { continue }
                let id = m.identifier?.rawValue ?? ""
                if id.contains("StreamTitle") || m.commonKey == .commonKeyTitle { title = s }
            }
        }
    }

    func tick() {
        guard let p = player else { return }
        let target = (isPaused ? 0 : (ducked.isEmpty ? base : base * duckLevel))
        let step: Float = 0.03
        if abs(target - gain) <= step { gain = target } else { gain += target > gain ? step : -step }
        p.volume = gain
        if isPaused && gain == 0 && p.timeControlStatus != .paused { p.pause() }
    }

    func state() -> String {
        guard let p = player, let it = item else { return "idle" }
        if it.status == .failed { return "failed" }
        if ended { return "ended" }
        if isPaused { return "paused" }
        return p.timeControlStatus == .playing ? "playing" : "loading"
    }

    func position() -> Int {
        guard let p = player else { return 0 }
        let t = CMTimeGetSeconds(p.currentTime())
        return t.isFinite && t > 0 ? Int(t) : 0
    }

    func duration() -> Int {
        guard let it = item else { return 0 }
        let t = CMTimeGetSeconds(it.duration)
        return t.isFinite && t > 0 ? Int(t) : 0
    }

    func statusJSON() -> String {
        "{\"state\":\(jsonString(state())),\"station\":\(jsonString(station)),\"title\":\(jsonString(title)),"
            + "\"volume\":\(Int((base * 100).rounded())),\"ducked\":\(!ducked.isEmpty),"
            + "\"pos\":\(position()),\"dur\":\(duration())}"
    }

    func handle(_ line: String) -> String {
        lastContact = Date()
        let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard let cmd = parts.first else { return statusJSON() }
        switch cmd {
        case "play":
            if parts.count >= 2 { play(url: parts[1], name: parts.dropFirst(2).joined(separator: " ")) }
        case "pause":
            isPaused = true
        case "resume":
            isPaused = false
            player?.play()
        case "stop":
            player?.pause()
            player = nil
            item = nil
            title = ""
            station = ""
        case "seek":
            if parts.count >= 2, let v = Double(parts[1]) { player?.seek(to: CMTime(seconds: v, preferredTimescale: 600)) }
        case "vol":
            if parts.count >= 2, let v = Float(parts[1]) { base = max(0, min(100, v)) / 100 }
        case "duck":
            ducked.insert(parts.count >= 2 ? parts[1] : "x")
        case "unduck":
            if parts.count >= 2 { ducked.remove(parts[1]) } else { ducked.removeAll() }
        case "quit":
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) }
        default:
            break
        }
        return statusJSON()
    }
}

func daemon(socketPath: String) {
    if let fd = connectSocket(socketPath) { close(fd); exit(0) }
    let hush = Hush()

    unlink(socketPath)
    let server = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = unixAddress(socketPath)
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if bound != 0 || listen(server, 8) != 0 { exit(1) }
    chmod(socketPath, 0o600)

    DispatchQueue.global().async {
        while true {
            let client = accept(server, nil, nil)
            if client < 0 { continue }
            var tv = timeval(tv_sec: 2, tv_usec: 0)
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
            let line = readAll(client).trimmingCharacters(in: .whitespacesAndNewlines)
            let reply = DispatchQueue.main.sync { hush.handle(line) } + "\n"
            _ = reply.withCString { write(client, $0, strlen($0)) }
            close(client)
        }
    }

    Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { _ in hush.tick() }
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
        if Date().timeIntervalSince(hush.lastContact) > idleQuitSeconds {
            unlink(socketPath)
            exit(0)
        }
    }
    signal(SIGTERM) { _ in exit(0) }
    RunLoop.main.run()
}

func ctl(socketPath: String, command: String) {
    guard let fd = connectSocket(socketPath) else {
        print("{\"state\":\"offline\"}")
        exit(2)
    }
    var tv = timeval(tv_sec: 3, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    _ = (command + "\n").withCString { write(fd, $0, strlen($0)) }
    print(readAll(fd).trimmingCharacters(in: .whitespacesAndNewlines))
    close(fd)
}

let args = CommandLine.arguments
if args.count >= 3 && args[1] == "daemon" {
    daemon(socketPath: args[2])
} else if args.count >= 4 && args[1] == "ctl" {
    ctl(socketPath: args[2], command: args[3...].joined(separator: " "))
} else {
    FileHandle.standardError.write(Data("usage: hush daemon <socket> | hush ctl <socket> <command>\n".utf8))
    exit(64)
}
