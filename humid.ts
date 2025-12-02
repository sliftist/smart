import { configure, autorun, observable } from "mobx";
import { formatNiceDateTime, formatTime, formatVeryNiceDateTime } from "socket-function/src/formatting/format";
import { linesToObjects, objectsToObservable, watchDirectory, watchFile } from "./logWatcher";
import { PlugOne } from "./plug";
import { timeInMinute } from "socket-function/src/misc";
import { getThermostat, setHeatingTemperatureFahrenheit } from "./ac";
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

const THERMOSTAT_ID = "ecobee";
const THERMOSTAT_SENSOR = "154";
const THERMOSTAT_FORCE_OFFSET = 2;

const OUR_THERMOSTAT_ID = "better_ecobee";

// TODO: Maybe change this to use the observable system, so we can respond immediately? Hmm...
const TEMPERATURE_POLL_RATE = timeInMinute * 2.5;

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
            { time: 1, temperature: 21 },
            // Warm, to wake up
            { time: 9.5, temperature: 25 },
            // Less warm, as our computer will start to get hot around this time
            { time: 12.5, temperature: 23 },
        ];

        void runInfinitePollCallAtStart(timeInMinute, async () => {
            let info = await getThermostat();
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

        function getRealTemperature(): number | undefined {
            let temperature = allData[THERMOSTAT_SENSOR];
            if (!temperature) return undefined;
            if (!("temperature_C" in temperature)) return undefined;
            let timeOff = Math.abs(new Date(temperature.time).getTime() - Date.now());
            if (timeOff > MAX_DATA_AGE) {
                console.warn(`Temperature data is too old for ${THERMOSTAT_SENSOR}. Now is ${formatNiceDateTime(Date.now())}, and the temperature was at ${formatNiceDateTime(+new Date(temperature.time))}, so it is ${formatTime(timeOff)} off`);
                return undefined;
            }
            return temperature.temperature_C;
        }

        // TODO: Support cooling as well? I guess just a mode which *-1 a lot of values/comparisons
        void runInfinitePollCallAtStart(timeInMinute * 1, async () => {
            let info = await getThermostat();
            async function setHeatingOn() {
                // Just set it higher than it is, to trick it to turn on. If we call this frequently enough, and the granularity is good enough, this will keep it on forever (as it will go up 50% of THERMOSTAT_FORCE_OFFSET, then we set it even higher, etc, etc)
                let curTemp = info.properties.temperature_fahrenheit;
                curTemp += THERMOSTAT_FORCE_OFFSET;
                if (curTemp > 77) {
                    curTemp = 77;
                    console.warn(`Tried to set temperature too high (${curTemp}F), limiting to 77F (25C)`);
                }
                await setHeatingTemperatureFahrenheit(curTemp);
            }
            async function setHeatingOff() {
                let curTemp = info.properties.temperature_fahrenheit;
                curTemp -= THERMOSTAT_FORCE_OFFSET;
                if (curTemp < 60) {
                    curTemp = 60;
                    console.warn(`Tried to set temperature too low (${curTemp}F), limiting to 60F (15.6C)`);
                }
                await setHeatingTemperatureFahrenheit(curTemp);
            }
            let realTemperature = getRealTemperature();
            if (realTemperature === undefined) {
                // NOTE: Because our method of setting the heating on or off just changes the set point, It's safest to just leave it as it is. It might be a little bit warm or a little bit hot. It might be very warm, very hot, up to 25 Celsius. Which actually will result in more like 28 Celsius (because ecobees are terrible), Or very cold, getting down to maybe 18 Celsius. However, both of these are acceptable. It's not going to cause runaway problems, such as if the humidifier is on constantly. And reasonably speaking, the temperature won't change by that much, so the set point won't change by that much by the time we notice the data is too stale and stop looking updating. 
                return;
            }
            let targetTemperature = getCurrentTemperatureFromSets(sets);
            if (realTemperature === targetTemperature) {
                console.log(`Temperature is equal to target ${realTemperature} at ${formatNiceDateTime(Date.now())}. Not touching state`);
            } else if (realTemperature < targetTemperature) {
                console.log(`Turning on heating for due to temperature being too low ${realTemperature} < ${targetTemperature} at ${formatNiceDateTime(Date.now())}`);
                await setHeatingOn();
                console.log(JSON.stringify({ id: OUR_THERMOSTAT_ID, time: Date.now(), temperature_celsius: realTemperature, heating_set_point_celcius: targetTemperature, is_heating: true }));
            } else if (realTemperature > targetTemperature) {
                console.log(`Turning off heating for due to temperature being too high ${realTemperature} > ${targetTemperature} at ${formatNiceDateTime(Date.now())}`);
                await setHeatingOff();
                console.log(JSON.stringify({ id: OUR_THERMOSTAT_ID, time: Date.now(), temperature_celsius: realTemperature, heating_set_point_celcius: targetTemperature, is_heating: false }));
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