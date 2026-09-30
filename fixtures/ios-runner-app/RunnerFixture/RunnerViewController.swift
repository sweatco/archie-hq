import UIKit

final class RunnerViewController: UIViewController {
  private var checkpointTimer: Timer?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground

    let title = UILabel()
    title.text = "Archie iOS Runner"
    title.font = .preferredFont(forTextStyle: .title1)
    title.textAlignment = .center

    let nonce = UILabel()
    nonce.text = runnerFixtureNonce
    nonce.accessibilityIdentifier = "runner.nonce"
    nonce.textAlignment = .center

    let debug = UIButton(type: .system)
    debug.setTitle("Trigger debug checkpoint", for: .normal)
    debug.accessibilityIdentifier = "runner.debug"
    debug.addTarget(self, action: #selector(triggerDebugCheckpoint), for: .touchUpInside)

    let crash = UIButton(type: .system)
    crash.setTitle("Trigger deliberate crash", for: .normal)
    crash.accessibilityIdentifier = "runner.crash"
    crash.addTarget(self, action: #selector(triggerCrash), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [title, nonce, debug, crash])
    stack.axis = .vertical
    stack.alignment = .fill
    stack.spacing = 24
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])

    if ProcessInfo.processInfo.arguments.contains("--archie-debug-loop") {
      checkpointTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
        archieDebugCheckpoint()
      }
    }
    if ProcessInfo.processInfo.arguments.contains("--archie-crash") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        fatalError("ARCHIE_FULL_CYCLE_CRASH")
      }
    }
  }

  @objc private func triggerDebugCheckpoint() {
    archieDebugCheckpoint()
  }

  @objc private func triggerCrash() {
    fatalError("ARCHIE_FULL_CYCLE_CRASH")
  }
}
