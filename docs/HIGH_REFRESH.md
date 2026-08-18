# High-refresh rendering

Psyche Build schedules browser work with `requestAnimationFrame`. It does not
force a refresh rate. The status panel reports both the observed frames per
second and the measured `requestAnimationFrame` cadence; the latter is used to
count missed presentation slots. A `240 Hz` cadence in diagnostics is evidence
that the WebView delivered callbacks at that rate, not a claim that the display
is configured to 240 Hz.

## Terminal output cadence

`requestAnimationFrame` is not the only thing pacing a terminal pane. Native PTY
output is batched by the Rust pump in `src-tauri/src/pty_transport.rs`, and until
recently a visible pane held a fixed `16 ms` floor between batches — a hard
62.5 Hz ceiling on terminal content regardless of the display or the reported rAF
cadence. A visible pane is now paced by acknowledgement credit instead: up to
`MAX_IN_FLIGHT` batches may be outstanding, and the next one leaves as soon as
the client acknowledges. Hidden panes keep their `100 ms` floor, because trading
latency for idle CPU is the right bargain for a pane nobody is looking at.

The remaining per-batch cost is the client's own round trip — one frame plus the
`pty_ack` IPC — so a measured rAF cadence still over-reports what the terminals
achieve.

## Platform boundary

- **Windows:** Tauri uses WebView2 (Chromium). Psyche Build follows the active
  display and WebView policy. Set the display to its supported high-refresh mode
  in Windows, then verify the measured rAF cadence in Psyche Build.
- **macOS:** Tauri's desktop UI uses WKWebView. Native macOS integration can
  request high-refresh WebView handling (the complementary #121 covers that
  WKWebView-specific work), but the display, power policy, and WebKit make the
  final decision. A native Apple frame-rate preference or display link may
  improve native rendering; it cannot force JavaScript `requestAnimationFrame`
  callbacks above the cadence WebKit delivers.
- **iOS:** The standalone Swift app uses Core Animation rather than the Tauri
  desktop WebView stack. ProMotion is a system capability rather than a 240 Hz
  guarantee. Swift's `preferredFrameRateRange` is a native rendering preference
  to measure on-device; it would not force callbacks for any WKWebView
  JavaScript content.
- **Linux (including WSLg):** Tauri uses WebKitGTK. The compositor can be
  configured independently, but that does not force WebKitGTK's JavaScript
  animation cadence. WSLg documents 60 and 144 as supported monitor-refresh
  configuration values, so a 240 Hz guarantee is outside the current stack.

Achieving a guaranteed 240 Hz JavaScript UI on every desktop OS would require a
different Linux renderer architecture, not a Tauri configuration flag. Do not
add timer loops to bypass `requestAnimationFrame`: they draw out of phase with
presentation and make the reported FPS less trustworthy.

## Verification

1. Use a display whose current mode supports the intended refresh rate.
2. Open **Performance** and observe both `Frame rate` and `rAF ... Hz` during
   active rendering.
3. Use **Copy diagnostics** when reporting a result; it includes the measured
   rAF cadence without collecting terminal or project contents.
