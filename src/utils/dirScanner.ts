import fs from "fs"
import path from "path"
import os from "os"

export interface DirEntry {
  name: string
  fullPath: string
  isGitRepo: boolean
}

interface CacheEntry {
  entries: DirEntry[]
  timestamp: number
}

const CACHE_TTL_MS = 500
const MAX_ENTRIES = 50
// Entries live 500ms, so the cache only ever needs the handful of directories
// touched by the keystrokes in flight. Without a bound it retains the full
// DirEntry[] of every directory the user has ever typed through.
const MAX_CACHED_DIRS = 32
const dirCache = new Map<string, CacheEntry>()

/** Number of directories currently cached. Exposed for tests. */
export function dirCacheSize(): number {
  return dirCache.size
}

/** Empties the cache. Exposed for tests that need a clean slate. */
export function resetDirCache(): void {
  dirCache.clear()
}

/** Drops expired entries, then evicts oldest-first until the cache fits. */
function pruneCache(now: number): void {
  for (const [dir, entry] of dirCache) {
    if (now - entry.timestamp >= CACHE_TTL_MS) dirCache.delete(dir)
  }
  while (dirCache.size > MAX_CACHED_DIRS) {
    const oldest = dirCache.keys().next().value
    if (oldest === undefined) break
    dirCache.delete(oldest)
  }
}

/**
 * Expand ~ to the user's home directory
 */
export function expandTilde(inputPath: string): string {
  if (inputPath === "~") return os.homedir()
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2))
  }
  return inputPath
}

/**
 * Split user input into parentDir + prefix for filtering.
 *
 * Examples:
 *   "~/pro"        → { parentDir: "/Users/x", prefix: "pro" }
 *   "~/projects/"  → { parentDir: "/Users/x/projects", prefix: "" }
 *   "/tmp"         → { parentDir: "/", prefix: "tmp" }
 *   "/tmp/"        → { parentDir: "/tmp", prefix: "" }
 *   ""             → { parentDir: homedir, prefix: "" }
 */
export function parsePathInput(input: string): {
  parentDir: string
  prefix: string
} {
  if (!input) {
    return { parentDir: os.homedir(), prefix: "" }
  }

  const expanded = expandTilde(input)

  // If it ends with /, the parent is the full path, prefix is empty
  if (expanded.endsWith("/")) {
    return { parentDir: expanded.slice(0, -1) || "/", prefix: "" }
  }

  return {
    parentDir: path.dirname(expanded),
    prefix: path.basename(expanded),
  }
}

/**
 * Scan a directory for subdirectories, optionally filtering by prefix.
 * Results are cached by parentDir for 500ms.
 * Returns max 50 entries, sorted: git repos first, then alphabetical.
 */
export function scanDirectories(
  parentDir: string,
  prefix: string
): DirEntry[] {
  // Check cache
  const cached = dirCache.get(parentDir)
  const now = Date.now()
  let allEntries: DirEntry[]

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    allEntries = cached.entries
  } else {
    allEntries = readDirectoryEntries(parentDir)
    // Re-insert so Map iteration order stays youngest-last and eviction below
    // is genuinely oldest-first.
    dirCache.delete(parentDir)
    dirCache.set(parentDir, { entries: allEntries, timestamp: now })
    pruneCache(now)
  }

  // Filter by prefix (case-insensitive)
  const lowerPrefix = prefix.toLowerCase()
  const filtered = lowerPrefix
    ? allEntries.filter((e) => e.name.toLowerCase().startsWith(lowerPrefix))
    : allEntries

  // Sort: git repos first, then alphabetical
  filtered.sort((a, b) => {
    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return filtered.slice(0, MAX_ENTRIES)
}

function readDirectoryEntries(parentDir: string): DirEntry[] {
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true })
    const dirs: DirEntry[] = []

    for (const entry of entries) {
      // Skip hidden dirs unless we explicitly want them (handled by prefix filter)
      if (entry.name.startsWith(".")) continue
      if (!entry.isDirectory()) continue

      const fullPath = path.join(parentDir, entry.name)
      let isGitRepo = false
      try {
        isGitRepo = fs.existsSync(path.join(fullPath, ".git"))
      } catch {
        // Permission denied or similar — skip git check
      }

      dirs.push({ name: entry.name, fullPath, isGitRepo })
    }

    return dirs
  } catch {
    // Directory doesn't exist or permission denied
    return []
  }
}
