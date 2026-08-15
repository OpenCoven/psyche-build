# High-refresh rendering

Psyche Build schedules browser work with `requestAnimationFrame`. It does not
force a refresh rate. The status panel reports both the observed frames per
second and the measured `requestAnimationFrame` cadence; the latter is used to
count missed presentation slots. A `240 Hz` cadence in diagnostics is evidence
that the WebView delivered callbacks at that rate, not a claim that the display
is configured to 240 Hz.

## Platform boundary

- **Windows:** Tauri uses WebView2 (Chromium). Psyche Build follows the active
  display and WebView policy. Set the display to its supported high-refresh mode
  in Windows, then verify the measured rAF cadence in Psyche Build.
- **macOS:** Tauri uses WKWebView. A macOS native integration can request the
  best available frame pacing, but the display, power policy, and WebKit still
  make the final decision. A Swift or Objective-C display link can improve
  native Apple rendering, but cannot force WebKit JavaScript callbacks above
  the rate it provides.
- **iOS:** The standalone Swift app follows Core Animation and device policy.
  ProMotion is a system capability rather than a 240 Hz guarantee. If the app
  adds a display-linked visual workload, use `preferredFrameRateRange` as a
  hint and measure the result on-device.
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
