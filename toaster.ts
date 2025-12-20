import { PlugSix } from "./plug";
import { delay } from "socket-function/src/batching";
import { exec } from "child_process";
import { formatNumber, formatTime } from "socket-function/src/formatting/format";

async function showWindowsNotification(title: string, message: string) {
    // Use PowerShell to show a Windows balloon notification
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

async function main() {
    console.log("Starting toaster monitor...");

    let isToasting = false;
    let toastingStartTime: number | null = null;
    let toastingEndTime: number | null = null;

    while (true) {
        try {
            const energyData = await PlugSix.getEnergyData();
            const currentPower = energyData.current_power;
            let nextIsToasting = currentPower > 10 * 1000;

            if (!isToasting && nextIsToasting) {
                // Toaster just turned on
                isToasting = true;
                toastingStartTime = Date.now();
                console.log("Toaster started!");
            } else if (isToasting && !nextIsToasting) {
                // Toaster just turned off
                isToasting = false;
                toastingEndTime = Date.now();
                const duration = toastingStartTime ? toastingEndTime - toastingStartTime : 0;
                const durationText = formatTime(duration);
                console.log(`Toaster finished after ${durationText}! Showing notification...`);
                showWindowsNotification("Toaster", `Food is done! Toasted for ${durationText}`).catch(console.error);
                toastingStartTime = null;
            }

            let statusText: string;
            if (nextIsToasting && toastingStartTime) {
                const duration = Date.now() - toastingStartTime;
                statusText = `Toasting for ${formatTime(duration)}`;
            } else if (toastingEndTime) {
                const timeSince = Date.now() - toastingEndTime;
                statusText = `Last toast ${formatTime(timeSince)} ago, for ${formatTime(toastingEndTime - toastingStartTime!)}`;
            } else {
                statusText = `Waiting for toast`;
            }

            console.log(`[${new Date().toLocaleTimeString()}] Current power: ${formatNumber(currentPower / 1000)}W, ${statusText}`);

            // Poll every 2 seconds when toasting, 5 seconds otherwise
            await delay(isToasting ? 2000 : 5000);
        } catch (error) {
            console.error("Error polling toaster:", error);
            await delay(5000);
        }
    }
}

main().catch(console.error);

