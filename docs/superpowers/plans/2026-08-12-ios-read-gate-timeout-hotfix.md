# iOS Read Gate Timeout Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve deterministic secure-store read synchronization while making missing read events fail within seconds instead of hanging iOS CI.

**Architecture:** Add one test-only bounded async signal that owns continuation registration, signaling, timeout, and cancellation cleanup. Both secure-store test doubles will delegate read-start synchronization to this helper while retaining their existing `NSCondition` boundary for blocking and releasing the actual read.

**Tech Stack:** Swift 6, XCTest, Foundation concurrency, XcodeGen, xcodebuild, GitHub CLI

---

## File Structure

- Create `native/ios/PsycheCore/Tests/PsycheCoreTests/BoundedAsyncSignal.swift`: reusable test-only signal with bounded waits and cancellation-safe continuation cleanup.
- Create `native/ios/PsycheCore/Tests/PsycheCoreTests/BoundedAsyncSignalTests.swift`: direct signal, timeout, and cancellation tests.
- Modify `native/ios/PsycheCore/Tests/PsycheCoreTests/ConnectionManagerTests.swift`: use the shared signal in `BlockingReadSecureStore` and propagate bounded wait errors.
- Modify `native/ios/PsycheCore/Tests/PsycheCoreTests/PairedHostStoreTests.swift`: use the same signal in `SaveBoundarySecureStore`.

### Task 1: Create the Isolated iOS Hotfix Worktree

**Files:**
- Read: `docs/superpowers/specs/2026-08-12-merged-regression-hotfixes-design.md`

- [ ] **Step 1: Refresh the protected base**

Run:

```bash
git fetch --prune origin
```

Expected: command exits successfully and `origin/main` is current.

- [ ] **Step 2: Create a clean worktree from `origin/main`**

Run from the repository root:

```bash
git worktree add -b test/ios-bounded-read-gates \
  ../psyche-build-ios-bounded-read-gates \
  origin/main
```

Expected: Git creates `../psyche-build-ios-bounded-read-gates` on branch `test/ios-bounded-read-gates`.

- [ ] **Step 3: Confirm isolation**

Run:

```bash
git -C ../psyche-build-ios-bounded-read-gates status --short --branch
```

Expected:

```text
## test/ios-bounded-read-gates...origin/main
```

### Task 2: Add the Bounded Async Signal and Its Tests

**Files:**
- Create: `native/ios/PsycheCore/Tests/PsycheCoreTests/BoundedAsyncSignal.swift`
- Create: `native/ios/PsycheCore/Tests/PsycheCoreTests/BoundedAsyncSignalTests.swift`

- [ ] **Step 1: Write the signal tests first**

Create `BoundedAsyncSignalTests.swift`:

```swift
import XCTest

final class BoundedAsyncSignalTests: XCTestCase {
    func testSignalCompletesRegisteredWaiter() async throws {
        let signal = BoundedAsyncSignal()
        let waiter = Task {
            try await signal.wait(for: "secure-store read", timeout: .seconds(1))
        }

        signal.signal()

        try await waiter.value
    }

    func testWaitFailsAtTheBoundedDeadline() async {
        let signal = BoundedAsyncSignal()

        do {
            try await signal.wait(
                for: "secure-store read",
                timeout: .milliseconds(20)
            )
            XCTFail("Expected the bounded wait to time out")
        } catch {
            XCTAssertEqual(
                error as? BoundedAsyncSignal.WaitError,
                .timedOut("secure-store read")
            )
        }
    }

    func testCancellationRemovesThePendingContinuation() async {
        let signal = BoundedAsyncSignal()
        let waiter = Task {
            try await signal.wait(for: "secure-store read", timeout: .seconds(1))
        }

        waiter.cancel()

        do {
            try await waiter.value
            XCTFail("Expected cancellation to reach the waiter")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        signal.signal()
    }
}
```

- [ ] **Step 2: Generate the Xcode project**

Run:

