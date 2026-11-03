import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { MAX_FUTURE_TIMESTAMP_SKEW_MS } from "./logWatcher";

export const RECORDING_DIRECTORY = "recordings";
export const RECORDING_EXTENSION = ".smartrec";
const RECORDING_MAGIC = "SMARTREC";
const RECORDING_VERSION = 1;
const TAG_TYPE_DEFINITION = 0;
const TAG_STRING_DEFINITION = 1;
const FIRST_TYPE_ID = 2;
const MAX_TYPE_ID = 255;
const FILES_TO_SCAN_AT_STARTUP = 2;
const SENSOR_KIND = "sensor";
const PROCESS_START_KIND = "process_start";

const RECORDING_LAYOUT = [
    `File starts with the ASCII magic "${RECORDING_MAGIC}", then a u32 LE byte length, then this header as UTF-8 JSON.`,
    "Then records until the end of the file. Each record starts with a u8 tag. All integers and floats are little endian.",
    `Tag ${TAG_TYPE_DEFINITION}: type definition. u32 byte length, then UTF-8 JSON { typeId, kind, fields: [{ name, type }] }. Appears before the first record that uses typeId.`,
    `Tag ${TAG_STRING_DEFINITION}: string definition. u32 string index, u32 byte length, then the UTF-8 string. Appears before the first record that uses the index.`,
    `Tag ${FIRST_TYPE_ID}-${MAX_TYPE_ID}: a record of that typeId. Fields follow in definition order. f64 is 8 bytes, bool is 1 byte (0 or 1), string and json are a u32 string index (json strings hold JSON.stringify of the value).`,
    "Every record has a time field, in milliseconds since the Unix epoch.",
];

type FieldType = "f64" | "bool" | "string" | "json";
type FieldDefinition = { name: string; type: FieldType };
type TypeDefinition = { typeId: number; kind: string; fields: FieldDefinition[] };
export type RecordingHeader = {
    format: string;
    version: number;
    createdTime: number;
    pid: number;
    reason: string;
    layout: string[];
};
export type RecordedEvent = { kind: string; values: Record<string, unknown> };
export type DecodedRecording = {
    header: RecordingHeader;
    types: TypeDefinition[];
    events: RecordedEvent[];
    truncatedBytes: number;
};

function getFieldType(value: unknown): FieldType {
    if (typeof value === "number") return "f64";
    if (typeof value === "boolean") return "bool";
    if (typeof value === "string") return "string";
    return "json";
}

