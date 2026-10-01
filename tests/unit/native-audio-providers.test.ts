import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_SPEECH_PROVIDERS,
  AUDIO_TRANSCRIPTION_PROVIDERS,
  getAllAudioModels,
  getSpeechProvider,
  getTranscriptionProvider,
  parseSpeechModel,
  parseTranscriptionModel,
} from "../../open-sse/config/audioRegistry.ts";
import { handleAudioSpeech } from "../../open-sse/handlers/audioSpeech.ts";
import { handleAudioTranscription } from "../../open-sse/handlers/audioTranscription.ts";
import {
  EDGE_DEFAULT_VOICE,
  edgeRate,
  escapeSsml,
  resolveEdgeVoice,
  secMsGec,
  setEdgeConnectForTests,
  synthesizeEdge,
  type EdgeSocket,
} from "../../open-sse/executors/edgeTts.ts";
import { resolveKokoroSpeechUrl, resolveKokoroVoice } from "../../open-sse/executors/kokoroTts.ts";
import {
  resolveMistralSpeechModel,
  resolveMistralVoice,
  synthesizeMistralSpeech,
} from "../../open-sse/executors/mistralAudio.ts";
import { NOAUTH_PROVIDERS } from "../../src/shared/constants/providers/noauth.ts";

function batchFixture(audio: string): string {
  const inner = JSON.stringify([Buffer.from(audio).toString("base64")]);
  const outer = JSON.stringify([["wrb.fr", "jQ1olc", inner, null, null, null, "generic"]]);
  return `)]}'\n${outer}\n`;
}

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

function audioPayload(bytes: Buffer): Buffer {
  const headers = Buffer.from("Path:audio\r\nContent-Type:audio/mpeg\r\n");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(headers.length, 0);
  return Buffer.concat([length, headers, Buffer.from("\r\n"), bytes]);
}

function fakeEdgeSocket(): EdgeSocket {
  return {
    write() {},
    destroy() {},
    on(event, listener) {
      if (event !== "data") return;
      const audio = Buffer.alloc(80, 7);
      listener(serverFrame(2, audioPayload(audio)));
      listener(serverFrame(1, Buffer.from("Path:turn.end\r\n\r\n")));
    },
  };
}

test("native speech and transcription providers are registered", () => {
  assert.equal(getSpeechProvider("kokoro")?.authType, "none");
  assert.equal(getSpeechProvider("kokoro")?.format, "kokoro");
  assert.equal(getSpeechProvider("edge-tts")?.format, "edge-tts");
  assert.equal(getSpeechProvider("google-tts")?.format, "google-tts");
  assert.equal(getSpeechProvider("mistral")?.format, "mistral-tts");
  assert.equal(getSpeechProvider("mistral-voxtral")?.credentialProviderId, "mistral");
  assert.equal(getSpeechProvider("gtts")?.format, "gtts");
  assert.equal(
    getTranscriptionProvider("mistral")?.baseUrl,
    "https://api.mistral.ai/v1/audio/transcriptions"
  );
  assert.equal(getTranscriptionProvider("mistral-stt")?.credentialProviderId, "mistral");

  assert.deepEqual(parseSpeechModel("kokoro/kokoro"), { provider: "kokoro", model: "kokoro" });
  assert.deepEqual(parseSpeechModel("kkr/af_heart"), { provider: "kokoro", model: "af_heart" });
  assert.deepEqual(parseSpeechModel("edge-tts/edge-tts"), {
    provider: "edge-tts",
    model: "edge-tts",
  });
  assert.deepEqual(parseSpeechModel("edtts/en-US-AriaNeural"), {
    provider: "edge-tts",
    model: "en-US-AriaNeural",
  });
  assert.deepEqual(parseSpeechModel("google-tts/google-translate"), {
    provider: "google-tts",
    model: "google-translate",
  });
  assert.deepEqual(parseSpeechModel("mistral/voxtral-mini-tts-2603"), {
    provider: "mistral",
    model: "voxtral-mini-tts-2603",
  });
  assert.deepEqual(parseTranscriptionModel("mistral/voxtral-mini-latest"), {
    provider: "mistral",
    model: "voxtral-mini-latest",
  });
  assert.equal(parseSpeechModel("edgetts/en-US-AriaNeural").provider, null);

  const kokoroModel = getAllAudioModels().find((model) => model.id === "kokoro/kokoro");
  assert.ok(kokoroModel && "voices" in kokoroModel && kokoroModel.voices.length >= 70);
  assert.equal(NOAUTH_PROVIDERS.kokoro.noAuth, true);
  assert.equal(NOAUTH_PROVIDERS["edge-tts"].serviceKinds[0], "tts");
  assert.equal(NOAUTH_PROVIDERS["google-tts"].noAuth, true);
  assert.equal(AUDIO_SPEECH_PROVIDERS["edge-tts"].authType, "none");
  assert.equal(AUDIO_TRANSCRIPTION_PROVIDERS.mistral.authType, "apikey");
});

