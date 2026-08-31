import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default {
  publicDir: resolve(packageRoot, '.psyche-dev-web/web'),
};
