import tsplinkconnect from "tp-link-tapo-connect";
import { lazy } from "socket-function/src/caching";
import * as fs from "fs";
import * as os from "os";
import { PlugOne } from "./plug";

async function main() {
    await PlugOne.setOn(true);
}

main().catch(console.error).finally(() => process.exit(0));