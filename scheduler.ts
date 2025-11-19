import { timeInHour } from "socket-function/src/misc";

export function dailyCallback(hour: number, callback: () => Promise<void>) {
    const scheduleNext = () => {
        const now = new Date();
        const target = new Date();

        // Convert fractional hour to hours and minutes
        const hours = Math.floor(hour);
        const minutes = (hour - hours) * 60;

        // Set target time for today
        target.setHours(hours, minutes, 0, 0);

        // If target time has already passed today, schedule for tomorrow
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }

        const delay = target.getTime() - now.getTime();

        setTimeoutAccurate(async () => {
            await callback();
            scheduleNext(); // Reschedule for next day
        }, delay);
    };

    scheduleNext();
}

export function setTimeoutAccurate(callback: () => void, delay: number) {
    let time = Date.now() + delay;
    void (async () => {
        while (true) {
            let now = Date.now();
            let timeToDelay = time - now;
            if (timeToDelay > 0) {
                console.log("Waiting for", timeToDelay, "milliseconds");
                // Wait between an hour and ten milliseconds.
                // - I don't trust waiting for longer than an hour, and there are limits to how long we can wait. I don't think we can wait more than a few weeks?
                timeToDelay = Math.min(timeToDelay, timeInHour);
                timeToDelay = Math.max(timeToDelay, 10);
                // We only 95% of the time, which should prevent us from overshooting. 
                timeToDelay *= 0.95;
                await new Promise(resolve => setTimeout(resolve, timeToDelay));
            } else {
                break;
            }
        }
        callback();
    })();
}