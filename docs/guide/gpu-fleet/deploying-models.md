# Deploying Models

Host claim olduktan sonra model deploy etmek için iki yol var:

1. **Host detail** sayfasından tek bir slice'a tek bir deployment.
2. **Pools → Bulk deploy** ile aynı modeli birden çok host'a tek seferde.

## Model kataloğu

`GPU Fleet → Model Marketplace` curated kataloğu kartlar halinde gösterir. Her kart:

- Modality (LLM / Embedding / STT / TTS / OCR)
- Vendor, license, HF repo id
- Minimum + önerilen VRAM
- Compute capability gereksinimi (8.0+ = A100, 7.5+ = T4 ve üzeri, …)
- Supported platforms (NVIDIA / Apple Silicon / CPU)
- Available runtimes (vLLM / TGI / Ollama / TEI / …)

Filtreler (modality + accelerator + search box) hedef kartı bulmana yardımcı olur.
Sadece görüntülemek içindir; deploy butonu yok — deploy host context'i gerektirir.

## Tek-host deploy

Host detail (`GPU Fleet → Overview → host adına tıkla`):

1. **Deploy model** butonuna bas.
2. Model picker'dan model seç. Sadece host accelerator'ıyla uyumlu modeller gelir.
3. **Runtime** seç (vLLM / TGI / Ollama / custom). Library'de tanımlı olanlar otomatik
   gelir.
4. **Slice** seç. Sadece o anda boş slice'lar gelir.
5. **Deployment name** — sonradan kolay tanımak için (örn. `qwen2.5-7b-test`).
6. **Deploy** → console agent'a `apply-deployment` komutu basar.

Akış:

```
console enqueue ──▶ agent long-poll alır ──▶ docker pull <image>
       │                                            │
       └── apply-deployment payload                  ▼
                                              docker run --gpus device=<slice>
                                                     │
                                                     ▼
                                              container healthy 200/health
                                                     │
                                                     ▼
                                       agent event: deployment-state-changed=healthy
                                                     │
                                                     ▼
                              console auto-register IInferenceServer (monitoring)
```

İlk pull genelde dakikalar sürer (vLLM image ~10GB). Status `pulling → starting → healthy`
yolunu izler. `unhealthy` veya `failed` görürsen → host detail'de **lastError** alanını oku.

## Custom (library'de yoksa)

Library'de istediğin model yoksa: aynı modal'da **Custom** seçeneği (henüz UI'da değil —
şimdilik direkt host detail'de **Deploy** formundaki tüm alanları doldur) yerine
`POST /api/gpu-fleet/hosts/:hostId/deployments` ile elle yarat:

```bash
curl -X POST https://console.example.com/api/gpu-fleet/hosts/<hostId>/deployments \
  -H "cookie: $CONSOLE_COOKIE" \
  -H "content-type: application/json" \
  -d '{
    "name": "my-finetune-v1",
    "sliceUuid": "<slice-uuid>",
    "runtime": "vllm",
    "image": "vllm/vllm-openai:v0.6.4",
    "modelName": "my-org/my-finetune",
    "args": ["--model", "my-org/my-finetune", "--gpu-memory-utilization", "0.9"],
    "env": { "HUGGING_FACE_HUB_TOKEN": "hf_..." },
    "port": 8000,
    "healthPath": "/health"
  }'
```

## Health check

vLLM/TGI/TEI `GET /health` → 200 dönerse healthy. Agent her tick'te (15s) probe atar.
Container OOM olur ya da exit ederse → `unhealthy → failed`.

**vLLM yaygın hatalar:**

- `CUDA out of memory` — `--gpu-memory-utilization` çok yüksek, veya model VRAM'e sığmıyor. Library'deki `minVramGiB` değerini kontrol et.
- `Repository not found` — HF repo gated; deployment env'ine `HUGGING_FACE_HUB_TOKEN` koy.
- `OSError: ...flash_attn...` — image tag'i ile model arası uyumsuz; vLLM image'ını güncelle.

Log'a bakmak için **Open terminal → deployment-exec** modu ile container'a gir, ya da
host üstünde `docker logs cognipeer-llm-<deploymentId>`.

## Otomatik kayıtlar (Healthy olunca)

Deployment **healthy** geçtiği anda console otomatik olarak:

- **IInferenceServer** kaydı oluşturur. `Inference Monitoring` sayfası bundan sonra
  `num_requests_running`, `gpu_cache_usage_percent`, throughput vs. metric'leri çekmeye başlar.
- Pool'a üye değilse Model Hub'da otomatik IProvider/IModel kaydı **oluşturulmaz**
  (kasıtlı). Bu kayıt için pool yarat ve **Publish** et — bkz. [Pools](./pools).

## Stop / delete

- **Stop** — desired state = stopped. Container durur, slice serbest kalır,
  inference server kaydı silinir. DB kayıt durur ama deployment row kalır.
- **Delete** — `remove-deployment` agent'a basılır, slice serbest, DB row da silinir.

Stop sonrası tekrar başlatmak için (henüz UI yok): `PATCH .../deployments/:id` ile
`desiredState=running` (gelecek versiyonda buton eklenecek).

## Sonraki adım

→ [Pools & Load Balancing](./pools) — aynı modeli N host'a koy, tek endpoint.
