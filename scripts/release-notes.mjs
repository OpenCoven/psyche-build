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
  const headings = [...entry.matchAll(/^### TestFlight: What to Test[ \t]*\r?$/gm)];
  if (headings.length !== 1) {
    throw new Error(
      `Expected exactly one TestFlight: What to Test section; found ${headings.length}`,
    );
  }

  const [heading] = headings;
  const sectionStart = heading.index + heading[0].length;
  const peerHeading = /^### [^\r\n]+[ \t]*\r?$/gm;
  peerHeading.lastIndex = sectionStart;
  const nextSection = peerHeading.exec(entry);
  const testFlight = entry
    .slice(sectionStart, nextSection?.index)
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
  if (!testFlight) {
    throw new Error('TestFlight: What to Test section cannot be empty');
  }
  if (testFlight.length > MAX_TESTFLIGHT_LENGTH) {
    throw new Error(`TestFlight release notes exceed ${MAX_TESTFLIGHT_LENGTH} characters`);
  }
  return testFlight;
}

function assertValidReleaseDate(date, version) {
  if (/^unreleased$/i.test(date)) {
    throw new Error(`Release notes for ${version} cannot be dated Unreleased`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Release date for ${version} must use YYYY-MM-DD; received "${date}"`);
  }

  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Release date for ${version} is not a valid calendar date: "${date}"`);
  }
}

export function readReleaseNotes(root, version) {
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const entries = versionEntries(changelog, version);
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one changelog entry for ${version}; found ${entries.length}`);
  }

  const [entry] = entries;
  assertValidReleaseDate(entry.date, version);

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
  if (mode === '--github') {
    console.log(notes.github);
  } else {
    process.stdout.write(notes.testFlight);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
