/**
 * Mistral Voxtral speech. The speech endpoint returns JSON `{ audio_data }`
 * (base64), which this adapter unwraps to raw bytes. The API key is the
 * caller's Mistral connection credential — this module never reads the database.
 */

export class MistralAudioError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MistralAudioError";
    this.status = status;
  }
}

const API_ORIGIN = "https://api.mistral.ai";
const DEFAULT_VOICE = "en_paul_neutral";
const DEFAULT_MODEL = "voxtral-mini-tts-2603";
const TTS_MODELS = new Set([
  "voxtral-mini-tts-2603",
  "voxtral-mini-tts-latest",
  "voxtral-tts-26-03",
]);
const FORMATS = new Set(["mp3", "wav", "pcm", "flac", "opus"]);
const CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/pcm",
  flac: "audio/flac",
  opus: "audio/opus",
};
const OPENAI_VOICE_ALIASES: Record<string, string> = {
  alloy: "en_paul_neutral",
  echo: "en_paul_confident",
  fable: "en_paul_cheerful",
  onyx: "gb_oliver_neutral",
  nova: "gb_jane_neutral",
  shimmer: "fr_marie_neutral",
};

export function resolveMistralVoice(voice: unknown): string {
  const requested = typeof voice === "string" ? voice.trim() : "";
  if (!requested) return DEFAULT_VOICE;
  return OPENAI_VOICE_ALIASES[requested] || requested;
}

export function resolveMistralSpeechModel(model: unknown): string {
  const value = typeof model === "string" ? model.trim() : "";
  if (value === "voxtral-tts-26-03") return DEFAULT_MODEL;
  if (TTS_MODELS.has(value)) return value;
  return DEFAULT_MODEL;
}

export function resolveMistralSpeechFormat(format: unknown): string {
  const value = typeof format === "string" ? format.trim().toLowerCase() : "";
  return FORMATS.has(value) ? value : "mp3";
}

export interface MistralSpeechInput {
  text: string;
  voice?: unknown;
  model?: unknown;
  responseFormat?: unknown;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export async function synthesizeMistralSpeech(
  input: MistralSpeechInput
): Promise<{ bytes: Buffer; contentType: string }> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new MistralAudioError(401, "No credentials for speech provider: mistral");

  const format = resolveMistralSpeechFormat(input.responseFormat);
  const fetchImpl = input.fetchImpl || fetch;
  const response = await fetchImpl(`${API_ORIGIN}/v1/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolveMistralSpeechModel(input.model),
      input: String(input.text || ""),
      voice_id: resolveMistralVoice(input.voice),
      response_format: format,
      stream: false,
    }),
  });

  const contentTypeHeader = response.headers.get("content-type") || "";
  if (response.ok && contentTypeHeader.startsWith("audio/")) {
    return { bytes: Buffer.from(await response.arrayBuffer()), contentType: contentTypeHeader };
  }

  const text = await response.text();
  let payload: {
    audio_data?: unknown;
    audio?: unknown;
    message?: unknown;
    error?: { message?: unknown };
  } | null = null;
  try {
    payload = text ? (JSON.parse(text) as typeof payload) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const raw =
      payload?.message || payload?.error?.message || `Mistral speech failed (${response.status})`;
    throw new MistralAudioError(response.status, String(raw).slice(0, 240));
  }

  const audio = payload?.audio_data || payload?.audio;
  if (typeof audio !== "string" || audio.length < 32) {
    throw new MistralAudioError(502, "Mistral speech response did not contain audio");
  }
  return {
    bytes: Buffer.from(audio, "base64"),
    contentType: CONTENT_TYPES[format] || "audio/mpeg",
  };
}
