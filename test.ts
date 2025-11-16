import tsplinkconnect from "tp-link-tapo-connect";
import { lazy } from "socket-function/src/caching";
import * as fs from "fs";
import * as os from "os";
import { PlugFive, PlugOne, PlugSix, PlugThree } from "./plug";
import { delay } from "socket-function/src/batching";

async function main() {
    await PlugThree.setOn(false);
}

main().catch(console.error).finally(() => process.exit(0));