```bash
cd ../psyche-build-ios-bounded-read-gates
pnpm ios:project:generate
```

Expected: XcodeGen includes both new files in the `PsycheCoreTests` target.

- [ ] **Step 3: Run the new test and verify it fails to compile**

Run:

```bash
xcodebuild test \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build-read-gate-hotfix \
  -only-testing:PsycheCoreTests/BoundedAsyncSignalTests
```

Expected: build fails because `BoundedAsyncSignal` does not exist.

- [ ] **Step 4: Implement the bounded signal**

Create `BoundedAsyncSignal.swift`:

```swift
import Foundation

final class BoundedAsyncSignal: @unchecked Sendable {
    enum WaitError: Error, Equatable, LocalizedError {
        case timedOut(String)

        var errorDescription: String? {
            switch self {
            case .timedOut(let event):
                return "Timed out waiting for \(event)"
            }
        }
    }

    private let lock = NSLock()
    private var isSignaled = false
    private var waiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
    private var cancelledWaiterIDs: Set<UUID> = []

    func reset() {
        let pending = lock.withLock {
            isSignaled = false
            cancelledWaiterIDs.removeAll()
            let pending = Array(waiters.values)
            waiters.removeAll()
            return pending
        }
        pending.forEach { $0.resume(throwing: CancellationError()) }
    }

    func wait(
        for event: String,
        timeout: Duration = .seconds(2)
    ) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                let immediateResult: Result<Void, any Error>? = lock.withLock {
                    if isSignaled {
                        return .success(())
                    }
                    if cancelledWaiterIDs.remove(id) != nil {
                        return .failure(CancellationError())
                    }
                    waiters[id] = continuation
                    return nil
                }
                if let immediateResult {
                    continuation.resume(with: immediateResult)
                    return
                }

                Task { [weak self] in
                    do {
                        try await Task.sleep(for: timeout)
                    } catch {
                        return
                    }
                    self?.finish(
                        id: id,
                        with: .failure(WaitError.timedOut(event))
                    )
                }
            }
        } onCancel: {
            cancel(id: id)
        }
    }

    func signal() {
        let pending = lock.withLock {
            isSignaled = true
            let pending = Array(waiters.values)
            waiters.removeAll()
            return pending
        }
        pending.forEach { $0.resume() }
    }

    private func cancel(id: UUID) {
        let waiter = lock.withLock {
            guard let waiter = waiters.removeValue(forKey: id) else {
                cancelledWaiterIDs.insert(id)
                return nil
            }
            return waiter
        }
        waiter?.resume(throwing: CancellationError())
    }

    private func finish(
        id: UUID,
        with result: Result<Void, any Error>
    ) {
        let waiter = lock.withLock {
            waiters.removeValue(forKey: id)
        }
        waiter?.resume(with: result)
    }
}
```

- [ ] **Step 5: Run the signal tests**

Run the same `xcodebuild test` command from Step 3.

Expected: all three `BoundedAsyncSignalTests` pass without continuation misuse warnings.

- [ ] **Step 6: Commit the reusable test helper**

Run:

```bash
git add \
  native/ios/PsycheCore/Tests/PsycheCoreTests/BoundedAsyncSignal.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/BoundedAsyncSignalTests.swift \
  native/ios/Psyche.xcodeproj/project.pbxproj
git commit -m "test(ios): add bounded async signal" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one commit containing the helper, its tests, and the generated project update.

### Task 3: Replace Unbounded Secure-Store Read Waiters

**Files:**
- Modify: `native/ios/PsycheCore/Tests/PsycheCoreTests/ConnectionManagerTests.swift`
- Modify: `native/ios/PsycheCore/Tests/PsycheCoreTests/PairedHostStoreTests.swift`

- [ ] **Step 1: Update all four read-gate call sites**

In `ConnectionManagerTests.swift`, replace each:

```swift
await secureStore.waitUntilReadBegins()
```

with:

```swift
try await secureStore.waitUntilReadBegins()
```

Do the same replacement in `PairedHostStoreTests.swift`.

- [ ] **Step 2: Replace `BlockingReadSecureStore` continuation storage**

In `ConnectionManagerTests.swift`, replace:

```swift
    private var readBegan = false
    private var readBeganWaiters: [CheckedContinuation<Void, Never>] = []
