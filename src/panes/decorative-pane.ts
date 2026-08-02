#!/usr/bin/env node

// Decorative pane renderer - displays ASCII art with animated falling binary characters
// This runs continuously without showing a command prompt

import { ASCII_ART as ASCII_ART_EXPORTS } from "../utils/asciiArt.js"
import {
  applyPsycheTheme,
  DECORATIVE_THEME,
  getActivePsycheTheme,
} from "../theme/colors.js"
import { normalizePsycheTheme } from "../theme/themePalette.js"
import { WELCOME_PANE_THEME_OPTION } from "../utils/welcomePane.js"
import { execSync } from "child_process"

// Parse the ASCII art string into an array of lines
const ASCII_ART = ASCII_ART_EXPORTS.psycheWelcome.trim().split("\n")

const FILL_CHAR = "·"
const DIM_GRAY = DECORATIVE_THEME.fill
const RESET = DECORATIVE_THEME.reset
const THEME_POLL_INTERVAL_MS = 120

// Static drop settings
const TAIL_LENGTH = 8 // Length of the fading tail
const NUM_STATIC_DROPS = 150 // Number of drops to render in static view

interface GridCell {
  char: string
  color: string
}

// Static drop - represents a frozen position of a falling column
interface StaticDrop {
  column: number
  y: number
  chars: string[]
}

/**
 * Generate random static drops that look like a paused animation
 */
function generateStaticDrops(width: number, height: number): StaticDrop[] {
  const drops: StaticDrop[] = []

  for (let i = 0; i < NUM_STATIC_DROPS; i++) {
    // Random column
    const column = Math.floor(Math.random() * width)

    // Random position in the screen (can be anywhere including partially visible)
    const y = Math.floor(Math.random() * (height + TAIL_LENGTH))

    // Random binary characters
    const chars = Array.from({ length: TAIL_LENGTH }, () =>
      Math.random() > 0.5 ? "1" : "0"
    )

    drops.push({ column, y, chars })
  }

  return drops
}

/**
 * Render static drops to a grid
 */
function renderStaticDrops(
  drops: StaticDrop[],
  grid: (GridCell | null)[][],
  height: number
): void {
  const shades = DECORATIVE_THEME.tail

  for (const drop of drops) {
    for (let i = 0; i < drop.chars.length; i++) {
      const row = Math.floor(drop.y - i)
      if (
        row >= 0 &&
        row < height &&
        drop.column >= 0 &&
        drop.column < grid[row].length
      ) {
        const shadeIndex = Math.min(i, shades.length - 1)
        grid[row][drop.column] = {
          char: drop.chars[i],
          color: shades[shadeIndex],
        }
      }
    }
  }
}

function render(width: number, height: number, drops: StaticDrop[]): void {
  // Create a grid for the background layer (falling characters)
  const backgroundGrid: (GridCell | null)[][] = Array.from(
    { length: height },
    () => Array.from({ length: width }, () => null)
  )

  // Render all drops to the background grid
  renderStaticDrops(drops, backgroundGrid, height)

  const artHeight = ASCII_ART.length
  const artWidth = Math.max(...ASCII_ART.map((line) => line.length))

  // Calculate vertical centering for ASCII art
  const topPadding = Math.floor((height - artHeight) / 2)

  const lines: string[] = []

  // Build each line by combining background and foreground
  for (let row = 0; row < height; row++) {
    const isArtRow = row >= topPadding && row < topPadding + artHeight
    const artLine = isArtRow ? ASCII_ART[row - topPadding] : null

    let line = ""

    for (let col = 0; col < width; col++) {
      if (isArtRow && artLine) {
        const trimmedArt = artLine.trimEnd()
        const leftPadding = Math.max(
          0,
          Math.floor((width - trimmedArt.length) / 2)
        )
        const artCol = col - leftPadding

        // If we're in the art region and the art has a character here
        if (artCol >= 0 && artCol < trimmedArt.length) {
          const artChar = trimmedArt[artCol]
          // ASCII art takes precedence - render in the active psyche accent
          line += DECORATIVE_THEME.primary + artChar + RESET
        } else {
          // Outside art region - show background or fill char
          const bg = backgroundGrid[row][col]
          if (bg) {
            line += bg.color + bg.char + RESET
          } else {
            line += DIM_GRAY + FILL_CHAR + RESET
          }
        }
      } else {
        // Not an art row - show background or fill char
        const bg = backgroundGrid[row][col]
        if (bg) {
          line += bg.color + bg.char + RESET
        } else {
          line += DIM_GRAY + FILL_CHAR + RESET
        }
      }
    }

    lines.push(line)
  }

  // Clear screen and render
  process.stdout.write("\x1b[2J\x1b[H") // Clear screen and home cursor
  process.stdout.write(lines.join("\n"))
}

function readThemeFromPaneOption(): string | undefined {
  const paneId = process.env.TMUX_PANE
  if (!paneId) {
    return undefined
  }

  try {
    const escapedPaneId = paneId.replace(/'/g, "'\\''")
    const value = execSync(
      `tmux show-options -p -v -t '${escapedPaneId}' ${WELCOME_PANE_THEME_OPTION}`,
      {
        encoding: "utf-8",
        stdio: "pipe",
      }
    ).trim()

    return value || undefined
  } catch {
    return undefined
  }
}

function syncThemeFromPaneOption(): boolean {
  const configuredTheme = readThemeFromPaneOption()
  if (!configuredTheme) {
    return false
  }

  const nextTheme = normalizePsycheTheme(configuredTheme)
  if (nextTheme === getActivePsycheTheme()) {
    return false
  }

  applyPsycheTheme(nextTheme)
  return true
}

let currentWidth = process.stdout.columns || 80
let currentHeight = process.stdout.rows || 24
let currentDrops = generateStaticDrops(currentWidth, currentHeight)

syncThemeFromPaneOption()
render(currentWidth, currentHeight, currentDrops)

// Re-render only on terminal resize (static, no animation)
process.stdout.on("resize", () => {
  currentWidth = process.stdout.columns || 80
  currentHeight = process.stdout.rows || 24
  currentDrops = generateStaticDrops(currentWidth, currentHeight)
  render(currentWidth, currentHeight, currentDrops)
})

const themePoll = setInterval(() => {
  if (syncThemeFromPaneOption()) {
    render(currentWidth, currentHeight, currentDrops)
  }
}, THEME_POLL_INTERVAL_MS)

// Keep the process running
process.stdin.resume()

// Handle Ctrl+C gracefully (though this pane will be killed by tmux)
process.on("SIGINT", () => {
  clearInterval(themePoll)
  process.exit(0)
})

process.on("SIGTERM", () => {
  clearInterval(themePoll)
  process.exit(0)
})
