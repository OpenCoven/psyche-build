// Native rollback reader. Only the caller's original Build IDs and native journal are needed.
import { observe, openNative } from './native.mts';
const [taskId, actionId] = process.argv.slice(2);
console.log(JSON.stringify(observe(await openNative(3), taskId, actionId)));
