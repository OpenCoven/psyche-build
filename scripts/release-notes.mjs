#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_TESTFLIGHT_LENGTH = 4_000;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function versionEntries(changelog, version) {
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\] - ([^\\n]+)\\n`, 'gm');
  return [...changelog.matchAll(heading)].map((match) => ({
    date: match[1].trim(),
    start: match.index,
    contentStart: match.index + match[0].length,
  }));
}

function readTestFlight(entry) {
  const heading = /^### TestFlight: What to Test\s*\n/m.exec(entry);
  if (!heading || heading.index === undefined) {
    throw new Error('Release notes must include a TestFlight: What to Test section');
  }

  const sectionStart = heading.index + heading[0].length;
  const nextSection = entry.indexOf('\n### ', sectionStart);
  const testFlight = entry
    .slice(sectionStart, nextSection < 0 ? undefined : nextSection)
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
  if (testFlight.length > MAX_TESTFLIGHT_LENGTH) {
    throw new Error(`TestFlight release notes exceed ${MAX_TESTFLIGHT_LENGTH} characters`);
  }
  return testFlight;
}

export function readReleaseNotes(root, version) {
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const entries = versionEntries(changelog, version);
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one changelog entry for ${version}; found ${entries.length}`);
  }

  const [entry] = entries;
  if (/^unreleased$/i.test(entry.date)) {
    throw new Error(`Release notes for ${version} cannot be dated Unreleased`);
  }

  const nextHeading = changelog.indexOf('\n## ', entry.contentStart);
  const github = changelog.slice(entry.start, nextHeading < 0 ? undefined : nextHeading).trim();
  return { github, testFlight: readTestFlight(github) };
}

function main() {
  const [mode, version, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || !['--github', '--testflight'].includes(mode) || !version) {
    throw new Error('Usage: node scripts/release-notes.mjs --github VERSION | --testflight VERSION');
  }

  const notes = readReleaseNotes(process.cwd(), version);
  console.log(mode === '--github' ? notes.github : notes.testFlight);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
