# frozen_string_literal: true

cask "psyche-build" do
  arch arm: "aarch64", intel: "x86_64"

  version "0.0.2"
  sha256 arm:   "dac0f653e00172e08c7d26f9fb19d7ccbc30af304ac3ed42f6dda91937cc8103",
         intel: "f9e19a77d0d7bc746226fa510bf3e34e5d96185e6563e53bb1898f0d9423033e"

  url "https://github.com/OpenCoven/psyche-build/releases/download/v#{version}/Psyche-Build-v#{version}-#{arch}.dmg"
  name "Psyche Build"
  desc "Multiagent coding harness for parallel agent lanes"
  homepage "https://github.com/OpenCoven/psyche-build"

  depends_on macos: :monterey

  app "Psyche Build.app"

  zap trash: [
    "~/Library/Application Support/dev.opencoven.psyche",
    "~/Library/Caches/dev.opencoven.psyche",
    "~/Library/Preferences/dev.opencoven.psyche.plist",
    "~/Library/Saved Application State/dev.opencoven.psyche.savedState",
    "~/Library/WebKit/dev.opencoven.psyche",
  ]
end
