import { configure, autorun, observable } from "mobx";
import { formatNiceDateTime, formatTime, formatVeryNiceDateTime } from "socket-function/src/formatting/format";
import { linesToObjects, objectsToObservable, watchDirectory, watchFile } from "./logWatcher";
import { PlugNine, PlugOne } from "./plug";
import { timeInMinute } from "socket-function/src/misc";
import { getThermostat, setHeatingTemperature, setCoolingTemperature, setThermostatOff } from "./ac";
import { dailyCallback } from "./scheduler";
import { runInfinitePoll, runInfinitePollCallAtStart } from "socket-function/src/batching";
import { WebSocketServer, WebSocket } from "ws";

/*
24 outside
154 beside outside door
225 bathroom
248 microwave
132 beside computer
211 bedroom window
*/

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection:", reason);
    console.error("Promise:", promise);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

const BUILDING_MODE = "heating" as "heating" | "cooling";

const HUMIDITY_ID = "132";
const HUMIDITY = 45;
const THROTTLE_TIME = timeInMinute * 2;
const MAX_DATA_AGE = timeInMinute * 5;
const MAX_TIME_NO_DATA = timeInMinute * 10;
const PLUG = PlugOne;

const THERMOSTAT_ID = "ecobee";
const THERMOSTAT_SENSOR = "154";
const THERMOSTAT_FORCE_OFFSET = 1.5;

const COOLING_SET_POINT_MIN = 18.5;

const HEATING_SET_POINT_MAX = 25;

const THERMAL_LIMIT_ID = "173";
const THERMAL_LIMIT = 25;

const OUR_THERMOSTAT_ID = "better_ecobee";

// TODO: Maybe change this to use the observable system, so we can respond immediately? Hmm...
const TEMPERATURE_POLL_RATE = timeInMinute * 2.5;

const SUPER_COOLING_PLUG = PlugNine;
const SUPER_COOLING_TEMPERATURE_THRESHOLD = 3;
const OUTSIDE_SENSOR = "24";
const SUPER_COOLING_OUTSIDE_THRESHOLD = 2;

// TODO: Adjust the temperature targets slightly based on outside temperatures.
let TEMPERATURE_PLAN = [
    { time: 0, temperature: 20 },
    { time: 9.5, temperature: 20 },
    { time: 12.5, temperature: 20 },
];


configure({
    enforceActions: "never",
    reactionScheduler(callback) {
        setTimeout(() => {
            callback();
        }, 1000);
    }
});

type Datum = {
    id: string;
    time: string;
    temperature_C: number;
    humidity: number;
} | {
    id: string;
    type: "plug";
    on: boolean;
    time: string;
};

let allData = observable({

} as Record<string, Datum>);

const STATUS_PORT = 8090;
const STATUS_BROADCAST_INTERVAL = 2000;

type ThermostatInfo = Awaited<ReturnType<typeof getThermostat>>;

let controlState: {
    humidifierOn?: boolean;
    humidifierReason?: string;
    thermostat?: ThermostatInfo["properties"];
    thermostatTime?: number;
    targetTemperature?: number;
    controlTemperature?: number;
    controlTemperatureSource?: string;
    hvacOn?: boolean;
    hvacReason?: string;
    hvacTime?: number;
    setPointKind?: "heating" | "cooling";
    setPoint?: number;
    setPointTime?: number;
    superCooling?: boolean;
    superCoolingReason?: string;
} = {};

function getSensorStatus(id: string, role: string) {
    let datum = allData[id];
    if (!datum || !("temperature_C" in datum)) {
        return { id, role };
    }
    return {
        id,
        role,
        temperature_C: datum.temperature_C,
        humidity: datum.humidity,
        time: +new Date(datum.time),
    };
}

