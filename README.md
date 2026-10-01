# omniroute-native-audio

Native audio providers for OmniRoute, overlaid onto upstream
[diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) and built
into a container image by GitHub Actions.

**This repository is a patch, not a fork.** It contains only the edited files,
mirroring their paths in the OmniRoute tree. The image is built by checking out
upstream OmniRoute at a pinned revision and copying these files over it.

## What this adds

Native providers (not HTTP proxies to the loopback TTS bridge):

| Provider | Endpoint / transport | Models |
| --- | --- | --- |
| `kokoro` | `POST http://127.0.0.1:8880/v1/audio/speech` (local engine) | `tts-1`, `tts-1-hd`, `kokoro`, `gpt-4o-mini-tts` |
| `edge-tts` | `wss://speech.platform.bing.com/.../edge/v1` (WebSocket) | edge-tts voices, default `en-US-AriaNeural` |
| `google-tts` | reuse of `synthesizeGtts` (batchexecute) | `google-translate` |
| `mistral` (speech) | `POST https://api.mistral.ai/v1/audio/speech` | `voxtral-mini-tts-2603`, `voxtral-mini-tts-latest` |
| `mistral` (STT) | `POST https://api.mistral.ai/v1/audio/transcriptions` (multipart) | `voxtral-mini-latest`, `voxtral-mini-2602`, `voxtral-mini-transcribe-realtime-2602` |

Aliases: `kkr`, `edtts`, `gtrans`, and `mistral-voxtral` (shares the `mistral`
API-key connection). All four are registered in the `NOAUTH` table with
`serviceKinds: ["tts"]`. Voices are attached from
`open-sse/config/nativeAudioVoices.ts`.

The retired `edgetts` id is deliberately **not** registered; see
`tests/unit/edgetts-retirement.test.ts`.

## Layout

```
.github/workflows/build-native-audio-image.yml   build + push to ghcr.io
open-sse/config/nativeAudioVoices.ts              voice map
open-sse/config/audioRegistry.ts                   audio provider registry
open-sse/executors/kokoroTts.ts                    kokoro executor
open-sse/executors/edgeTts.ts                     edge-tts executor
open-sse/executors/mistralAudio.ts                mistral speech + STT executor
open-sse/handlers/audioSpeech.ts                   speech dispatch
open-sse/handlers/audioTranscription.ts            transcription dispatch
src/shared/constants/providers/noauth.ts           NOAUTH registrations
src/app/(dashboard)/.../media/MediaPageClient.tsx  dashboard voice presets
src/app/api/v1/models/catalog.ts                   model catalog
tests/unit/native-audio-providers.test.ts          unit tests
scripts/patch-omniroute-container.sh               pull image + redeploy
```

## Image

Built by `.github/workflows/build-native-audio-image.yml` on push to `main`.

- Pinned upstream revision: `fc5e2bccd4f70fecf5aab94dfb8136c74ab5a21b`
- Build args: `OMNIROUTE_BUILD_MEMORY_MB=4096`, `OMNIROUTE_USE_TURBOPACK=0`
- Output: `ghcr.io/alastairapple/omniroute:native-audio` (and `:latest`)

The build runs on GitHub-hosted runners on purpose: the `better-sqlite3` and
Next.js build stages OOM on the 15 GB / 8 GB-swap host this was developed on.

## Deploying

```bash
./scripts/patch-omniroute-container.sh                       # defaults
./scripts/patch-omniroute-container.sh alastairapple/omniroute-native-audio main
```

The script downloads only the overlay paths, pulls the image, and recreates
**only** the `omniroute` service from `/root/omniroute-docker/compose.yaml` using
a compose override for the image tag — the operator's `compose.yaml` is never
rewritten. It preserves `env_file`, the `/root/.omniroute:/app/data` volume,
`network_mode: host`, `user: 0:0`, `mem_limit: 3g`, and `restart: unless-stopped`,
then polls `/api/monitoring/health` until it returns 200.

Requires `docker` and `curl`, plus authenticated `gh` (or `GH_TOKEN`) for the
private-repo download.

## Verification

```bash
node --max-old-space-size=4096 --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit \
  tests/unit/native-audio-providers.test.ts \
  tests/unit/edgetts-retirement.test.ts \
  tests/unit/gtts-provider.test.ts \
  tests/unit/audio-alias-prefix-10586.test.ts
```