function formatFileTimestamp(time: number) {
    let date = new Date(time);
    let pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function getLocalDay(time: number) {
    let date = new Date(time);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function lengthPrefixed(text: string) {
    let bytes = Buffer.from(text, "utf8");
    let length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
}

class RecordingFile {
    public readonly day: string;
    private stream: fs.WriteStream;
    private types = new Map<string, TypeDefinition>();
    private strings = new Map<string, number>();
    private nextTypeId = FIRST_TYPE_ID;

    constructor(public readonly filePath: string, createdTime: number, reason: string) {
        this.day = getLocalDay(createdTime);
        this.stream = fs.createWriteStream(filePath, { flags: "wx" });
        this.stream.on("error", (error) => {
            console.error(`[pid ${process.pid}] Recording write error on ${filePath}:`, error.stack ?? error);
        });
        let header: RecordingHeader = {
            format: "smart-recording",
            version: RECORDING_VERSION,
            createdTime,
            pid: process.pid,
            reason,
            layout: RECORDING_LAYOUT,
        };
        this.stream.write(Buffer.concat([Buffer.from(RECORDING_MAGIC, "ascii"), lengthPrefixed(JSON.stringify(header))]));
    }

    public isFull() {
        return this.nextTypeId > MAX_TYPE_ID;
    }

    public write(kind: string, values: Record<string, unknown>) {
        let fields: FieldDefinition[] = [];
        for (let [name, value] of Object.entries(values)) {
            if (value === undefined) continue;
            fields.push({ name, type: getFieldType(value) });
        }
        let parts: Buffer[] = [];
        let signature = JSON.stringify([kind, fields]);
        let type = this.types.get(signature);
        if (!type) {
            type = { typeId: this.nextTypeId++, kind, fields };
            this.types.set(signature, type);
            console.log(`[pid ${process.pid}] Recording new type ${type.typeId} for kind ${kind} in ${this.filePath}, fields ${JSON.stringify(fields)}`);
            parts.push(Buffer.from([TAG_TYPE_DEFINITION]), lengthPrefixed(JSON.stringify(type)));
        }
        let body: Buffer[] = [Buffer.from([type.typeId])];
        for (let field of fields) {
            let value = values[field.name];
            if (field.type === "f64") {
                let bytes = Buffer.alloc(8);
                bytes.writeDoubleLE(value as number, 0);
                body.push(bytes);
            } else if (field.type === "bool") {
                body.push(Buffer.from([value ? 1 : 0]));
            } else {
                let text = field.type === "string" ? value as string : JSON.stringify(value);
                let index = this.strings.get(text);
                if (index === undefined) {
                    index = this.strings.size;
                    this.strings.set(text, index);
                    let indexBytes = Buffer.alloc(4);
                    indexBytes.writeUInt32LE(index, 0);
                    parts.push(Buffer.from([TAG_STRING_DEFINITION]), indexBytes, lengthPrefixed(text));
                }
                let bytes = Buffer.alloc(4);
                bytes.writeUInt32LE(index, 0);
                body.push(bytes);
            }
        }
        this.stream.write(Buffer.concat([...parts, ...body]));
    }

    public close() {
        this.stream.end();
    }
}

export function decodeRecording(buffer: Buffer): DecodedRecording {
    let magic = buffer.toString("ascii", 0, RECORDING_MAGIC.length);
    if (magic !== RECORDING_MAGIC) {
        throw new Error(`Not a recording, expected magic ${RECORDING_MAGIC}, got ${JSON.stringify(magic)}`);
    }
    let offset = RECORDING_MAGIC.length;
    let headerLength = buffer.readUInt32LE(offset);
    offset += 4;
    let header: RecordingHeader = JSON.parse(buffer.toString("utf8", offset, offset + headerLength));
    offset += headerLength;
    let types = new Map<number, TypeDefinition>();
    let strings: string[] = [];
    let events: RecordedEvent[] = [];
    let recordStart = offset;
    try {
        while (offset < buffer.length) {
            recordStart = offset;
            let tag = buffer.readUInt8(offset);
            offset += 1;
            if (tag === TAG_TYPE_DEFINITION) {
                let length = buffer.readUInt32LE(offset);
                offset += 4;
                if (offset + length > buffer.length) throw new RangeError("Type definition past end of file");
                let type: TypeDefinition = JSON.parse(buffer.toString("utf8", offset, offset + length));
                offset += length;
                types.set(type.typeId, type);
                continue;
            }
            if (tag === TAG_STRING_DEFINITION) {
                let index = buffer.readUInt32LE(offset);
                let length = buffer.readUInt32LE(offset + 4);
                offset += 8;
                if (offset + length > buffer.length) throw new RangeError("String definition past end of file");
                strings[index] = buffer.toString("utf8", offset, offset + length);
                offset += length;
                continue;
            }
            let type = types.get(tag);
            if (!type) {
                throw new Error(`Record at byte ${recordStart} uses undefined type ${tag}`);
            }
            let values: Record<string, unknown> = {};
            for (let field of type.fields) {
                if (field.type === "f64") {
                    values[field.name] = buffer.readDoubleLE(offset);
                    offset += 8;
                } else if (field.type === "bool") {
                    values[field.name] = buffer.readUInt8(offset) !== 0;
                    offset += 1;
                } else {
                    let text = strings[buffer.readUInt32LE(offset)];
                    offset += 4;
                    values[field.name] = field.type === "string" ? text : JSON.parse(text);
                }
            }
            events.push({ kind: type.kind, values });
        }
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return { header, types: [...types.values()], events, truncatedBytes: buffer.length - recordStart };
    }
    return { header, types: [...types.values()], events, truncatedBytes: 0 };
}

export async function listRecordingFiles(): Promise<string[]> {
    if (!fs.existsSync(RECORDING_DIRECTORY)) return [];
    let names = await fsPromises.readdir(RECORDING_DIRECTORY);
    return names.filter(name => name.endsWith(RECORDING_EXTENSION)).sort();
}

let currentFile: RecordingFile | undefined;
let lastSensorTimes = new Map<string, number>();
let recordingStartTime = 0;

function openFile(time: number, reason: string) {
    if (currentFile) {
        currentFile.close();
    }
    let filePath = path.join(RECORDING_DIRECTORY, `${formatFileTimestamp(time)}-pid${process.pid}${RECORDING_EXTENSION}`);
    console.log(`[pid ${process.pid}] Opening recording file ${filePath} (${reason}) at ${new Date(time).toISOString()}`);
    currentFile = new RecordingFile(filePath, time, reason);
    return currentFile;
}

export async function startRecording() {
    recordingStartTime = Date.now();
    await fsPromises.mkdir(RECORDING_DIRECTORY, { recursive: true });
    let files = await listRecordingFiles();
    for (let name of files.slice(-FILES_TO_SCAN_AT_STARTUP)) {
        let filePath = path.join(RECORDING_DIRECTORY, name);
        let decoded = decodeRecording(await fsPromises.readFile(filePath));
        if (decoded.truncatedBytes) {
            console.warn(`[pid ${process.pid}] Recording ${filePath} ends with ${decoded.truncatedBytes} bytes of a partial record, ignoring them`);
        }
        for (let event of decoded.events) {
            if (event.kind !== SENSOR_KIND) continue;
            let key = String(event.values.id);
            let time = event.values.time as number;
            lastSensorTimes.set(key, Math.max(lastSensorTimes.get(key) ?? 0, time));
        }
    }
    let lastTimes = [...lastSensorTimes.entries()].map(([id, time]) => `${id} at ${new Date(time).toISOString()}`);
    console.log(`[pid ${process.pid}] Recording started at ${new Date(recordingStartTime).toISOString()}, scanned ${Math.min(files.length, FILES_TO_SCAN_AT_STARTUP)} of ${files.length} existing files, last recorded sensor readings: ${lastTimes.join(", ") || "none"}`);
    openFile(recordingStartTime, "process start");
    recordEvent(PROCESS_START_KIND, { time: recordingStartTime, pid: process.pid });
}

export function recordEvent(kind: string, values: { time: number } & Record<string, unknown>) {
    if (!currentFile) {
        console.error(`[pid ${process.pid}] Dropping ${kind} event at ${new Date(values.time).toISOString()} because recording has not started: ${JSON.stringify(values)}`);
        return;
    }
    let now = Date.now();
    if (getLocalDay(now) !== currentFile.day) {
        openFile(now, `day changed from ${currentFile.day} to ${getLocalDay(now)}`);
    } else if (currentFile.isFull()) {
        openFile(now, `type ids exhausted in ${currentFile.filePath}`);
    }
    currentFile!.write(kind, values);
}

function recordSensorReading(object: Record<string, unknown>) {
    if (typeof object.model !== "string") return;
    let time = +new Date(String(object.time));
    if (!Number.isFinite(time) || time > Date.now() + MAX_FUTURE_TIMESTAMP_SKEW_MS) return;
    let key = String(object.id);
    let lastTime = lastSensorTimes.get(key) ?? recordingStartTime;
    if (time <= lastTime) return;
    lastSensorTimes.set(key, time);
    recordEvent(SENSOR_KIND, { ...object, time });
}

export async function* recordSensorReadings(objects: AsyncIterable<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
    for await (const object of objects) {
        recordSensorReading(object);
        yield object;
    }
}
