import { spawn } from "child_process";
import * as fs from "fs";
import { nextId } from "socket-function/src/misc";

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection:", reason);
    console.error("Promise:", promise);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});
const threadId = nextId();

function getLogFilename(namespace: string) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;
    return `logs/${dateStr}-${namespace}-${threadId}.log`;
}

async function runScript(namespace: string, commandLine: string) {
    if (!fs.existsSync("logs")) {
        fs.mkdirSync("logs");
    }

    let currentLogFile = getLogFilename(namespace);
    let logStream = fs.createWriteStream(currentLogFile, { flags: "a" });
    console.log(`Logging to: ${currentLogFile}`);

    // Check for day rollover every minute
    const rolloverInterval = setInterval(() => {
        const newLogFile = getLogFilename(namespace);
        if (newLogFile !== currentLogFile) {
            console.log(`\nDay changed, rotating to: ${newLogFile}`);
            logStream.end();
            currentLogFile = newLogFile;
            logStream = fs.createWriteStream(currentLogFile, { flags: "a" });
        }
    }, 60000);

    const child = spawn(commandLine, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: true
    });

    // Pipe both stdout and stderr to the same stream (both console and log file)
    child.stdout?.on("data", (data) => {
        process.stdout.write(data);
        logStream.write(data);
    });

    child.stderr?.on("data", (data) => {
        process.stderr.write(data);
        logStream.write(data);
    });

    // Forward kill signals to the child process
    const handleSignal = (signal: NodeJS.Signals) => {
        console.log(`\nReceived ${signal}, shutting down gracefully...`);
        clearInterval(rolloverInterval);
        logStream.end();
        child.kill(signal);
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    };

    if (process.platform === "win32") {
        var rl = require("readline").createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.on("SIGINT", function () {
            process.emit("SIGINT");
        });
    }

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGHUP", () => handleSignal("SIGHUP"));

    return new Promise<number>((resolve, reject) => {
        child.on("exit", (code, signal) => {
            clearInterval(rolloverInterval);
            logStream.end();
            if (signal) {
                reject(new Error(`Child process terminated by signal: ${signal}`));
            } else if (code !== null && code !== 0) {
                reject(new Error(`Child process exited with code: ${code}`));
            } else {
                resolve(code || 0);
            }
        });
    });
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.error("Usage: node log.ts <namespace> <command> [args...]");
        process.exit(1);
    }

    const namespace = args[0];
    const commandLine = args.slice(1).join(" ");

    while (true) {
        try {
            await runScript(namespace, commandLine);
        } catch (error) {
            console.error(error);
            console.log("Waiting 30 seconds before restarting...");
            await new Promise(resolve => setTimeout(resolve, 30 * 1000));
        }
    }
}

main().catch(console.error);