function buildStatus() {
    return {
        buildingMode: BUILDING_MODE,
        maxDataAge: MAX_DATA_AGE,
        humidityTarget: HUMIDITY,
        thermalLimit: THERMAL_LIMIT,
        superCoolingTemperatureThreshold: SUPER_COOLING_TEMPERATURE_THRESHOLD,
        superCoolingOutsideThreshold: SUPER_COOLING_OUTSIDE_THRESHOLD,
        temperaturePlan: TEMPERATURE_PLAN,
        sensors: [
            getSensorStatus(THERMOSTAT_SENSOR, "room (control)"),
            getSensorStatus(OUTSIDE_SENSOR, "outside"),
            getSensorStatus(THERMAL_LIMIT_ID, "thermal limit"),
            getSensorStatus(HUMIDITY_ID, "humidity"),
        ],
        control: controlState,
    };
}

function startStatusServer() {
    let server = new WebSocketServer({ host: "0.0.0.0", port: STATUS_PORT });
    server.on("listening", () => {
        console.log(`[pid ${process.pid}] Status WebSocket server listening on ws://0.0.0.0:${STATUS_PORT} at ${formatNiceDateTime(Date.now())}`);
    });
    server.on("error", (error) => {
        console.error(`[pid ${process.pid}] Status WebSocket server error on port ${STATUS_PORT}:`, error.stack ?? error);
    });
    server.on("connection", (socket, request) => {
        let remote = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
        console.log(`[pid ${process.pid}] Status client connected from ${remote} at ${formatNiceDateTime(Date.now())}, ${server.clients.size} clients connected`);
        socket.send(JSON.stringify(buildStatus()));
        socket.on("close", () => {
            console.log(`[pid ${process.pid}] Status client disconnected from ${remote} at ${formatNiceDateTime(Date.now())}, ${server.clients.size} clients connected`);
        });
        socket.on("error", (error) => {
            console.error(`[pid ${process.pid}] Status client error from ${remote}:`, error.stack ?? error);
        });
    });
    let lastSent = "";
    setInterval(() => {
        let message = JSON.stringify(buildStatus());
        if (message === lastSent) return;
        lastSent = message;
        for (let client of server.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    }, STATUS_BROADCAST_INTERVAL);
}

async function main() {
    startStatusServer();
    function iterateForked<T>(iterable: AsyncIterable<T>, handler: (item: T) => void) {
        void (async () => {
            for await (const item of iterable) {
                void (async () => {
                    handler(item);
                })();
            }
        })();
    }
    iterateForked(watchDirectory("logs"), (file) => {
        objectsToObservable(
            linesToObjects(watchFile(file)),
            allData,
            (object) => object.id,
            (object) => {
                let objT = object as Datum;
                return +new Date(objT.time);
            }
        );
    });
    function getHumidity(): number | undefined {
        let humidity = allData[HUMIDITY_ID];
        if (humidity && "humidity" in humidity) {
            let timeOff = Math.abs(new Date(humidity.time).getTime() - Date.now());
            if (timeOff > MAX_DATA_AGE) {
                console.warn(`Humidity data is too old for ${HUMIDITY_ID}. Now is ${formatNiceDateTime(Date.now())}, and the humidity was at ${formatNiceDateTime(+new Date(humidity.time))}, so it is ${formatTime(timeOff)} off`);
                return undefined;
            }
            return humidity.humidity;
        }
        return undefined;
    }
    let isPlugOn = await PLUG.getOn();
    controlState.humidifierOn = isPlugOn;
    let paused = observable({ value: false });
    function changePlugState(on: boolean, reason: string) {
        isPlugOn = on;
        controlState.humidifierOn = on;
        controlState.humidifierReason = reason;
        paused.value = true;
        if (on) {
            void PLUG.setOn(true);
        } else {
            void PLUG.setOn(false);
        }
        setTimeout(() => {
            paused.value = false;
        }, THROTTLE_TIME);
    }

    let humidityCountdown = observable({ value: 0 });
    setInterval(() => {
        humidityCountdown.value += timeInMinute;
    }, timeInMinute);

    autorun(() => {
        if (paused.value) return;
        console.log(`Running autorun at ${formatNiceDateTime(Date.now())}`);

        let humidity = getHumidity();
        if (!humidity) {
            console.log(`No humidity data at ${formatNiceDateTime(Date.now())}`);
            if (humidityCountdown.value > MAX_TIME_NO_DATA && isPlugOn) {
                console.log(`No humidity data too long (${formatTime(humidityCountdown.value)}), turning off the plug`);
                changePlugState(false, `No humidity data for ${formatTime(humidityCountdown.value)}`);
            }
            return;
        }
        humidityCountdown.value = 0;
        if (humidity <= HUMIDITY) {
            console.log(`Turning on humidifier for #${HUMIDITY_ID} due to humidity being too low ${humidity} <= ${HUMIDITY} at ${formatNiceDateTime(Date.now())}`);
            changePlugState(true, `Humidity ${humidity} <= ${HUMIDITY}`);
        } else if (humidity > HUMIDITY) {
            console.log(`Turning off humidifier for #${HUMIDITY_ID} due to humidity being too high ${humidity} > ${HUMIDITY} at ${formatNiceDateTime(Date.now())}`);
            changePlugState(false, `Humidity ${humidity} > ${HUMIDITY}`);
        } else {
            console.log(`Humidity is equal to target ${humidity} for #${HUMIDITY_ID} (${HUMIDITY}) at ${formatNiceDateTime(Date.now())}`);
        }
    });

    // TODO: Set temperature based on other probe, using json logging so we can chart the target, set, and actual temperatures.
    //  - Also might as well read the temperature from the ecobee, so we can determine if it is an offset, or it is just wrong...
    // Cold at night, warm up during the day.
    {
        void runInfinitePollCallAtStart(timeInMinute, async () => {
            let info = await getThermostat();
            controlState.thermostat = info.properties;
            controlState.thermostatTime = Date.now();
            console.log(JSON.stringify({
                id: THERMOSTAT_ID,
                time: Date.now(),
                is_cooling: info.properties.is_cooling,
                is_heating: info.properties.is_heating,
                is_fan_running: info.properties.is_fan_running,
                temperature_celsius: info.properties.temperature_celsius,
                temperature_fahrenheit: info.properties.temperature_fahrenheit,
                heating_set_point_celsius: info.properties.current_climate_setting.heating_set_point_celsius,
                heating_set_point_fahrenheit: info.properties.current_climate_setting.heating_set_point_fahrenheit,
                cooling_set_point_celsius: info.properties.current_climate_setting.cooling_set_point_celsius || 0,
                cooling_set_point_fahrenheit: info.properties.current_climate_setting.cooling_set_point_fahrenheit || 0,
                hvac_mode_setting: info.properties.current_climate_setting.hvac_mode_setting,
                fan_mode_setting: info.properties.current_climate_setting.fan_mode_setting,
            }));
        });

        // Convert sets to ranges with wrap-around support
        function setsToRanges(sets: Array<{ time: number, temperature: number }>) {
            let sortedSets = [...sets].sort((a, b) => a.time - b.time);
            let ranges: Array<{ start: number, end: number, temperature: number }> = [];

            for (let i = 0; i < sortedSets.length - 1; i++) {
                let start = sortedSets[i].time;
                let end = sortedSets[i + 1].time;
                let temperature = sortedSets[i].temperature;
                ranges.push({ start, end, temperature });
            }

            let last = sortedSets[sortedSets.length - 1];
            ranges.push({ start: last.time, end: last.time + 24, temperature: last.temperature });
            ranges.push({ start: 0, end: last.time, temperature: last.temperature });

            return ranges;
        }

        // Helper to determine current temperature based on sets
        function getCurrentTemperatureFromSets(sets: Array<{ time: number, temperature: number }>) {
            let ranges = setsToRanges(sets);
            let hourFraction = new Date().getHours() + new Date().getMinutes() / 60;

            // Find which range we're in
            for (let range of ranges) {
                if (range.start <= hourFraction && hourFraction < range.end) {
                    return range.temperature;
                }
            }

            // Should never reach here, but default to first temperature
            return sets[0].temperature;
        }

        function readSensorTemperature(id: string, label: string): { temperature: number } | { error: string } {
            let datum = allData[id];
            if (!datum) {
                return { error: `No reading from ${label} sensor ${id} since startup` };
            }
            if (!("temperature_C" in datum)) {
                return { error: `Last message from ${label} sensor ${id} at ${formatNiceDateTime(+new Date(datum.time))} has no temperature_C` };
            }
            let timeOff = Math.abs(new Date(datum.time).getTime() - Date.now());
            if (timeOff > MAX_DATA_AGE) {
                let error = `Last reading from ${label} sensor ${id} was at ${formatNiceDateTime(+new Date(datum.time))}, ${formatTime(timeOff)} ago, older than the max of ${formatTime(MAX_DATA_AGE)}`;
                console.warn(`${error}. Now is ${formatNiceDateTime(Date.now())}`);
                return { error };
            }
            return { temperature: datum.temperature_C };
        }
        function getThermalLimitProbe(): number | undefined {
            let reading = readSensorTemperature(THERMAL_LIMIT_ID, "thermal limit");
            return "temperature" in reading ? reading.temperature : undefined;
        }

        function recordHvac(on: boolean | undefined, reason: string) {
            if (on !== undefined) {
                controlState.hvacOn = on;
            }
            controlState.hvacReason = reason;
            controlState.hvacTime = Date.now();
        }
        function recordSetPoint(kind: "heating" | "cooling", setPoint: number) {
            controlState.setPointKind = kind;
            controlState.setPoint = setPoint;
            controlState.setPointTime = Date.now();
        }
        function recordControlTemperature(temperature: number, source: string, target: number) {
            controlState.controlTemperature = temperature;
            controlState.controlTemperatureSource = source;
            controlState.targetTemperature = target;
        }

        async function turnThermostatOff(info: ThermostatInfo) {
            let previousMode = info.properties.current_climate_setting.hvac_mode_setting;
            if (previousMode === "off") return;
            console.log(`[pid ${process.pid}] Turning thermostat off (was ${previousMode}, room ${info.properties.temperature_celsius}C on the ecobee) at ${formatNiceDateTime(Date.now())}`);
            await setThermostatOff();
        }

        async function heatingHandler() {
            let info = await getThermostat();
            async function setHeatingOn() {
                let thermalLimit = getThermalLimitProbe();
                if (thermalLimit !== undefined && thermalLimit >= THERMAL_LIMIT) {
                    console.log(`Thermal limit hit ${thermalLimit} >= ${THERMAL_LIMIT} at ${formatNiceDateTime(Date.now())}. Ignoring heating request, and ensuring heat is off`);
                    recordHvac(false, `Thermal limit ${thermalLimit} >= ${THERMAL_LIMIT}`);
                    await setHeatingOff();
                    return;
                }
                let curTemp = info.properties.temperature_celsius;
                curTemp += THERMOSTAT_FORCE_OFFSET;
                if (curTemp > HEATING_SET_POINT_MAX) {
                    console.warn(`Tried to set heating set point too high (${curTemp}C), limiting to ${HEATING_SET_POINT_MAX}C`);
                    curTemp = HEATING_SET_POINT_MAX;
                }
                await setHeatingTemperature(curTemp);
                recordSetPoint("heating", curTemp);
            }
            async function setHeatingOff() {
                await turnThermostatOff(info);
            }
            async function setSuperCooling(status: boolean, reason: string) {
                console.log(JSON.stringify({ id: OUR_THERMOSTAT_ID, time: Date.now(), super_cooling: status }));
                await SUPER_COOLING_PLUG.setOn(status);
                controlState.superCooling = status;
                controlState.superCoolingReason = reason;
            }
            let roomReading = readSensorTemperature(THERMOSTAT_SENSOR, "room");
            if ("error" in roomReading) {
                recordHvac(undefined, roomReading.error);
                await setSuperCooling(false, roomReading.error);
                return;
            }
            let realTemperature = roomReading.temperature;

            let targetTemperature = getCurrentTemperatureFromSets(TEMPERATURE_PLAN);
            recordControlTemperature(realTemperature, THERMOSTAT_SENSOR, targetTemperature);

            if (realTemperature === targetTemperature) {
                console.log(`Temperature is equal to target ${realTemperature} at ${formatNiceDateTime(Date.now())}. Not touching state`);
                recordHvac(undefined, `Room ${realTemperature} == target ${targetTemperature}, leaving as is`);
                await setSuperCooling(false, `Room ${realTemperature} == target ${targetTemperature}`);
            } else if (realTemperature < targetTemperature) {
                console.log(`Turning on heating for due to temperature being too low ${realTemperature} < ${targetTemperature} at ${formatNiceDateTime(Date.now())}`);
                recordHvac(true, `Room ${realTemperature} < target ${targetTemperature}`);
                await setHeatingOn();
                await setSuperCooling(false, `Room ${realTemperature} < target ${targetTemperature}`);
                console.log(JSON.stringify({ id: OUR_THERMOSTAT_ID, time: Date.now(), temperature_celsius: realTemperature, heating_set_point_celsius: targetTemperature, is_heating: true }));
            } else if (realTemperature > targetTemperature) {
                console.log(`Turning off heating for due to temperature being too high ${realTemperature} > ${targetTemperature} at ${formatNiceDateTime(Date.now())}`);
                recordHvac(false, `Room ${realTemperature} > target ${targetTemperature}`);
                await setHeatingOff();
                console.log(JSON.stringify({ id: OUR_THERMOSTAT_ID, time: Date.now(), temperature_celsius: realTemperature, heating_set_point_celsius: targetTemperature, is_heating: false }));
                if (realTemperature > targetTemperature + SUPER_COOLING_TEMPERATURE_THRESHOLD) {
                    let outsideReading = readSensorTemperature(OUTSIDE_SENSOR, "outside");
                    if ("error" in outsideReading) {
                        console.warn(`Not super cooling despite temperature ${realTemperature} > ${targetTemperature} + ${SUPER_COOLING_TEMPERATURE_THRESHOLD}, because: ${outsideReading.error}, at ${formatNiceDateTime(Date.now())}`);
                        await setSuperCooling(false, `Room ${realTemperature} > ${targetTemperature} + ${SUPER_COOLING_TEMPERATURE_THRESHOLD}, but: ${outsideReading.error}`);
                        return;
                    }
                    let outsideTemperature = outsideReading.temperature;
                    let outsideReference = Math.max(targetTemperature, realTemperature);
                    let outsideLimit = outsideReference - SUPER_COOLING_OUTSIDE_THRESHOLD;
                    if (outsideTemperature > outsideLimit) {
                        console.log(`Not super cooling despite temperature ${realTemperature} > ${targetTemperature} + ${SUPER_COOLING_TEMPERATURE_THRESHOLD}, because outside ${outsideTemperature} > max(target ${targetTemperature}, room ${realTemperature}) - ${SUPER_COOLING_OUTSIDE_THRESHOLD} = ${outsideLimit} at ${formatNiceDateTime(Date.now())}`);
                        await setSuperCooling(false, `Room ${realTemperature} > ${targetTemperature} + ${SUPER_COOLING_TEMPERATURE_THRESHOLD}, but outside ${outsideTemperature} > ${outsideReference} - ${SUPER_COOLING_OUTSIDE_THRESHOLD} = ${outsideLimit}`);
                    } else {
                        console.log(`Turning on super cooling due to temperature ${realTemperature} > ${targetTemperature} + ${SUPER_COOLING_TEMPERATURE_THRESHOLD}, with outside ${outsideTemperature} <= max(target ${targetTemperature}, room ${realTemperature}) - ${SUPER_COOLING_OUTSIDE_THRESHOLD} = ${outsideLimit} at ${formatNiceDateTime(Date.now())}`);
                        await setSuperCooling(true, `Room ${realTemperature} > ${targetTemperature} + ${SUPER_COOLING_TEMPERATURE_THRESHOLD}, outside ${outsideTemperature} <= ${outsideReference} - ${SUPER_COOLING_OUTSIDE_THRESHOLD} = ${outsideLimit}`);
                    }
                } else {
                    await setSuperCooling(false, `Room ${realTemperature} <= ${targetTemperature} + ${SUPER_COOLING_TEMPERATURE_THRESHOLD}`);
                }
            }
        }

        async function coolingHandler() {
            let info = await getThermostat();
            async function setCoolingOn() {
                let curTemp = info.properties.temperature_celsius;
                curTemp -= THERMOSTAT_FORCE_OFFSET;
                if (curTemp < COOLING_SET_POINT_MIN) {
                    console.warn(`Tried to set cooling set point too low (${curTemp}C), limiting to ${COOLING_SET_POINT_MIN}C`);
                    curTemp = COOLING_SET_POINT_MIN;
                }
                await setCoolingTemperature(curTemp);
                recordSetPoint("cooling", curTemp);
            }
            async function setCoolingOff() {
                await turnThermostatOff(info);
            }
            let roomReading = readSensorTemperature(THERMOSTAT_SENSOR, "room");
            let realTemperature: number;
            let temperatureSource = THERMOSTAT_SENSOR;
            if ("error" in roomReading) {
                // Silently returning here leaves whatever set point was last written frozen indefinitely, so a dead sensor must not mean "do nothing" — the ecobee's own reading keeps the control loop alive, if less accurately placed.
                realTemperature = info.properties.temperature_celsius;
                temperatureSource = THERMOSTAT_ID;
                console.warn(`${roomReading.error}, falling back to the ecobee's own reading of ${realTemperature}C at ${formatNiceDateTime(Date.now())}`);
            } else {
                realTemperature = roomReading.temperature;
            }

            let targetTemperature = getCurrentTemperatureFromSets(TEMPERATURE_PLAN);
            recordControlTemperature(realTemperature, temperatureSource, targetTemperature);

            if (realTemperature === targetTemperature) {
                console.log(`Temperature is equal to target ${realTemperature} at ${formatNiceDateTime(Date.now())}. Not touching state`);
                recordHvac(undefined, `Room ${realTemperature} == target ${targetTemperature}, leaving as is`);
            } else if (realTemperature > targetTemperature) {
                console.log(`Turning on cooling for due to temperature being too high ${realTemperature} > ${targetTemperature} at ${formatNiceDateTime(Date.now())}`);
                recordHvac(true, `Room ${realTemperature} > target ${targetTemperature}`);
                await setCoolingOn();
                console.log(JSON.stringify({ id: OUR_THERMOSTAT_ID, time: Date.now(), temperature_celsius: realTemperature, cooling_set_point_celsius: targetTemperature, is_cooling: true }));
            } else if (realTemperature < targetTemperature) {
                console.log(`Turning off cooling for due to temperature being too low ${realTemperature} < ${targetTemperature} at ${formatNiceDateTime(Date.now())}`);
                recordHvac(false, `Room ${realTemperature} < target ${targetTemperature}`);
                await setCoolingOff();
                console.log(JSON.stringify({ id: OUR_THERMOSTAT_ID, time: Date.now(), temperature_celsius: realTemperature, cooling_set_point_celsius: targetTemperature, is_cooling: false }));
            }
        }

        void runInfinitePollCallAtStart(TEMPERATURE_POLL_RATE, async () => {
            if (BUILDING_MODE === "heating") {
                await heatingHandler();
            } else {
                await coolingHandler();
            }
        });

        // // Set initial temperature based on current time
        // await setHeatTemperatureHelper(getCurrentTemperatureFromSets(sets));

        // // Register daily callbacks
        // for (let set of sets) {
        //     dailyCallback(set.time, async () => {
        //         await setHeatTemperatureHelper(set.temperature);
        //     });
        // }
    }
}

main().catch(console.error);