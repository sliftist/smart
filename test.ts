import tsplinkconnect from "tp-link-tapo-connect";
import { lazy } from "socket-function/src/caching";
import * as fs from "fs";
import * as os from "os";
import { PlugFive, PlugOne, PlugSix, PlugThree } from "./plug";
import { delay } from "socket-function/src/batching";
import { getDevices, getThermostat, setHvacMode, setFanMode, setHeatingTemperature, setHeatingTemperatureFahrenheit, setHeatTemperatureHelper } from "./ac";
import { dailyCallback } from "./scheduler";

async function main() {
    // Test Seam API - get devices
    // const devices = await getDevices();
    // console.log("Seam devices:", JSON.stringify(devices, null, 2));

    // let hourFraction = new Date().getHours() + new Date().getMinutes() / 60;
    // if (hourFraction >= 2.5 && hourFraction < 10.5) {
    //     await setHeatTemperatureHelper(21.5);
    // } else {
    //     await setHeatTemperatureHelper(23.5);
    // }

    // dailyCallback(2.5, async () => {
    //     await setHeatTemperatureHelper(21.5);
    // });
    // dailyCallback(10.5, async () => {
    // });
    await setHeatTemperatureHelper(23.5);
}

main().catch(console.error).finally(() => process.exit());