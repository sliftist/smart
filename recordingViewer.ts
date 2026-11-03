import * as http from "http";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { formatNiceDateTime } from "socket-function/src/formatting/format";
import { timeInHour } from "socket-function/src/misc";
import { decodeRecording, listRecordingFiles, RECORDING_DIRECTORY } from "./recording";

const RECORDING_VIEWER_PORT = 8091;
const RECORDING_VIEWER_PAGE = path.join(__dirname, "recordingViewer.html");
const DEFAULT_VIEW_HOURS = 24;

async function readEvents(from: number, to: number) {
    let names = await listRecordingFiles();
    let files = [];
    let events = [];
    for (let name of names) {
        let filePath = path.join(RECORDING_DIRECTORY, name);
        let buffer = await fsPromises.readFile(filePath);
        let decoded = decodeRecording(buffer);
        let times = decoded.events.map(event => event.values.time as number);
        let firstTime = Math.min(decoded.header.createdTime, ...times);
        let lastTime = Math.max(decoded.header.createdTime, ...times);
        if (lastTime < from || firstTime > to) continue;
        files.push({
            name,
            bytes: buffer.length,
            eventCount: decoded.events.length,
            truncatedBytes: decoded.truncatedBytes,
            header: decoded.header,
            types: decoded.types,
        });
        for (let event of decoded.events) {
            let time = event.values.time as number;
            if (time < from || time > to) continue;
            events.push({ file: name, ...event });
        }
    }
    events.sort((a, b) => (a.values.time as number) - (b.values.time as number));
    return { from, to, files, events };
}

export function startRecordingViewerServer() {
    let server = http.createServer((request, response) => {
        void (async () => {
            try {
                let url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
                if (url.pathname === "/") {
                    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    response.end(await fsPromises.readFile(RECORDING_VIEWER_PAGE));
                    return;
                }
                if (url.pathname === "/events") {
                    let to = Number(url.searchParams.get("to")) || Date.now();
                    let from = Number(url.searchParams.get("from")) || to - DEFAULT_VIEW_HOURS * timeInHour;
                    response.writeHead(200, { "Content-Type": "application/json" });
                    response.end(JSON.stringify(await readEvents(from, to)));
                    return;
                }
                response.writeHead(404, { "Content-Type": "text/plain" });
                response.end(`Not found: ${url.pathname}`);
            } catch (error) {
                console.error(`[pid ${process.pid}] Recording viewer request ${request.url} failed:`, (error as Error).stack ?? error);
                response.writeHead(500, { "Content-Type": "text/plain" });
                response.end(String((error as Error).stack ?? error));
            }
        })();
    });
    server.on("error", (error) => {
        console.error(`[pid ${process.pid}] Recording viewer server error on port ${RECORDING_VIEWER_PORT}:`, error.stack ?? error);
    });
    server.listen(RECORDING_VIEWER_PORT, "0.0.0.0", () => {
        console.log(`[pid ${process.pid}] Recording viewer listening on http://0.0.0.0:${RECORDING_VIEWER_PORT} at ${formatNiceDateTime(Date.now())}`);
    });
}
