import tsplinkconnect from "tp-link-tapo-connect";
import { lazy } from "socket-function/src/caching";
import * as fs from "fs";
import * as os from "os";
import * as childProcess from "child_process";

const ARP_TABLE_PATH = "/proc/net/arp";
const PING_TIMEOUT_SECONDS = 1;
const MAX_SWEEP_HOSTS = 1024;

function normalizeMac(mac: string) {
    return mac.replace(/[^0-9a-f]/gi, "").toLowerCase();
}

async function readArpTable(): Promise<Map<string, string>> {
    let table = new Map<string, string>();
    let contents = await fs.promises.readFile(ARP_TABLE_PATH, "utf8");
    for (let line of contents.split("\n").slice(1)) {
        let [ip, , flags, mac] = line.trim().split(/\s+/);
        if (!ip || !mac || flags === "0x0") continue;
        table.set(normalizeMac(mac), ip);
    }
    return table;
}

function ipToNumber(ip: string) {
    return ip.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}
function numberToIp(value: number) {
    return [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join(".");
}

function getSweepAddresses(): string[] {
    let addresses: string[] = [];
    for (let entries of Object.values(os.networkInterfaces())) {
        for (let entry of entries || []) {
            if (entry.family !== "IPv4" || entry.internal) continue;
            let mask = ipToNumber(entry.netmask);
            let hostCount = 2 ** 32 - mask;
            if (hostCount > MAX_SWEEP_HOSTS) {
                console.warn(`[pid ${process.pid}] Not sweeping ${entry.address}/${entry.netmask} for plugs, ${hostCount} addresses is more than the max of ${MAX_SWEEP_HOSTS}`);
                continue;
            }
            let network = ipToNumber(entry.address) - (ipToNumber(entry.address) % hostCount);
            for (let host = 1; host < hostCount - 1; host++) {
                addresses.push(numberToIp(network + host));
            }
        }
    }
    return addresses;
}

function ping(ip: string): Promise<void> {
    return new Promise(resolve => {
        let child = childProcess.spawn("ping", ["-c", "1", "-W", String(PING_TIMEOUT_SECONDS), ip], { stdio: "ignore" });
        child.on("error", () => resolve());
        child.on("exit", () => resolve());
    });
}

let sweepInProgress: Promise<void> | undefined;
function sweepNetwork(): Promise<void> {
    if (!sweepInProgress) {
        sweepInProgress = (async () => {
            let addresses = getSweepAddresses();
            await Promise.all(addresses.map(ping));
        })().finally(() => {
            sweepInProgress = undefined;
        });
    }
    return sweepInProgress;
}

async function resolvePlugIp(deviceMac: string): Promise<string> {
    let mac = normalizeMac(deviceMac);
    let ip = (await readArpTable()).get(mac);
    if (ip) return ip;
    let start = Date.now();
    await sweepNetwork();
    ip = (await readArpTable()).get(mac);
    if (!ip) {
        throw new Error(`Plug ${deviceMac} is not in ${ARP_TABLE_PATH}, even after pinging every address on the local network (took ${Date.now() - start}ms). It is probably unplugged or off the network`);
    }
    console.log(`[pid ${process.pid}] Plug ${deviceMac} was not in ${ARP_TABLE_PATH}, found it at ${ip} after pinging the local network (took ${Date.now() - start}ms)`);
    return ip;
}

export const getPlugCreds = lazy(async () => {
    let contents = await fs.promises.readFile(os.homedir() + "/tplink.json", "utf8");
    return JSON.parse(contents) as {
        email: string;
        password: string;
    };
});

export class Plug {
    constructor(public readonly deviceMac: string) { }
    private async getDevice() {
        let creds = await getPlugCreds();
        if (!fs.existsSync(ARP_TABLE_PATH)) {
            return await tsplinkconnect.loginDevice(creds.email, creds.password, { deviceMac: this.deviceMac } as any);
        }
        return await tsplinkconnect.loginDeviceByIp(creds.email, creds.password, await resolvePlugIp(this.deviceMac));
    }
    public async getInfo(): Promise<{
        device_on: boolean;
    }> {
        try {
            const device = await this.getDevice();
            const info = await device.getDeviceInfo();
            return info;
        } catch (error) {
            console.error(`Error getting info for plug ${this.deviceMac}:`, error);
            return {
                device_on: false,
            };
        }
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
        try {
            const device = await this.getDevice();
            const info = await device.getEnergyUsage() as any;
            return info;
        } catch (error) {
            console.error(`Error getting energy data for plug ${this.deviceMac}:`, error);
            try {
                // Try a non-network, but still exec command
                let result = await new Promise((resolve, reject) => {
                    childProcess.exec(`ls`, (error, stdout, stderr) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(stdout);
                        }
                    });
                });
                console.log(`ls succeeded, it's not a ioctl pipe. Probably network specific:`, result);
            } catch (error) {
                console.error(`Ls failed with error, issue is likely broken ioctl pipe?`, error);
            }
            return {
                today_runtime: 0,
                month_runtime: 0,
                today_energy: 0,
                month_energy: 0,
                local_time: new Date().toISOString(),
                electricity_charge: [],
                current_power: 0,
            };
        }
    }
    public async getOn(): Promise<boolean> {
        try {
            const device = await this.getDevice();
            const info = await device.getDeviceInfo();
            return info.device_on;
        } catch (error) {
            console.error(`Error getting plug ${this.deviceMac} on:`, error);
            return false;
        }
    }
    public async setOn(on: boolean): Promise<void> {
        try {
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
        } catch (error) {
            console.error(`Error setting plug ${this.deviceMac} on:`, error);
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
export const PlugFive = new Plug("CCBABD059E1E");
// toaster
export const PlugSix = new Plug("CCBABD059D36");
// printer
export const PlugSeven = new Plug("3C7895B76C37");
export const PlugEight = new Plug("3C7895B75EC6");
// outside fan
export const PlugNine = new Plug("3C7895B75EB8");
export const PlugTen = new Plug("3C7895B76D82");
export const PlugEleven = new Plug("3C7895B76C33");
export const PlugTwelve = new Plug("3C7895B764D1");