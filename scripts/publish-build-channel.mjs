#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertBundleIdentity,
  channelConfig,
  installBundleTransactional,
  readBundleIdentity,
  validateBuildProvenance,
  writeBuildProvenance,
} from './build-macos-app.mjs';

const INPUT_KEYS = ['candidatePath', 'channelConfig', 'homeDir', 'provenance'];
const CHANNEL_CONFIG_KEYS = ['productName', 'bundleIdentifier', 'appName'];

export async function runPublishBuildChannelHelper(argv) {
  if (argv.length !== 1) {
    throw new Error(
      'publish-build-channel requires exactly one private input-file path',
    );
  }

  const inputPath = path.resolve(argv[0]);
  let input;

  try {
    input = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Invalid app publication input file at "${inputPath}": ${describeError(error)}`,
      { cause: error },
    );
  }

  validatePublicationInput(inputPath, input);

  const candidatePath = path.resolve(input.candidatePath);
  const homeDir = path.resolve(input.homeDir);
  const requestedChannelConfig = input.channelConfig;
  const provenance = input.provenance;
  const validateIdentity = async (appPath, expectedChannelConfig) => {
    const identity = await readBundleIdentity(appPath);
    assertBundleIdentity(appPath, identity, expectedChannelConfig);
  };

  await validateIdentity(candidatePath, requestedChannelConfig);
  const installedPath = await installBundleTransactional(
    candidatePath,
    requestedChannelConfig,
    {
      homeDir,
      validateInstalledBundle: validateIdentity,
    },
  );

  try {
    await writeBuildProvenance(provenance, { homeDir });
  } catch (error) {
    throw new Error(
      `App installed at "${installedPath}", but build provenance publication failed: ` +
        describeError(error),
      { cause: error },
    );
  }

  return installedPath;
}

function validatePublicationInput(inputPath, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidPublicationInput(inputPath, 'input must be an object');
  }

  const unknownInputKey = findUnknownKey(input, INPUT_KEYS);
  if (unknownInputKey) {
    throw invalidPublicationInput(
      inputPath,
      `input contains unknown field "${unknownInputKey}"`,
    );
  }
  for (const key of INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      throw invalidPublicationInput(inputPath, `input is missing field "${key}"`);
    }
  }

  if (typeof input.candidatePath !== 'string' || !path.isAbsolute(input.candidatePath)) {
    throw invalidPublicationInput(inputPath, 'candidatePath must be absolute');
  }
  if (typeof input.homeDir !== 'string' || !path.isAbsolute(input.homeDir)) {
    throw invalidPublicationInput(inputPath, 'homeDir must be absolute');
  }

  validateBuildProvenance(input.provenance);
  const expectedChannelConfig = channelConfig(input.provenance.channel);
  const unknownConfigKey = findUnknownKey(input.channelConfig, CHANNEL_CONFIG_KEYS);

  if (
    !input.channelConfig ||
    typeof input.channelConfig !== 'object' ||
    Array.isArray(input.channelConfig) ||
    unknownConfigKey ||
    input.channelConfig.productName !== expectedChannelConfig.productName ||
    input.channelConfig.bundleIdentifier !== expectedChannelConfig.bundleIdentifier ||
    input.channelConfig.appName !== expectedChannelConfig.appName
  ) {
    throw invalidPublicationInput(
      inputPath,
      'channelConfig must exactly match the provenance channel identity',
    );
  }

  const expectedInstalledPath = path.join(
    path.resolve(input.homeDir),
    'Applications',
    expectedChannelConfig.appName,
  );
  if (input.provenance.installedPath !== expectedInstalledPath) {
    throw invalidPublicationInput(
      inputPath,
      `provenance installedPath must equal "${expectedInstalledPath}"`,
    );
  }
}

function findUnknownKey(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const allowed = new Set(allowedKeys);
  return Object.keys(value).find((key) => !allowed.has(key));
}

function invalidPublicationInput(inputPath, detail) {
  return new Error(`Invalid app publication input file at "${inputPath}": ${detail}`);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isEntrypoint()) {
  try {
    const installedPath = await runPublishBuildChannelHelper(process.argv.slice(2));
    process.stdout.write(`${installedPath}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
