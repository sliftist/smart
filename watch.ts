import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Configuration
const POLL_INTERVAL_MS = 30000; // Check every 60 seconds
const RESTART_COMMAND = "bash ~/startup.sh";
const GIT_REF = "origin/main"; // Change to your branch, e.g., "origin/master"

interface GitStatus {
    hasChanges: boolean;
    localCommit: string;
    remoteCommit: string;
}

async function checkForUpdates(): Promise<GitStatus> {
    try {
        // Fetch latest changes from remote without pulling
        console.log("[Git Auto-Update] Fetching from remote...");
        await execAsync("git fetch");

        // Get local HEAD commit
        const { stdout: localCommit } = await execAsync("git rev-parse HEAD");

        // Get remote HEAD commit (assuming origin/master or origin/main)
        let remoteCommit: string;
        try {
            const { stdout } = await execAsync("git rev-parse @{u}");
            remoteCommit = stdout.trim();
        } catch (error) {
            // Try common branch names if upstream isn't set
            try {
                const { stdout: currentBranch } = await execAsync("git rev-parse --abbrev-ref HEAD");
                const branch = currentBranch.trim();
                const { stdout } = await execAsync(`git rev-parse origin/${branch}`);
                remoteCommit = stdout.trim();
            } catch (innerError) {
                console.log("[Git Auto-Update] Could not determine remote branch. Using local commit.");
                remoteCommit = localCommit.trim();
            }
        }

        const hasChanges = localCommit.trim() !== remoteCommit;

        return {
            hasChanges,
            localCommit: localCommit.trim(),
            remoteCommit: remoteCommit.trim()
        };
    } catch (error) {
        console.error("[Git Auto-Update] Error checking for updates:", error);
        return { hasChanges: false, localCommit: "", remoteCommit: "" };
    }
}

async function pullChanges(): Promise<boolean> {
    try {
        console.log("[Git Auto-Update] Pulling changes with robust strategy...");

        // Step 1: Update remote info
        console.log("[Git Auto-Update] Running: git remote update");
        await execAsync("git remote update");

        // Step 2: Stage all changes
        console.log("[Git Auto-Update] Running: git add --all");
        await execAsync("git add --all");

        // Step 3: Stash any local changes
        console.log("[Git Auto-Update] Running: git stash");
        await execAsync("git stash");

        // Step 4: Fetch from all remotes
        console.log("[Git Auto-Update] Running: git fetch --all");
        await execAsync("git fetch --all");

        // Step 5: Hard reset to the configured ref
        console.log(`[Git Auto-Update] Running: git reset --hard ${GIT_REF}`);
        const { stdout: resetOutput } = await execAsync(`git reset --hard ${GIT_REF}`);
        console.log("[Git Auto-Update] Reset output:", resetOutput);

        // Step 6: Prune deleted objects
        console.log("[Git Auto-Update] Running: git prune");
        await execAsync("git prune");

        console.log("[Git Auto-Update] ✓ All git operations completed successfully");
        return true;
    } catch (error) {
        console.error("[Git Auto-Update] Error during git operations:", error);
        return false;
    }
}

async function restartScripts(): Promise<void> {
    try {
        console.log("[Git Auto-Update] Restarting scripts...");
        console.log(`[Git Auto-Update] Running: ${RESTART_COMMAND}`);

        // Execute the restart command
        const { stdout, stderr } = await execAsync(RESTART_COMMAND);

        if (stdout) {
            console.log("[Git Auto-Update] Restart output:", stdout);
        }
        if (stderr) {
            console.log("[Git Auto-Update] Restart stderr:", stderr);
        }

        console.log("[Git Auto-Update] Scripts restarted successfully");
    } catch (error) {
        console.error("[Git Auto-Update] Error restarting scripts:", error);
        console.log("[Git Auto-Update] Continuing to poll...");
    }
}

async function poll(): Promise<void> {
    console.log("[Git Auto-Update] Checking for updates...");

    const status = await checkForUpdates();

    if (status.hasChanges) {
        console.log("[Git Auto-Update] ✓ New changes detected!");
        console.log(`[Git Auto-Update]   Local:  ${status.localCommit.substring(0, 8)}`);
        console.log(`[Git Auto-Update]   Remote: ${status.remoteCommit.substring(0, 8)}`);

        const pullSuccess = await pullChanges();

        if (pullSuccess) {
            console.log("[Git Auto-Update] Successfully pulled changes");
            await restartScripts();
        } else {
            console.log("[Git Auto-Update] Failed to pull changes, will retry on next poll");
        }
    } else {
        console.log("[Git Auto-Update] No new changes");
    }
}

async function main(): Promise<void> {
    console.log("=".repeat(60));
    console.log("[Git Auto-Update] Starting git auto-update script");
    console.log(`[Git Auto-Update] Poll interval: ${POLL_INTERVAL_MS / 1000} seconds`);
    console.log(`[Git Auto-Update] Git reference: ${GIT_REF}`);
    console.log(`[Git Auto-Update] Restart command: ${RESTART_COMMAND}`);
    console.log("=".repeat(60));

    // Initial check
    await poll();

    // Set up polling interval
    setInterval(async () => {
        await poll();
    }, POLL_INTERVAL_MS);

    console.log("[Git Auto-Update] Polling started...");
}

// Handle graceful shutdown
process.on("SIGINT", () => {
    console.log("\n[Git Auto-Update] Received SIGINT, shutting down...");
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("\n[Git Auto-Update] Received SIGTERM, shutting down...");
    process.exit(0);
});

// Start the script
main().catch((error) => {
    console.error("[Git Auto-Update] Fatal error:", error);
    process.exit(1);
});

