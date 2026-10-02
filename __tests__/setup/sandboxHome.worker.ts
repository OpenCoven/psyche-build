import os from 'node:os';

/**
 * Runs in each worker before every test file's imports.
 *
 * The global setup points HOME at a throwaway directory. A test file that
 * reassigns HOME and does not restore it would otherwise hand the next file in
 * the same worker a different home, so reset it here, then refuse to run if
 * the home directory still resolves to the developer's real one.
 */
const sandboxHome = process.env.PSYCHE_TEST_HOME;
const realHome = process.env.PSYCHE_REAL_HOME;

if (!sandboxHome || !realHome) {
  throw new Error('refusing to run: the sandboxed test home was not set up');
}

process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

if (os.homedir() !== sandboxHome || os.homedir() === realHome) {
  throw new Error('refusing to run: the home directory resolves outside the test sandbox');
}
