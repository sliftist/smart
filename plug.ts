import tsplinkconnect from "tp-link-tapo-connect";
import { lazy } from "socket-function/src/caching";
import * as fs from "fs";
import * as os from "os";

// Set up in app, and then read from there, or just read off the device itself.
const PLUG_ONE = "8C902DF801D2";
const PLUG_TWO = "8C902DF80E35";

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

export const PlugOne = new Plug(PLUG_ONE);
export const PlugTwo = new Plug(PLUG_TWO);