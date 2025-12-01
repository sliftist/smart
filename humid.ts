import { configure, autorun, observable } from "mobx";
import { formatNiceDateTime, formatTime, formatVeryNiceDateTime } from "socket-function/src/formatting/format";
import { linesToObjects, objectsToObservable, watchDirectory, watchFile } from "./logWatcher";
import { PlugOne } from "./plug";
import { timeInMinute } from "socket-function/src/misc";
import { getThermostat, setHeatTemperatureHelper } from "./ac";
import { dailyCallback } from "./scheduler";
import { runInfinitePoll, runInfinitePollCallAtStart } from "socket-function/src/batching";

/*
24 outside
154 beside outside door
225 bathroom
248 microwave
132 beside computer
211 bedroom window
*/

const HUMIDITY_ID = "132";
const HUMIDITY = 50;
const THROTTLE_TIME = timeInMinute * 2;
const MAX_DATA_AGE = timeInMinute * 5;
const MAX_TIME_NO_DATA = timeInMinute * 10;
const PLUG = PlugOne;

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

async function main() {
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
    let paused = observable({ value: false });
    function changePlugState(on: boolean) {
        isPlugOn = on;
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
                changePlugState(false);
            }
            return;
        }
        humidityCountdown.value = 0;
        if (humidity <= HUMIDITY) {
            console.log(`Turning on humidifier for #${HUMIDITY_ID} due to humidity being too low ${humidity} <= ${HUMIDITY} at ${formatNiceDateTime(Date.now())}`);
            changePlugState(true);
        } else if (humidity > HUMIDITY) {
            console.log(`Turning off humidifier for #${HUMIDITY_ID} due to humidity being too high ${humidity} > ${HUMIDITY} at ${formatNiceDateTime(Date.now())}`);
            changePlugState(false);
        } else {
            console.log(`Humidity is equal to target ${humidity} for #${HUMIDITY_ID} (${HUMIDITY}) at ${formatNiceDateTime(Date.now())}`);
        }
    });

    // TODO: Set temperature based on other probe, using json logging so we can chart the target, set, and actual temperatures.
    //  - Also might as well read the temperature from the ecobee, so we can determine if it is an offset, or it is just wrong...
    // Cold at night, warm up during the day.
    {
        let sets = [
            // Cold, so we go to sleep
            { time: 1, temperature: 18.5 },
            // Warm, to wake up
            { time: 9.5, temperature: 23.5 },
            // Less warm, as our computer will start to get hot around this time
            { time: 12.5, temperature: 19 },
        ];

        void runInfinitePollCallAtStart(timeInMinute, async () => {
            let info = await getThermostat();
            console.log(JSON.stringify({
                id: "ecobee",
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

        // Set initial temperature based on current time
        await setHeatTemperatureHelper(getCurrentTemperatureFromSets(sets));

        // Register daily callbacks
        for (let set of sets) {
            dailyCallback(set.time, async () => {
                await setHeatTemperatureHelper(set.temperature);
            });
        }
    }
}

main().catch(console.error);