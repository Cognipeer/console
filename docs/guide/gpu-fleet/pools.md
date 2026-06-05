# Pools & Load Balancing

Pool, **aynı modeli serve eden** N deployment'ı tek bir OpenAI-compatible endpoint
arkasına koyar. Tipik kullanım:

> "Qwen 2.5 72B'yi 6 makinede ayağa kaldıracağım, uygulamalarım sadece tek endpoint görsün."

## Pool yaratmanın iki yolu

### A. Bulk deploy (önerilen — yeni model + yeni pool)

`Pools → Bulk deploy model`:

1. **Model** seç (library'den).
2. **Hostlar** — sadece online ve uyumlu olanlar listelenir. Checkbox + slice picker.
3. **Pool name** + algoritma → **Deploy**.

Tek atomik çağrı: N deployment yaratılır, hepsi pool'a otomatik üye olur. Mid-flight
failure'da otomatik **rollback** (kısmen yaratılmış deployment'lar geri alınır).

### B. Mevcut deployment'ları gruplama

Önceden deploy ettiğin aynı-modelli deployment'lar varsa:

1. `Pools` sayfasında **Bulk deploy** yerine `POST /api/gpu-fleet/pools` ile boş bir pool yarat.
2. Pool detail → **Add member** → aynı `modelName` ile uyumlu deployment'lar candidate
   olarak listelenir.

## Load-balancing algoritmaları

| Algoritma | Davranış | Ne zaman kullan? |
|---|---|---|
| **Round-robin** | Sırayla her üyeye bir istek. | Default. Eşit donanım, kabaca eşit yük. |
| **Least-busy** | `vllm:num_requests_running` en düşük olanı seç. | Uzun kuyruk derinliği değişen workload (chat). |
| **Weighted-static** | Üye başına ağırlık. | Heterojen donanım (A100 80GB + A100 40GB karışık). |
| **Random** | Rastgele. | Sadece debug/test. |

Algoritma pool detail'inde Select'ten anlık değişir. **In-flight istek etkilenmez**;
yeni istekler yeni algoritmayla seçilir.

### Least-busy nasıl çalışır?

1. Pool üyelerinin her birinin `inferenceServerKey`'inden son metrics snapshot çekilir
   (`numRequestsRunning`).
2. En küçük değer kazanır. Birden fazla üye aynı değerdeyse round-robin (tie-break).
3. Hiçbir üyede metrics yoksa (yeni deployment) round-robin'e düşer.

Metrics `inferenceMonitoring` poller'ından beslenir (varsayılan 60 sn poll). Daha hızlı
reaksiyon için poll interval'i azaltabilirsin.

### Weighted-static örneği

İki A100 80GB + dört A100 40GB:

```
weights: {
  "deployment-a100-80-1": 4,
  "deployment-a100-80-2": 4,
  "deployment-a100-40-1": 1,
  "deployment-a100-40-2": 1,
  "deployment-a100-40-3": 1,
  "deployment-a100-40-4": 1,
}
```

İstekler ~%67 büyük makinelere, ~%33 küçük makinelere düşer.

Pool detail'inde algoritma `weighted-static` olduğunda her üye satırında bir
NumberInput çıkar → değiştir → kaydetmen gerekmez (anında patch'lenir).

## Endpoint

Pool yaratıldığı anda hazır:

```
POST https://console.example.com/api/internal/gpu-pool/<poolKey>/v1/chat/completions
Authorization: Bearer <tenant-api-token>
content-type: application/json

{ "model": "Qwen/Qwen2.5-72B-Instruct", "messages": [...] }
```

Streaming, embeddings, listing — vLLM'in OpenAI uyumlu sub-path'leri olduğu gibi geçer.

Bu endpoint **Bearer token** ister; geçerli bir tenant API token üret (`Settings →
API Tokens`) veya pool'u **Publish to Model Hub** et (sonraki bölüm).

## Model Hub'a publish

Pool detail → **Publish to Model Hub**:

1. Modality seç (LLM / Embedding / STT / TTS / OCR).
2. **Publish** → console iki şey yapar:
   - Tenant scope'unda yeni bir **API token** mint eder.
   - **IProvider** (`openai-compatible`, `baseUrl = pool URL`, `apiKey = mint edilen token`)
     ve **IModel** (`modelId = pool's modelName`) kayıtları açar.
3. UI sana mint edilen token'ı **bir kez** gösterir. Provider'da encrypted saklanır.

Bu noktadan sonra normal **Model Hub** akışı içinde pool, sıradan bir provider
gibi davranır. Agent'lar `models/v1/chat/completions` çağrısı yaparken pool'a
yönlenir.

::: tip Token kaybedersen
Pool detail'inden tekrar publish yapamazsın (zaten kayıtlı). Pool'u silip yeniden
yarat veya provider'ı `Providers` sayfasından elle güncelle.
:::

## Member yönetimi

- **Add member** — aynı modelName'i serve eden ve henüz pool'a dahil olmayan
  deployment'ları listeler. Multi-pool desteği var: bir deployment birden çok
  pool'a üye olabilir.
- **Remove member** — pool'dan çıkarır, container çalışmaya devam eder. Tekrar eklemek
  istersen add-member modalına geri döner.
- **Delete pool** — sadece pool kaydını siler. Member deployment'lar çalışmaya
  devam eder. Onlar da gitsin istersen önce **Stop** + **Delete** at her bir
  deployment'a (gelecekte: "delete with members" toggle).

## Sağlıklı vs unhealthy üye davranışı

- Pool **sadece healthy** üyelere request gönderir.
- Unhealthy/draining üyeler atlanır.
- Hiç healthy üye yoksa → `503 Pool has no healthy members`.
- Üye sayısı yetersizleştiğinde alert kuralı kurabilirsin (bkz. Alerts entegrasyonu).

## Pool ↔ Cluster davranışı

Pool proxy `console` process'inin içinde çalışır. Multi-node cluster'da:

- Her node DB'den aynı pool listesini görür → her node proxy yapabilir.
- Round-robin cursor'ı **per-process** in-memory. 6 üyeli pool'da 3 node varsa her
  node'da cursor ayrı; load distribütion makro düzeyde uniform kalır.
- Bu, küçük pool'larda hafif unfairness yaratabilir. Önemli ölçek için
  `least-busy` algoritmasına geç — o **DB-backed** karar verir, node-shared olur.

## Best practice'ler

- **6+ üye** kullan least-busy ile → fluktuasyona dayanıklı.
- vLLM'i `--max-num-seqs` ile sınırla → her üye predictable queue depth verir.
- **Publish** etmeden önce 1-2 deployment'ı healthy olmasını bekle → boş pool publish edersen
  sonradan üye eklemek zorundasın.
- Pool için ayrı bir tenant API token tut → audit log temiz olur (`gpu-pool/<key>` etiketi).

## Sonraki adım

→ [MIG Reconfigure](./mig) — A100/H100'de fiziksel GPU'yu parçala.
