# Audio API

OpenAI-compatible audio endpoints for text-to-speech, speech-to-text transcription, and translation to English.

All endpoints share the base path `/api/client/v1` and require a Bearer API token (`cpeer_...`).

## Speech (Text-to-Speech)

Synthesizes spoken audio from input text. Returns raw audio bytes.

### Endpoint

```
POST /api/client/v1/audio/speech
```

### Request

Accepts a JSON body (`Content-Type: application/json`).

```json
{
  "model": "tts-1",
  "input": "The quick brown fox jumped over the lazy dog.",
  "voice": "alloy",
  "response_format": "mp3",
  "speed": 1.0,
  "instructions": "Speak in a calm, measured tone."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | TTS model key |
| `input` | string | Yes | Text to synthesize |
| `voice` | string | No | Voice name. If omitted, the provider falls back to its default voice |
| `response_format` | string | No | One of `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`. Invalid values are ignored and the provider default is used |
| `speed` | number | No | Playback speed multiplier |
| `instructions` | string | No | Free-form delivery/style instructions |

### Response

Raw audio bytes. The `Content-Type` header reflects the produced audio format, and the response includes:

- `Content-Length` — byte length of the audio
- `X-Request-Id` — request correlation ID

### Example

```bash
curl -X POST https://gateway.example.com/api/client/v1/audio/speech \
  -H "Authorization: Bearer cpeer_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-1",
    "input": "Hello world",
    "voice": "alloy",
    "response_format": "mp3"
  }' \
  --output speech.mp3
```

## Transcriptions

Transcribes audio into text in the source language.

### Endpoint

```
POST /api/client/v1/audio/transcriptions
```

### Request

Accepts either `multipart/form-data` (file upload) or `application/json` (base64 audio).

**Multipart form fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | STT model key |
| `file` | file | Yes | Audio file to transcribe |
| `language` | string | No | Source language hint (e.g. `en`) |
| `prompt` | string | No | Optional text to guide the model |
| `response_format` | string | No | Transcript format (e.g. `json`, `text`, `verbose_json`) |
| `temperature` | number | No | Sampling temperature |
| `timestamp_granularities[]` | string (repeatable) | No | One or more of `word`, `segment` |

**JSON body** uses the same fields, with the file supplied as a base64 `audio` object:

```json
{
  "model": "whisper-1",
  "audio": {
    "data": "<base64-encoded audio>",
    "fileName": "speech.mp3",
    "contentType": "audio/mpeg"
  },
  "language": "en",
  "prompt": "",
  "response_format": "json",
  "temperature": 0,
  "timestamp_granularities": ["segment"]
}
```

### Response

JSON containing the transcribed text and a `request_id`:

```json
{
  "text": "The quick brown fox jumped over the lazy dog.",
  "request_id": "req_abc123"
}
```

The exact shape depends on `response_format` (e.g. `verbose_json` adds segment/word detail).

### Example

```bash
curl -X POST https://gateway.example.com/api/client/v1/audio/transcriptions \
  -H "Authorization: Bearer cpeer_your_token" \
  -F model="whisper-1" \
  -F file="@speech.mp3" \
  -F response_format="json"
```

## Translations

Transcribes audio and translates it into English. Same input handling as transcriptions, but `language` and `timestamp_granularities[]` are not used.

### Endpoint

```
POST /api/client/v1/audio/translations
```

### Request

Accepts either `multipart/form-data` (file upload) or `application/json` (base64 audio).

**Multipart form fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | STT model key |
| `file` | file | Yes | Audio file to translate |
| `prompt` | string | No | Optional text to guide the model |
| `response_format` | string | No | Transcript format (e.g. `json`, `text`, `verbose_json`) |
| `temperature` | number | No | Sampling temperature |

The JSON body form mirrors transcriptions, supplying the audio as a base64 `audio` object.

### Response

JSON containing the English text and a `request_id`:

```json
{
  "text": "The quick brown fox jumped over the lazy dog.",
  "request_id": "req_abc123"
}
```

### Example

```bash
curl -X POST https://gateway.example.com/api/client/v1/audio/translations \
  -H "Authorization: Bearer cpeer_your_token" \
  -F model="whisper-1" \
  -F file="@speech_fr.mp3" \
  -F response_format="json"
```

## Provider Notes

Audio requests are routed to the underlying provider by the `model` key. For Azure-backed providers, audio endpoints are resolved by deployment rather than by model name, so a deployment must exist for the requested capability — for example, a cluster without a configured TTS deployment cannot serve `/audio/speech`. Ensure the target model maps to a deployment that supports the requested audio operation.

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing/invalid required fields (`model`, `input`, `file`/`audio.data`) or unsupported `Content-Type` |
| 401 | Invalid API token |
| 429 | Rate limit, budget, or per-request quota exceeded |
| 500 | Inference error |
| 503 | Service is shutting down |
