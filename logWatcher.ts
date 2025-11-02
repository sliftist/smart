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

// Returns all files, and new files, returning the full path
export function watchDirectory(dirPath: string): AsyncIterable<string> {
    const { iterable, push, close } = createAsyncIterable<string>();
    const seenFiles = new Set<string>();

    // Initialize by reading existing files and setting up watcher
    void (async () => {
        // First, push all existing files
        const existingFiles = await fsPromises.readdir(dirPath);
        for (const file of existingFiles) {
            const fullPath = path.join(dirPath, file);
            const stat = await fsPromises.stat(fullPath);
            if (stat.isFile()) {
                seenFiles.add(file);
                push(fullPath);
            }
        }

        // Then watch for new files
        const watcher = fs.watch(dirPath, { persistent: false });

        watcher.on("change", async (eventType, filename) => {
            if (eventType === "rename" && filename && typeof filename === "string") {
                const fullPath = path.join(dirPath, filename);
                try {
                    const stat = await fsPromises.stat(fullPath);
                    if (stat.isFile() && !seenFiles.has(filename)) {
                        seenFiles.add(filename);
                        push(fullPath);
                    }
                } catch (err) {
                    // File was deleted or doesn't exist, ignore
                }
            }
        });
    })();

    return iterable;
}

export function watchFile(filePath: string): AsyncIterable<string> {
    const { iterable, push, close } = createAsyncIterable<string>();
    let lastSize = 0;
    let buffer = "";

    // Initialize by reading existing content and setting up watcher
    void (async () => {
        // First, read all existing content
        try {
            const data = await fsPromises.readFile(filePath, "utf8");
            lastSize = Buffer.byteLength(data, "utf8");
            const lines = data.split("\n");
            // Keep the last incomplete line in the buffer
            buffer = lines.pop() || "";
            for (const line of lines) {
                push(line);
            }
        } catch (err) {
            // File doesn't exist yet, start with size 0
            lastSize = 0;
        }

        // Then watch for changes
        const watcher = fs.watch(filePath, { persistent: false });

        watcher.on("change", async (eventType) => {
            if (eventType === "change") {
                try {
                    const stat = await fsPromises.stat(filePath);
                    const newSize = stat.size;

                    // Only read if file has grown
                    if (newSize > lastSize) {
                        const bytesToRead = newSize - lastSize;
                        const fd = await fsPromises.open(filePath, "r");
                        const readBuffer = Buffer.allocUnsafe(bytesToRead);
                        await fd.read(readBuffer, 0, bytesToRead, lastSize);
                        await fd.close();

                        lastSize = newSize;

                        // Combine with any incomplete line from before
                        const newData = buffer + readBuffer.toString("utf8");
                        const lines = newData.split("\n");
                        // Keep the last incomplete line in the buffer
                        buffer = lines.pop() || "";

                        // Push all complete lines
                        for (const line of lines) {
                            push(line);
                        }
                    }
                } catch (err) {
                    // File might have been deleted or is being written to, ignore for now
                }
            }
        });
    })();

    return iterable;
}
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
                let prev = observable[key];
                if (prev && getTime(prev) > time) {
                    continue;
                }
                observable[key] = obj;
            }
        }
    })();
}