import { PlugSeven } from "./plug";
import { delay } from "socket-function/src/batching";
import { exec } from "child_process";
import { formatNumber } from "socket-function/src/formatting/format";

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

function formatTime(duration: number) {
    const totalSeconds = Math.floor(duration / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}



async function main() {
    console.log("Starting printer monitor...");

    let isToasting = false;
    let toastingStartTime: number | null = null;
    let lastToastingDuration = 0;
    let toastingEndTime: number | null = null;
    let heatTime = 0;
    let prevTime = 0;

    const isOnThreshold = 50 * 1000;
    const isHeatThreshold = 100 * 1000;

    while (true) {
        try {
            const energyData = await PlugSeven.getEnergyData();
            const currentPower = energyData.current_power;
            // The air fryer runs for about 30 or 40 seconds after it finishes with the fans to help cool it down, which is very useful. The fans take about ten watts, So we need to consider 10 watts to still be on.
            let nextIsToasting = currentPower > isOnThreshold;


            if (currentPower > isHeatThreshold && prevTime) {
                heatTime += (Date.now() - prevTime);
            }

            prevTime = Date.now();

            if (!isToasting && nextIsToasting) {
                // Toaster just turned on
                isToasting = true;
                toastingStartTime = Date.now();
                console.log("Printer started!");
                heatTime = 0;
            } else if (isToasting && !nextIsToasting) {
                // Toaster just turned off
                isToasting = false;
                toastingEndTime = Date.now();
                const duration = toastingEndTime - toastingStartTime!;
                lastToastingDuration = duration;
                console.log(`Printer finished after ${formatTime(duration)}! Showing notification...`);
                showWindowsNotification("Printer", `Print is done! Printed for ${formatTime(duration)} (${formatTime(heatTime)} heat, ${formatTime(duration - heatTime)} fan)`).catch(console.error);
                toastingStartTime = null;
                prevTime = 0;
            }

            let statusText: string;
            if (nextIsToasting && toastingStartTime) {
                const duration = Date.now() - toastingStartTime;
                statusText = `Printing for ${formatTime(duration)} (${formatTime(heatTime)} heat, ${formatTime(duration - heatTime)} fan)`;
            } else if (toastingEndTime) {
                const timeSince = Date.now() - toastingEndTime;
                statusText = `Last print ${formatTime(timeSince)} ago, for ${formatTime(lastToastingDuration)} (${formatTime(heatTime)} heat, ${formatTime(lastToastingDuration - heatTime)} fan)`;
            } else {
                statusText = `Waiting for print`;
            }

            console.log(`[${new Date().toLocaleTimeString()}] Current power: ${formatNumber(currentPower / 1000)}W, ${statusText}`);

            // Poll every 2 seconds when toasting, 5 seconds otherwise
            await delay(isToasting ? 2000 : 5000);
        } catch (error) {
            console.error("Error polling printer:", error);
            await delay(5000);
        }
    }
}

main().catch(console.error);