test("kokoro speech uses a Kokoro voice and the local engine", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.KOKORO_SPEECH_URL;
  delete process.env.KOKORO_SPEECH_URL;
  let seen: { url: string; body: string } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), body: String(init.body) };
    return new Response(Buffer.from("kokoro-audio"), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  }) as typeof fetch;
  try {
    const response = await handleAudioSpeech({
      body: { model: "kokoro/kokoro", input: "hello", voice: "alloy" },
      credentials: null,
      resolvedProvider: getSpeechProvider("kokoro"),
      resolvedModel: "kokoro",
    });
    assert.equal(response.status, 200);
    assert.equal(seen?.url, "http://127.0.0.1:8880/v1/audio/speech");
    assert.equal(JSON.parse(seen?.body || "{}").voice, "af_alloy");
    assert.equal(resolveKokoroVoice(undefined), "af_heart");
    assert.equal(
      resolveKokoroSpeechUrl("http://engine/v1/audio/speech"),
      "http://engine/v1/audio/speech"
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.KOKORO_SPEECH_URL;
    else process.env.KOKORO_SPEECH_URL = originalUrl;
  }
});

test("google-tts reuses the no-auth translate transport", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    assert.match(String(init.body), /^f\.req=/);
    return new Response(batchFixture("google-audio"), { status: 200 });
  }) as typeof fetch;
  try {
    const response = await handleAudioSpeech({
      body: { model: "google-tts/google-translate", input: "hello", voice: "en" },
      credentials: null,
      resolvedProvider: getSpeechProvider("google-tts"),
      resolvedModel: "google-translate",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "google-audio");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mistral speech posts voice_id and unwraps audio_data", async () => {
  assert.equal(resolveMistralVoice("alloy"), "en_paul_neutral");
  assert.equal(resolveMistralSpeechModel("voxtral-tts-26-03"), "voxtral-mini-tts-2603");
  const audio = Buffer.from("mistral-audio-bytes-that-are-long-enough");
  const result = await synthesizeMistralSpeech({
    text: "hello",
    voice: "fr_marie_neutral",
    model: "voxtral-mini-tts-latest",
    apiKey: "test-key",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      assert.equal(init.headers && init.headers["Authorization"], "Bearer test-key");
      const body = JSON.parse(String(init.body));
      assert.equal(body.voice_id, "fr_marie_neutral");
      assert.equal(body.model, "voxtral-mini-tts-latest");
      assert.equal(body.stream, false);
      return new Response(JSON.stringify({ audio_data: audio.toString("base64") }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  assert.equal(result.bytes.toString(), "mistral-audio-bytes-that-are-long-enough");
  assert.equal(result.contentType, "audio/mpeg");
});

test("mistral speech dispatch does not leak a stack trace", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "bad voice" }), { status: 400 })) as typeof fetch;
  try {
    const response = await handleAudioSpeech({
      body: { model: "mistral/voxtral-mini-tts-2603", input: "hello", voice: "en_paul_neutral" },
      credentials: { apiKey: "test-key" },
      resolvedProvider: getSpeechProvider("mistral"),
      resolvedModel: "voxtral-mini-tts-2603",
    });
    const payload = (await response.json()) as { error: { message: string } };
    assert.equal(response.status, 400);
    assert.match(payload.error.message, /bad voice/);
    assert.equal(payload.error.message.includes("at /"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("edge speech uses the injected socket and defaults the voice", async () => {
  assert.equal(secMsGec(1_700_000_000_000), secMsGec(1_700_000_000_000));
  assert.match(secMsGec(1_700_000_000_000), /^[0-9A-F]{64}$/);
  assert.equal(edgeRate(1.5), "+50%");
  assert.equal(escapeSsml(`a<b>&"'`), "a&lt;b&gt;&amp;&quot;&apos;");
  assert.equal(resolveEdgeVoice("nope", "edge-tts"), EDGE_DEFAULT_VOICE);
  assert.equal(resolveEdgeVoice("en-GB-SoniaNeural", "edge-tts"), "en-GB-SoniaNeural");

  setEdgeConnectForTests(async () => fakeEdgeSocket());
  try {
    const direct = await synthesizeEdge({ input: "hello there", voice: "en-US-AriaNeural" });
    assert.equal(direct.contentType, "audio/mpeg");
    assert.ok(direct.bytes.length >= 64);

    const response = await handleAudioSpeech({
      body: { model: "edge-tts/edge-tts", input: "hello there" },
      credentials: null,
      resolvedProvider: getSpeechProvider("edge-tts"),
      resolvedModel: "edge-tts",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
  } finally {
    setEdgeConnectForTests(null);
  }
});

test("mistral transcription posts multipart to the Mistral API", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let authorization = "";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seenUrl = String(url);
    const headers = init.headers as Record<string, string>;
    authorization = headers.Authorization || "";
    return new Response(JSON.stringify({ text: "hello from omni" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const formData = new FormData();
    formData.set("model", "mistral/voxtral-mini-latest");
    formData.set("file", new File([Buffer.from("RIFF")], "clip.wav", { type: "audio/wav" }));
    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "test-key" },
      resolvedProvider: getTranscriptionProvider("mistral"),
      resolvedModel: "voxtral-mini-latest",
    });
    assert.equal(response.status, 200);
    assert.equal(seenUrl, "https://api.mistral.ai/v1/audio/transcriptions");
    assert.equal(authorization, "Bearer test-key");
    const payload = (await response.json()) as { text: string };
    assert.equal(payload.text, "hello from omni");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
