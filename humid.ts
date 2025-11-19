import { configure, autorun, observable } from "mobx";
import { formatNiceDateTime, formatTime, formatVeryNiceDateTime } from "socket-function/src/formatting/format";
import { linesToObjects, objectsToObservable, watchDirectory, watchFile } from "./logWatcher";
import { PlugOne } from "./plug";
import { timeInMinute } from "socket-function/src/misc";
import { setHeatTemperatureHelper } from "./ac";
import { dailyCallback } from "./scheduler";

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

    // Cold at night, warm up during the day.
    {
        // TODO: Helper to define the ranges and set the current + the dailyCallbacks
        let hourFraction = new Date().getHours() + new Date().getMinutes() / 60;
        if (hourFraction >= 2.5 && hourFraction < 10.5) {
            await setHeatTemperatureHelper(21.5);
        } else if (hourFraction >= 10.5 && hourFraction < 14.5) {
            await setHeatTemperatureHelper(23.5);
        } else {
            await setHeatTemperatureHelper(22.5);
        }

        dailyCallback(2, async () => {
            await setHeatTemperatureHelper(20.5);
        });
        dailyCallback(9.5, async () => {
            await setHeatTemperatureHelper(23.5);
        });
        dailyCallback(12.5, async () => {
            await setHeatTemperatureHelper(22.5);
        });
    }
}

main().catch(console.error);