```

with:

```swift
    private let readBeganSignal = BoundedAsyncSignal()
```

Update `blockNextRead`:

```swift
    func blockNextRead() {
        readBeganSignal.reset()
        condition.withLock {
            shouldBlockNextRead = true
            readReleased = false
        }
    }
```

Replace `waitUntilReadBegins`:

```swift
    func waitUntilReadBegins() async throws {
        try await readBeganSignal.wait(for: "secure-store read")
    }
```

Replace the read-start notification inside `data(forKey:)`:

```swift
            shouldBlockNextRead = false
            condition.unlock()
            readBeganSignal.signal()
            condition.lock()
```

Keep the existing `while !readReleased` condition wait immediately after the new notification.

- [ ] **Step 3: Apply the same delegation to `SaveBoundarySecureStore`**

In `PairedHostStoreTests.swift`, make the same four changes:

1. replace `readBegan` and `readBeganWaiters` with `readBeganSignal`;
2. reset the signal in `blockNextRead`;
3. make `waitUntilReadBegins` `async throws`; and
4. call `readBeganSignal.signal()` after unlocking in `data(forKey:)`.

- [ ] **Step 4: Run focused secure-store race tests**

Run:

```bash
xcodebuild test \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath native/ios/.build-read-gate-hotfix \
  -only-testing:PsycheCoreTests/BoundedAsyncSignalTests \
  -only-testing:PsycheCoreTests/ConnectionManagerTests \
  -only-testing:PsycheCoreTests/PairedHostStoreTests
```

Expected: all selected tests pass and no test can wait longer than the helper's two-second default for a missing read-start event.

- [ ] **Step 5: Verify the generated project is current**

Run:

```bash
pnpm ios:project:check
```

Expected: the generated Xcode project and Info.plist have no uncommitted regeneration diff.

- [ ] **Step 6: Commit the read-gate migration**

Run:

```bash
git add \
  native/ios/PsycheCore/Tests/PsycheCoreTests/ConnectionManagerTests.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/PairedHostStoreTests.swift
git commit -m "test(ios): bound secure-store read gates" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: a second commit containing only the two secure-store test-double migrations.

### Task 4: Open, Review, and Merge the iOS Hotfix PR

**Files:**
- No additional repository files.

- [ ] **Step 1: Push the branch**

Run:

```bash
git push -u origin test/ios-bounded-read-gates
```

Expected: the branch is published without force pushing.

- [ ] **Step 2: Create the pull request**

Run:

```bash
gh pr create \
  --base main \
  --head test/ios-bounded-read-gates \
  --title "test(ios): bound secure-store read gates" \
  --body "$(cat <<'EOF'
## Summary
- add a cancellation-safe bounded async signal for iOS tests
- migrate secure-store read gates away from unbounded continuations
- fail missing read events within seconds instead of the CI job timeout

## Test Plan
- focused `BoundedAsyncSignalTests`
- focused `ConnectionManagerTests`
- focused `PairedHostStoreTests`
- `pnpm ios:project:check`
EOF
)"
```

Expected: GitHub returns the new PR URL.

- [ ] **Step 3: Run a fresh read-only code review**

Use the code-review agent against the final PR diff. Expected: no continuation leak, double-resume, cancellation race, or test-only concurrency finding.

- [ ] **Step 4: Wait for required checks**

Run:

```bash
gh pr checks --watch --fail-fast
```

Expected: required `TypeScript and Rust` and `iOS` checks pass.

- [ ] **Step 5: Merge with linear history**

Run:

```bash
gh pr merge --squash --delete-branch
```

Expected: the PR is merged into `main`; if branch protection refuses the merge, stop and report the unmet requirement instead of bypassing it.
