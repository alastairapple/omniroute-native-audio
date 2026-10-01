/**
 * Microsoft Edge Read Aloud over the public speech websocket.
 * No API key. Any `xx-XX-NameNeural` short name is accepted; the dashboard
 * catalog lists the common ones.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import https from "node:https";
import type { Socket } from "node:net";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WIN_EPOCH = 11644473600n;
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
export const EDGE_DEFAULT_VOICE = "en-US-AriaNeural";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const NEURAL_VOICE = /^[a-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z]+)?-[A-Za-z]+Neural$/;

export class EdgeTtsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EdgeTtsError";
    this.status = status;
  }
}

export interface EdgeSocket {
  write(data: Buffer): void;
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "end", listener: () => void): void;
}

type EdgeConnect = (url: URL) => Promise<EdgeSocket>;

let connectOverride: EdgeConnect | null = null;

/** Unit tests inject a socket so synthesis does not open a live websocket. */
export function setEdgeConnectForTests(connect: EdgeConnect | null): void {
  connectOverride = connect;
}

export function secMsGec(nowMs: number = Date.now()): string {
  let ticks = BigInt(Math.floor(nowMs / 1000)) + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10_000_000n;
  return createHash("sha256").update(`${ticks}${TRUSTED_CLIENT_TOKEN}`).digest("hex").toUpperCase();
}

export function edgeRate(speed: unknown): string {
  const value = Number(speed);
  if (!Number.isFinite(value) || value <= 0) return "+0%";
  const percent = Math.max(-50, Math.min(100, Math.round((value - 1) * 100)));
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

export function escapeSsml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function resolveEdgeVoice(voice: unknown, model: unknown): string {
  const voiceValue = typeof voice === "string" ? voice.trim() : "";
  const modelValue = typeof model === "string" ? model.trim() : "";
  if (NEURAL_VOICE.test(voiceValue)) return voiceValue;
  if (NEURAL_VOICE.test(modelValue)) return modelValue;
  return EDGE_DEFAULT_VOICE;
}

function outputFormat(responseFormat: unknown): { output: string; contentType: string } {
  const format = typeof responseFormat === "string" ? responseFormat.toLowerCase() : "mp3";
  if (format === "wav" || format === "pcm") {
    return { output: "riff-24khz-16bit-mono-pcm", contentType: "audio/wav" };
  }
  if (format === "opus" || format === "ogg") {
    return { output: "ogg-24khz-16bit-mono-opus", contentType: "audio/ogg" };
  }
  return { output: "audio-24khz-48kbitrate-mono-mp3", contentType: "audio/mpeg" };
}

function splitText(text: string): string[] {
  const source = Buffer.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    let end = Math.min(offset + 4096, source.length);
    if (end < source.length) {
      const slice = source.subarray(offset, end);
      const splitAt = Math.max(slice.lastIndexOf(0x20), slice.lastIndexOf(0x0a));
      if (splitAt > 0) end = offset + splitAt;
    }
    const chunk = source.subarray(offset, end).toString("utf8").trim();
    if (chunk) chunks.push(chunk);
    const next = end + (end < source.length ? 1 : 0);
    offset = next === offset ? offset + 1 : next;
  }
  return chunks;
}

function socketUrl(): URL {
  const url = new URL(WSS_URL);
  url.searchParams.set("TrustedClientToken", TRUSTED_CLIENT_TOKEN);
  url.searchParams.set("Sec-MS-GEC", secMsGec());
  url.searchParams.set("Sec-MS-GEC-Version", SEC_MS_GEC_VERSION);
  url.searchParams.set("ConnectionId", randomUUID().replace(/-/g, ""));
  return url;
}

function clientFrame(opcode: number, data: Buffer | string): Buffer {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    const source = payload[index] ?? 0;
    const maskByte = mask[index % 4] ?? 0;
    masked[index] = source ^ maskByte;
  }
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function openSpeechSocket(url: URL): Promise<EdgeSocket> {
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Protocol": "synthesize",
          Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "User-Agent": USER_AGENT,
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      (response) => {
        response.resume();
        reject(new EdgeTtsError(502, `Edge TTS handshake failed (${response.statusCode})`));
      }
    );
    request.on("upgrade", (_response, socket: Socket) => resolve(socket));
    request.on("error", () => reject(new EdgeTtsError(502, "Edge TTS connection failed")));
    request.setTimeout(15000, () => {
      request.destroy();
      reject(new EdgeTtsError(504, "Edge TTS timed out"));
    });
    request.end();
  });
}

