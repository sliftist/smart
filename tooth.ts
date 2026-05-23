import { PlugEight } from "./plug";
import { delay } from "socket-function/src/batching";
import { exec } from "child_process";
import { formatNumber } from "socket-function/src/formatting/format";
import * as fs from "fs";

const POLL_INTERVAL_MS = 15 * 1000;
const FILE_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_HOUR = 16; // 4pm local
const CHUNK_RATIO = 2;
const ZERO_POWER_THRESHOLD = 0.5; // watts, below this treat as off
const NOTIFICATION_MAX_CHARS = 500;
const OUTPUT_FILE = "./tooth-last-24h.txt";

type Sample = { time: number; power: number };
type Chunk = {
    start: number;
    end: number;
    avgPower: number;
    samples: number;
};

async function showWindowsNotification(title: string, message: string) {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$balloon = New-Object System.Windows.Forms.NotifyIcon
$balloon.Icon = [System.Drawing.SystemIcons]::Information
$balloon.BalloonTipTitle = '${title.replace(/'/g, "''")}'
$balloon.BalloonTipText = '${message.replace(/'/g, "''")}'
$balloon.Visible = $true
$balloon.ShowBalloonTip(10000)
Start-Sleep -Seconds 10
$balloon.Dispose()
`;
    return new Promise<void>((resolve, reject) => {
        exec(`powershell -Command "${script.replace(/\r?\n/g, "; ")}"`, (error) => {
            if (error) {
                console.error("Failed to show notification:", error);
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

function sameMagnitude(a: number, b: number): boolean {
    // Both effectively zero → same.
    if (a < ZERO_POWER_THRESHOLD && b < ZERO_POWER_THRESHOLD) return true;
    // One zero, the other not → different.
    if (a < ZERO_POWER_THRESHOLD || b < ZERO_POWER_THRESHOLD) return false;
    const ratio = a > b ? a / b : b / a;
    return ratio < CHUNK_RATIO;
}

function chunkSamples(samples: Sample[]): Chunk[] {
    const chunks: Chunk[] = [];
    let curStart = 0;
    let curSum = 0;
    let curCount = 0;
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const avg = curCount > 0 ? curSum / curCount : s.power;
        if (curCount === 0) {
            curStart = i;
            curSum = s.power;
            curCount = 1;
            continue;
        }
        if (sameMagnitude(s.power, avg)) {
            curSum += s.power;
            curCount += 1;
        } else {
            chunks.push({
                start: samples[curStart].time,
                end: samples[i - 1].time,
                avgPower: curSum / curCount,
                samples: curCount,
            });
            curStart = i;
            curSum = s.power;
            curCount = 1;
        }
    }
    if (curCount > 0) {
        chunks.push({
            start: samples[curStart].time,
            end: samples[samples.length - 1].time,
            avgPower: curSum / curCount,
            samples: curCount,
        });
    }
    return chunks;
}

function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
}

function formatTimeOfDay(t: number): string {
    const d = new Date(t);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function summarizeChunks(chunks: Chunk[]): string {
    const lines: string[] = [];
    for (const c of chunks) {
        const dur = c.end - c.start + POLL_INTERVAL_MS;
        const power = c.avgPower < ZERO_POWER_THRESHOLD ? "off" : `${formatNumber(c.avgPower)}W`;
        lines.push(`${formatTimeOfDay(c.start)}-${formatTimeOfDay(c.end)} ${power} (${formatDuration(dur)})`);
    }
    return lines.join("\n");
}

function buildFullReport(samples: Sample[], chunks: Chunk[]): string {
    const header = `PlugEight (toothbrush) — last 24h\nGenerated: ${new Date().toISOString()}\nSamples: ${samples.length}, Chunks: ${chunks.length}\n\n`;
    return header + summarizeChunks(chunks);
}

function buildAlertText(chunks: Chunk[]): string {
    let text = `Tooth 24h (${chunks.length} chunks):\n` + summarizeChunks(chunks);
    if (text.length > NOTIFICATION_MAX_CHARS) {
        // Keep most recent events.
        const lines = text.split("\n");
        const header = lines[0];
        let body = "";
        for (let i = lines.length - 1; i >= 1; i--) {
            const candidate = lines[i] + (body ? "\n" + body : "");
            if ((header + "\n...\n" + candidate).length > NOTIFICATION_MAX_CHARS) break;
            body = candidate;
        }
        text = header + "\n...\n" + body;
    }
    return text;
}

async function main() {
    console.log("Starting tooth (PlugEight) monitor...");

    const samples: Sample[] = [];
    let lastFileUpdate = 0;
    let lastNotificationDay = "";

    while (true) {
        try {
            const energy = await PlugEight.getEnergyData();
            // current_power is in milliwatts on Tapo plugs.
            const watts = (energy.current_power || 0) / 1000;
            const now = Date.now();
            samples.push({ time: now, power: watts });

            // Drop samples older than 24h.
            const cutoff = now - WINDOW_MS;
            while (samples.length > 0 && samples[0].time < cutoff) samples.shift();

            console.log(`[${new Date().toLocaleTimeString()}] ${formatNumber(watts)}W (${samples.length} samples in window)`);

            if (now - lastFileUpdate >= FILE_UPDATE_INTERVAL_MS) {
                lastFileUpdate = now;
                const chunks = chunkSamples(samples);
                const report = buildFullReport(samples, chunks);
                await fs.promises.writeFile(OUTPUT_FILE, report);
            }

            const nowDate = new Date(now);
            const dayKey = nowDate.toDateString();
            if (nowDate.getHours() >= NOTIFICATION_HOUR && lastNotificationDay !== dayKey) {
                lastNotificationDay = dayKey;
                const chunks = chunkSamples(samples);
                const alert = buildAlertText(chunks);
                console.log("---- ALERT ----\n" + alert + "\n---------------");
                showWindowsNotification("Toothbrush 24h", alert).catch(console.error);
            }
        } catch (error) {
            console.error("Error polling PlugEight:", (error as Error).stack ?? error);
        }
        await delay(POLL_INTERVAL_MS);
    }
}

main().catch(err => console.error((err as Error).stack ?? err));
