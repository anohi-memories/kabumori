// G10 完了通知の『テキストボックス』ウインドウ（ネイティブ AppKit）。
//
// osascript の display dialog は常に最前面に固定され、Tk 8.5 はダークモードで描画が壊れるため、
// Xcode の swiftc（追加インストール不要）でネイティブウインドウを作る:
//   - window.level = .normal → 普通のウインドウ。最初だけ前面に出し、以後は他のウインドウの裏に回せる。
//   - OK（または Enter）／ウインドウを閉じるまで残る（自動で閉じない）→ スリープ後も出たまま。
//   - NSTextField のラベルはシステム描画 → ダーク/ライトどちらでも読める（色指定不要）。
//   - 文字列は argv で受け取る（シェルも AppleScript も介さないので注入の余地がない）。
// GUI(aqua) セッションのプロセスからのみ画面に出る。collector は fire-and-forget で起動し待たない。
//
//   swiftc -O notify_window.swift -o g10_notify_window
//   ./g10_notify_window "<title>" "<message>"
import AppKit

final class Controller: NSObject, NSWindowDelegate {
    @objc func dismiss() { exit(0) }
    func windowWillClose(_ note: Notification) { exit(0) }
}

let args = CommandLine.arguments
let titleText = args.count > 1 ? args[1] : "G10"
let messageText = args.count > 2 ? args[2] : ""

let app = NSApplication.shared
app.setActivationPolicy(.accessory)          // Dock アイコンを出さない。ウインドウは出せる

let W: CGFloat = 480, H: CGFloat = 230, M: CGFloat = 22
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: W, height: H),
                      styleMask: [.titled, .closable, .miniaturizable],
                      backing: .buffered, defer: false)
window.title = titleText
window.level = .normal                        // 最前面固定にしない＝裏に回せる
window.isReleasedWhenClosed = false
let controller = Controller()
window.delegate = controller
let content = window.contentView!

let titleLabel = NSTextField(labelWithString: titleText)
titleLabel.font = NSFont.boldSystemFont(ofSize: 15)
titleLabel.frame = NSRect(x: M, y: H - M - 26, width: W - 2 * M, height: 26)
content.addSubview(titleLabel)

let msg = NSTextField(wrappingLabelWithString: messageText)
msg.font = NSFont.systemFont(ofSize: 13)
msg.frame = NSRect(x: M, y: 62, width: W - 2 * M, height: H - M - 26 - 12 - 62)
content.addSubview(msg)

let ok = NSButton(title: "OK", target: controller, action: #selector(Controller.dismiss))
ok.bezelStyle = .rounded
ok.keyEquivalent = "\r"                        // Enter で閉じる
ok.frame = NSRect(x: W - M - 104, y: 16, width: 104, height: 34)
content.addSubview(ok)

window.center()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)          // 最初だけ前面へ
app.run()
