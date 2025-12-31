import tsplinkconnect from "tp-link-tapo-connect";
import { lazy } from "socket-function/src/caching";
import * as fs from "fs";
import * as os from "os";



const getCreds = lazy(async () => {
    let contents = await fs.promises.readFile(os.homedir() + "/tplink.json", "utf8");
    return JSON.parse(contents) as {
        email: string;
        password: string;
    };
});

export class Plug {
    constructor(public readonly deviceMac: string) { }
    private async getDevice() {
        let creds = await getCreds();
        return await tsplinkconnect.loginDevice(creds.email, creds.password, { deviceMac: this.deviceMac } as any);
    }
    public async getInfo(): Promise<{
        device_on: boolean;
    }> {
        const device = await this.getDevice();
        const info = await device.getDeviceInfo();
        return info;
    }
    public async getEnergyData(): Promise<{
        today_runtime: number;
        month_runtime: number;
        today_energy: number;
        month_energy: number;
        local_time: string;
        electricity_charge: number[];
        current_power: number;
    }> {
        const device = await this.getDevice();
        const info = await device.getEnergyUsage() as any;
        return info;
    }
    public async getOn(): Promise<boolean> {
        const device = await this.getDevice();
        const info = await device.getDeviceInfo();
        return info.device_on;
    }
    public async setOn(on: boolean): Promise<void> {
        const device = await this.getDevice();
        console.log(JSON.stringify({
            id: this.deviceMac,
            type: "plug",
            plugOn: on,
            time: new Date().toISOString(),
        }));
        if (on) {
            await device.turnOn();
        } else {
            await device.turnOff();
        }
    }
}

// Set up in app, and read off the physical device


// humidifier
export const PlugOne = new Plug("8C902DF801D2");
// monitors
export const PlugTwo = new Plug("8C902DF80E35");
// uv cleaner
export const PlugThree = new Plug("CCBABD05A2E2");
// uv cleaner reservoir
export const PlugFour = new Plug("CCBABD0592DE");
// outside fan
export const PlugFive = new Plug("CCBABD059E1E");
// toaster
export const PlugSix = new Plug("CCBABD059D36");

export const PlugSeven = new Plug("3C7895B76C37");
export const PlugEight = new Plug("3C7895B75EC6");
export const PlugNine = new Plug("3C7895B75EB8");
export const PlugTen = new Plug("3C7895B76D82");
export const PlugEleven = new Plug("3C7895B76C33");
export const PlugTwelve = new Plug("3C7895B764D1");