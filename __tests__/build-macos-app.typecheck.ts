import { channelConfig, installBundleTransactional } from '../scripts/build-macos-app.mjs';

const candidate = '/Applications/Psyche Build Dev.app';
const devChannel = channelConfig('dev');

void installBundleTransactional(candidate, devChannel, {
  validateInstalledBundle: async () => {},
});

// @ts-expect-error install overrides are required
void installBundleTransactional(candidate, devChannel);

// @ts-expect-error validateInstalledBundle is required
void installBundleTransactional(candidate, devChannel, {});