function headerMap(bytes: Buffer, length: number): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of bytes.subarray(0, length).toString("utf8").split("\r\n")) {
    const index = line.indexOf(":");
    if (index > 0) headers.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return headers;
}

function readServerFrames(buffer: Buffer): {
  frames: { opcode: number; payload: Buffer }[];
  rest: Buffer;
} {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = (buffer[offset] ?? 0) & 0x0f;
    let length = (buffer[offset + 1] ?? 0) & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      header = 10;
    }
    if (buffer.length - offset < header + length) break;
    frames.push({
      opcode,
      payload: Buffer.from(buffer.subarray(offset + header, offset + header + length)),
    });
    offset += header + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function audioFromFrame(raw: Buffer): Buffer | null {
  if (raw.length < 2) return null;
  const headerLength = raw.readUInt16BE(0);
  if (headerLength < 2 || headerLength + 2 > raw.length) return null;
  const headers = headerMap(raw.subarray(2), headerLength);
  if (headers.get("Path") !== "audio" || !headers.get("Content-Type")) return null;
  let start = 2 + headerLength;
  if (raw.subarray(start, start + 2).toString() === "\r\n") start += 2;
  const payload = raw.subarray(start);
  return payload.length > 0 ? payload : null;
}

function ssml(text: string, voice: string, rate: string): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
    `${escapeSsml(text)}</prosody></voice></speak>`
  );
}

async function synthesizeChunk(
  text: string,
  voice: string,
  rate: string,
  output: string,
  connect: EdgeConnect
): Promise<Buffer> {
  const socket = await connect(socketUrl());
  const audio: Buffer[] = [];
  const clock = new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
  socket.write(
    clientFrame(
      0x1,
      `X-Timestamp:${clock}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false",` +
        `"wordBoundaryEnabled":"false"},"outputFormat":"${output}"}}}}\r\n`
    )
  );
  socket.write(
    clientFrame(
      0x1,
      `X-RequestId:${randomUUID().replace(/-/g, "")}\r\nContent-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${clock}Z\r\nPath:ssml\r\n\r\n${ssml(text, voice, rate)}`
    )
  );

  let pending = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new EdgeTtsError(504, "Edge TTS timed out"));
    }, 30000);
    const finish = (fn: (value?: Error) => void, value?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const parsed = readServerFrames(pending);
      pending = Buffer.from(parsed.rest);
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x9) {
          socket.write(clientFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode === 0x8) {
          finish(resolve);
          return;
        }
        if (frame.opcode === 0x1) {
          const separator = frame.payload.indexOf("\r\n\r\n");
          const headers = headerMap(
            frame.payload,
            separator < 0 ? frame.payload.length : separator
          );
          if (headers.get("Path") === "turn.end") finish(resolve);
          continue;
        }
        if (frame.opcode === 0x2) {
          const payload = audioFromFrame(frame.payload);
          if (payload) audio.push(payload);
        }
      }
    });
    socket.on("error", () => finish(reject, new EdgeTtsError(502, "Edge TTS connection failed")));
    socket.on("end", () => finish(resolve));
  });
  if (audio.length === 0) throw new EdgeTtsError(502, "Edge TTS returned no audio");
  return Buffer.concat(audio);
}

export interface EdgeSpeechInput {
  input?: unknown;
  voice?: unknown;
  model?: unknown;
  speed?: unknown;
  response_format?: unknown;
}

export async function synthesizeEdge(
  body: EdgeSpeechInput
): Promise<{ bytes: Buffer; contentType: string }> {
  const text = typeof body.input === "string" ? body.input.trim() : "";
  if (!text) throw new EdgeTtsError(400, "input is required");
  const voice = resolveEdgeVoice(body.voice, body.model);
  const rate = edgeRate(body.speed);
  const format = outputFormat(body.response_format);
  const connect = connectOverride || openSpeechSocket;
  const parts: Buffer[] = [];
  for (const chunk of splitText(text)) {
    parts.push(await synthesizeChunk(chunk, voice, rate, format.output, connect));
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length < 64) throw new EdgeTtsError(502, "Edge TTS returned empty audio");
  return { bytes, contentType: format.contentType };
}
