// G10 完了通知／確認の『テキストボックス』ウインドウ（ネイティブ AppKit）。
//
// osascript の display dialog は常に最前面固定で裏に回せず、Tk 8.5 はダークモードで描画が壊れるため、
// Xcode の swiftc（追加インストール不要）でネイティブウインドウを作る:
//   - window.level = .normal → 普通のウインドウ。最初だけ前面→以後は他のウインドウの裏に回せる。
//   - OK（または Enter）／ウインドウを閉じるまで残る（自動で閉じない）→ スリープ後も出たまま。
//   - NSTextField のシステム描画でダーク/ライト自動。文字列は argv（シェルも AppleScript も介さない）。
//
// 使い方:
//   g10_notify_window "<title>" "<message>"                 → OK ボタン1つ（完了通知向け・終了コード 0）
//   g10_notify_window "<title>" "<message>" "却下,許可"      → 複数ボタン。クリックしたボタンの番号で exit
//                                                              （左から 0,1,…。右端＝既定＝Enter）。閉じたら exit 2
import AppKit

final class Controller: NSObject, NSWindowDelegate {
    @objc func clicked(_ sender: NSButton) { exit(Int32(sender.tag)) }   // クリックしたボタンの番号で終了
    func windowWillClose(_ note: Notification) { exit(2) }               // 閉じた＝選択なし
}

let args = CommandLine.arguments
let titleText = args.count > 1 ? args[1] : "G10"
let messageText = args.count > 2 ? args[2] : ""
let buttonTitles: [String] = (args.count > 3 && !args[3].isEmpty) ? args[3].components(separatedBy: ",") : ["OK"]

let app = NSApplication.shared
app.setActivationPolicy(.accessory)          // Dock アイコンを出さない。ウインドウは出せる

let W: CGFloat = 480, H: CGFloat = 240, M: CGFloat = 22
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
msg.frame = NSRect(x: M, y: 70, width: W - 2 * M, height: H - M - 26 - 12 - 70)
content.addSubview(msg)

// ボタンを右端から左へ並べる（右端＝末尾＝既定）
var x = W - M - 104
for (i, t) in buttonTitles.enumerated().reversed() {
    let b = NSButton(title: t, target: controller, action: #selector(Controller.clicked(_:)))
    b.bezelStyle = .rounded
    b.tag = i
    if i == buttonTitles.count - 1 { b.keyEquivalent = "\r" }   // 右端＝既定＝Enter
    b.frame = NSRect(x: x, y: 16, width: 104, height: 34)
    content.addSubview(b)
    x -= 112
}

window.center()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)          // 最初だけ前面へ
app.run()
