/**
 * Local Kokoro FastAPI speech. The engine speaks OpenAI's /audio/speech body,
 * but its voice ids are Kokoro ids (af_heart), not OpenAI names (alloy).
 */

export const KOKORO_DEFAULT_VOICE = "af_heart";
export const KOKORO_DEFAULT_SPEECH_URL = "http://127.0.0.1:8880/v1/audio/speech";

const OPENAI_VOICE_ALIASES: Record<string, string> = {
  alloy: "af_alloy",
  echo: "am_echo",
  fable: "bm_fable",
  onyx: "am_onyx",
  nova: "af_nova",
  shimmer: KOKORO_DEFAULT_VOICE,
};

export function resolveKokoroVoice(voice: unknown): string {
  const value = typeof voice === "string" ? voice.trim() : "";
  if (!value) return KOKORO_DEFAULT_VOICE;
  return OPENAI_VOICE_ALIASES[value] || value;
}

/** KOKORO_SPEECH_URL overrides the registry URL when the engine is not on 8880. */
export function resolveKokoroSpeechUrl(baseUrl: string): string {
  const fromEnv = process.env.KOKORO_SPEECH_URL?.trim();
  const chosen = fromEnv || baseUrl || KOKORO_DEFAULT_SPEECH_URL;
  return chosen.replace(/\/+$/, "");
}
