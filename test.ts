import tsplinkconnect from "tp-link-tapo-connect";
import { lazy } from "socket-function/src/caching";
import * as fs from "fs";
import * as os from "os";
import { getPlugCreds, PlugEight, PlugFive, PlugOne, PlugSeven, PlugSix, PlugThree, PlugTwo } from "./plug";
import { delay } from "socket-function/src/batching";
import { getDevices, getThermostat, setHvacMode, setFanMode, setHeatingTemperature, setHeatingTemperatureFahrenheit } from "./ac";
import { dailyCallback } from "./scheduler";
import { formatNiceDateTime, formatTime } from "socket-function/src/formatting/format";
import { spawn } from "child_process";

const HUMIDITY_SENSOR_ID = 248;
const REMOTE_HOST = "10.0.0.119";
const REMOTE_LOGS_DIR = "smart/logs";
const REMOTE_FILES_TO_SEARCH = 4;

function runRemote(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let child = spawn("ssh", ["-o", "BatchMode=yes", REMOTE_HOST, command], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data: Buffer) => {
            stdout += data.toString("utf8");
        });
        child.stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf8");
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code !== 0 && !stdout) {
                reject(new Error(`ssh ${REMOTE_HOST} "${command}" exited with code ${code}: ${stderr}`));
                return;
            }
            resolve(stdout);
        });
    });
}

async function readRemoteSensor(sensorId: number): Promise<{ time: string; humidity: number; temperature_C: number } | undefined> {
    let output = await runRemote(`cd ${REMOTE_LOGS_DIR} && grep -h '"id" : ${sensorId},' $(ls -t | head -n ${REMOTE_FILES_TO_SEARCH}) | sort | tail -n 1`);
    let line = output.trim();
    if (!line) return undefined;
    let reading: { id: number; time: string; humidity?: number; temperature_C: number } = JSON.parse(line);
    if (typeof reading.humidity !== "number") return undefined;
    return { time: reading.time, humidity: reading.humidity, temperature_C: reading.temperature_C };
}

async function main() {
    // let info = await getThermostat();
    // console.log(info.properties);

    let reading = await readRemoteSensor(HUMIDITY_SENSOR_ID);
    if (!reading) {
        console.log(`No humidity reading for sensor ${HUMIDITY_SENSOR_ID} in the newest ${REMOTE_FILES_TO_SEARCH} log files on ${REMOTE_HOST}`);
    } else {
        let time = +new Date(reading.time);
        console.log(`Sensor ${HUMIDITY_SENSOR_ID} humidity ${reading.humidity}% (${reading.temperature_C}C) at ${formatNiceDateTime(time)}, ${formatTime(Date.now() - time)} ago`);
    }

    // let plugInfo = await PlugOne.getInfo();
    // console.log(plugInfo);
    // let plug8 = await PlugEight.getEnergyData();
    // console.log(plug8);
    //await PlugSeven.setOn(false);
    // let energyData = await PlugTwo.getEnergyData();
    // console.log(energyData);
    // // Test Seam API - get devices
    // const devices = await getDevices();
    // console.log("Seam devices:", JSON.stringify(devices, null, 2));

    // // let hourFraction = new Date().getHours() + new Date().getMinutes() / 60;
    // // if (hourFraction >= 2.5 && hourFraction < 10.5) {
    // //     await setHeatTemperatureHelper(21.5);
    // // } else {
    // //     await setHeatTemperatureHelper(23.5);
    // // }

    // // dailyCallback(2.5, async () => {
    // //     await setHeatTemperatureHelper(21.5);
    // // });
    // // dailyCallback(10.5, async () => {
    // // });
    // await setHeatTemperatureHelper(23.5);
}

main().catch(console.error).finally(() => process.exit());