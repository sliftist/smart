import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

function createAsyncIterable<T>(): {
    iterable: AsyncIterable<T>;
    push: (item: T) => void;
    close: () => void;
} {
    const queue: T[] = [];
    let resolve: ((value: IteratorResult<T>) => void) | null = null;
    let closed = false;

    const iterable: AsyncIterable<T> = {
        [Symbol.asyncIterator](): AsyncIterator<T> {
            return {
                async next(): Promise<IteratorResult<T>> {
                    if (queue.length > 0) {
                        return { value: queue.shift()!, done: false };
                    }
                    if (closed) {
                        return { value: undefined, done: true };
                    }
                    return new Promise<IteratorResult<T>>((res) => {
                        resolve = res;
                    });
                }
            };
        }
    };

    return {
        iterable,
        push: (item: T) => {
            if (resolve) {
                resolve({ value: item, done: false });
                resolve = null;
            } else {
                queue.push(item);
            }
        },
        close: () => {
            closed = true;
            if (resolve) {
                resolve({ value: undefined, done: true });
                resolve = null;
            }
        }
    };
}

// Helper function to check if a log file is from the last week
function isFileWithinLastWeek(filename: string): boolean {
    // Extract date from filename pattern: YYYY-MM-DD-namespace-...
    const dateMatch = filename.match(/^(\d{4})-(\d{2})-(\d{2})-/);
    if (!dateMatch) {
        // If we can't parse the date, include the file to be safe
        return true;
    }

    const [, year, month, day] = dateMatch;
    const fileDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Reset hours to compare just dates
    fileDate.setHours(0, 0, 0, 0);
    oneWeekAgo.setHours(0, 0, 0, 0);

    return fileDate >= oneWeekAgo;
}

// Returns all files, and new files, returning the full path
export function watchDirectory(dirPath: string): AsyncIterable<string> {
    const { iterable, push, close } = createAsyncIterable<string>();
    const seenFiles = new Set<string>();

    // Initialize by reading existing files and setting up watcher
    void (async () => {
        const watcher = fs.watch(dirPath, { persistent: false });

        watcher.on("change", async (eventType, filename) => {
            if (eventType === "rename" && filename && typeof filename === "string") {
                const fullPath = path.join(dirPath, filename);
                try {
                    const stat = await fsPromises.stat(fullPath);
                    if (stat.isFile() && !seenFiles.has(filename) && isFileWithinLastWeek(filename)) {
                        seenFiles.add(filename);
                        push(fullPath);
                    }
                } catch (err) {
                    // File was deleted or doesn't exist, ignore
                }
            }
        });

        const existingFiles = await fsPromises.readdir(dirPath);
        for (const file of existingFiles) {
            const fullPath = path.join(dirPath, file);
            const stat = await fsPromises.stat(fullPath);
            if (stat.isFile() && !seenFiles.has(file) && isFileWithinLastWeek(file)) {
                seenFiles.add(file);
                push(fullPath);
            }
        }
        console.log(`[LogWatcher] Finished loading ${existingFiles.length} files`);
    })();

    return iterable;
}

export function watchFile(filePath: string): AsyncIterable<string> {
    const { iterable, push, close } = createAsyncIterable<string>();
    let lastSize = 0;
    let buffer = "";
    // fs.watch fires change events faster than we can read, and the old re-entrant handler let concurrent reads corrupt lastSize/buffer (overlapping byte ranges spliced mid-line, e.g. producing year-20226 timestamps). All reads must go through this single non-re-entrant drain.
    let draining = false;
    let pendingChange = false;

    async function drain(): Promise<void> {
        if (draining) {
            pendingChange = true;
            return;
        }
        draining = true;
        try {
            do {
                pendingChange = false;
                while (true) {
                    const stat = await fsPromises.stat(filePath);
                    if (stat.size <= lastSize) break;
                    const bytesToRead = stat.size - lastSize;
                    const fd = await fsPromises.open(filePath, "r");
                    let bytesRead = 0;
                    try {
                        const readBuffer = Buffer.allocUnsafe(bytesToRead);
                        const result = await fd.read(readBuffer, 0, bytesToRead, lastSize);
                        bytesRead = result.bytesRead;
                        if (bytesRead > 0) {
                            lastSize += bytesRead;
                            const newData = buffer + readBuffer.toString("utf8", 0, bytesRead);
                            const lines = newData.split("\n");
                            // Keep the last incomplete line in the buffer
                            buffer = lines.pop() || "";
                            for (const line of lines) {
                                push(line);
                            }
                        }
                    } finally {
                        await fd.close();
                    }
                    if (bytesRead <= 0) break;
                }
            } while (pendingChange);
        } catch (err) {
            // File might have been deleted or is being written to; the next change event retries
        } finally {
            draining = false;
        }
    }

    void (async () => {
        try {
            const watcher = fs.watch(filePath, { persistent: false });
            watcher.on("change", (eventType) => {
                if (eventType === "change") {
                    void drain();
                }
            });
        } catch (err) {
            console.error(`[LogWatcher] Failed to watch ${filePath}:`, (err as Error).stack ?? err);
        }
        // Initial content goes through the same drain as change events, so there is no separate read path to race against
        await drain();
    })();

    return iterable;
}
const MAX_FUTURE_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

type ObjectUnknown = Record<string, unknown>;
// Ignores lines that can't be JSON parsed. 
export function linesToObjects(lines: AsyncIterable<string>): AsyncIterable<ObjectUnknown> {
    const { iterable, push, close } = createAsyncIterable<ObjectUnknown>();

    void (async () => {
        try {
            for await (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (typeof obj === "object" && obj !== null) {
                        push(obj);
                    }
                } catch (err) {
                    // Ignore lines that can't be JSON parsed
                }
            }
        } finally {
            close();
        }
    })();

    return iterable;
}
export function objectsToObservable(
    objects: AsyncIterable<ObjectUnknown>,
    observable: Record<string, ObjectUnknown>,
    // If the key isn't a string or number, then we just ignore this object. 
    getKey: (object: ObjectUnknown) => unknown,
    // Only accepts the most recent time
    getTime: (object: ObjectUnknown) => number,
) {
    void (async () => {
        for await (const obj of objects) {
            const key = getKey(obj);
            if (typeof key === "string" || typeof key === "number") {
                const time = getTime(obj);
                if (!Number.isFinite(time)) {
                    console.warn(`[objectsToObservable] Rejecting unparseable timestamp for key ${key}: raw time value ${time}, object ${JSON.stringify(obj)}`);
                    continue;
                }
                // A corrupted line with a far-future timestamp would win "newest wins" forever, freezing the key on garbage until restart — so implausible futures are rejected before they can be stored.
                const now = Date.now();
                if (time > now + MAX_FUTURE_TIMESTAMP_SKEW_MS) {
                    console.warn(`[objectsToObservable] Rejecting far-future timestamp for key ${key}: object time ${new Date(time).toISOString()}, now ${new Date(now).toISOString()}, object ${JSON.stringify(obj)}`);
                    continue;
                }
                let prev = observable[key];
                if (prev && getTime(prev) > time) {
                    continue;
                }
                observable[key] = obj;
            }
        }
    })();
}