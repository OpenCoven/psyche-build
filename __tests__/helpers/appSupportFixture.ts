import { createAppSupportBundle as create, type AppSupportRequest } from '../../src/diagnostics/supportBundleApp.js';
import { writeSupportBundleFile, supportBundleDirectory, type NativeSupportStoreRequest } from '../../src/diagnostics/supportBundleStore.js';

// Unit fixtures exercise v1 policy with real temporary files. Native tests
// exercise the production descriptor backend and directory-replacement races.
export function fixtureStore(root: string) {
  return (request: NativeSupportStoreRequest, signal?: AbortSignal) => writeSupportBundleFile({
    directory: supportBundleDirectory(root), filename: request.filename, serialized: request.serialized,
    maxRetained: request.maxRetained, signal,
  });
}
export function createAppSupportBundle(request: AppSupportRequest, signal?: AbortSignal) {
  return create(request, signal, fixtureStore(request.projectRoot));
}
