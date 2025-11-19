import { lazy } from "socket-function/src/caching";
import fs from "fs";
import os from "os";
import { retryFunctional } from "socket-function/src/batching";

// IMPORTANT! While we set the values in Celsius, The underlying thermostat is in Fahrenheit integers. The user interface displays temperatures as if there's 0.5 Celsius precision, which does allow unique mapping, even though it's slightly wrong. 

const THERMOSTAT_ID = "f160deb7-20fe-4478-b0c1-16b9c7345e86";

const getSeamKey = lazy(async () => {
    let path = os.homedir() + "/seam.key";
    if (!fs.existsSync(path)) throw new Error(`Seam key file not found at ${path}`);
    return (await fs.promises.readFile(path, "utf8")).trim();
});

const SEAM_API_BASE_URL = "https://connect.getseam.com";

const seamApiCall = retryFunctional(async function seamApiCall<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
    const key = await getSeamKey();
    const url = `${SEAM_API_BASE_URL}${path}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Seam API error (${response.status}): ${errorText}`);
    }

    return await response.json();
}, {
    // If we crawl the API incorrectly, we will get warning messages, so that's fine. And we really, really want these calls to succeed, as if they don't, our house might stay hotter or colder than we want, which is really annoying. I don't want to wake up too cold because the internet went down for a few minutes in the night
    maxRetries: 300,
    minDelay: 10 * 1000,
    maxDelay: 10 * 1000,
});

export async function getDevices() {
    const result = await seamApiCall("/devices/list", {});
    return result.devices;
}

export async function getThermostat() {
    const result = await seamApiCall("/devices/get", { device_id: THERMOSTAT_ID });
    return result.device;
}

export async function setHvacMode(mode: "off" | "cool" | "heat" | "heat_cool") {
    return await seamApiCall("/thermostats/heat_cool", {
        device_id: THERMOSTAT_ID,
        hvac_mode_setting: mode,
    });
}

export async function setFanMode(mode: "auto" | "on") {
    return await seamApiCall("/thermostats/set_fan_mode", {
        device_id: THERMOSTAT_ID,
        fan_mode_setting: mode,
    });
}

export async function setHeatingTemperature(celsius: number) {
    return await seamApiCall("/thermostats/heat", {
        device_id: THERMOSTAT_ID,
        heating_set_point_celsius: celsius,
    });
}
export async function setHeatingTemperatureFahrenheit(fahrenheit: number) {
    return await seamApiCall("/thermostats/heat", {
        device_id: THERMOSTAT_ID,
        heating_set_point_fahrenheit: fahrenheit,
    });
}

export async function setCoolingTemperature(celsius: number) {
    return await seamApiCall("/thermostats/cool", {
        device_id: THERMOSTAT_ID,
        cooling_set_point_celsius: celsius,
    });
}

export async function setHeatCoolTemperatures(heatingCelsius: number, coolingCelsius: number) {
    return await seamApiCall("/thermostats/heat_cool", {
        device_id: THERMOSTAT_ID,
        heating_set_point_celsius: heatingCelsius,
        cooling_set_point_celsius: coolingCelsius,
    });
}


export async function setHeatTemperatureHelper(celsius: number) {
    let info = await getThermostat();
    console.log("Current thermostat state:", info.properties.current_climate_setting);
    console.log("Setting temperature to", celsius);
    await setHeatingTemperature(celsius);
}