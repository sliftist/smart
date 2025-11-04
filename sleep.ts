import { PlugTwo } from "./plug";
import { runPromise } from "socket-function/src/runPromise";
import { delay } from "socket-function/src/batching";

async function main() {
    await PlugTwo.setOn(false);
    await runPromise("rundll32.exe powrprof.dll,SetSuspendState 0,1,0");
}
main().catch(console.error).finally(() => process.exit(0));