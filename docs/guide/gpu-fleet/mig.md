# MIG Reconfigure

NVIDIA A100 / H100 / H200 / B100 sınıfı GPU'larda **MIG (Multi-Instance GPU)** desteği
var. Bir A100 80GB'yi mantıksal olarak:

- 1× full GPU (default, MIG off)
- 1× 7g.80gb (whole card as 1 MIG slice)
- 2× 3g.40gb
- 3× 2g.20gb + 1× 1g.10gb
- 7× 1g.10gb (max instances)

şeklinde parçalayabilirsin. Her parça VRAM ve compute cores açısından izole;
container birbirinin GPU'sunu göremez.

## Ne zaman MIG?

✅ İyi kullanım:
- Birden çok küçük model (7B) tek bir 80GB GPU'da çalıştır.
- Test/dev için izolasyon (bir takıma 1g.10gb, diğerine 2g.20gb).
- Maliyet/throughput optimizasyonu (4× 7B parallel vs 1× 72B).

❌ Kötü kullanım:
- Tek bir büyük modeli (Qwen 72B) zaten kullanıyorsan — MIG faydası yok, full GPU bırak.
- Çok bursty workload — MIG instance'lar arası migration yok.

## Destructive operation

::: warning Bilgi kaybı yok ama in-flight istek kaybı var
MIG'i değiştirmek, o GPU üzerindeki **tüm CUDA context'lerini sonlandırır**.
Console önce bound deployment'ları drain eder, ama in-flight istek (chat completion stream)
kesilir. Üretim trafiği varken zamanlamayı dikkatle seç.
:::

## UI akışı

Host detail → **Reconfigure MIG**:

1. **Target GPU** seç (MIG-capable olanlar listede; T4/V100 görünmez).
2. **Layout** preset seç:
   - **Disable MIG (full GPU)** — bütün card tek slice
   - **1× 7g.80gb (whole card as one MIG)** — tek instance, MIG on
   - **2× 3g.40gb**
   - **3× 2g.20gb + 1× 1g.10gb**
   - **7× 1g.10gb (max instances)**
3. **Apply layout** → UI sana ne kadar deployment'ın drain edileceğini gösterir.

Console arka planda:

1. O GPU'ya bağlı deployment'ları bul.
2. `actualState = draining`, `desiredState = stopped` yap.
3. Agent'a `apply-mig-profile` komutu bas.
4. Agent: bound container'ları durdur → `nvidia-smi mig -dci/-dgi` (mevcutları sil)
   → `nvidia-smi -mig 1` (gerekirse aç) → `nvidia-smi mig -cgi <profiles> -C`.
5. Agent yeni slice'ları probe edip `mig-layout-applied` event'i yayar.
6. Console eski slice rows'unu siler, sonraki heartbeat yeni layout'u getirir.

## Sürede ne beklenir?

- 5-30 saniye arası, drain dahil.
- Network/host'a göre değişir.
- Reboot gerekmez.

## Reconfigure sonrası

Önceki deployment'lar `stopped` durumunda kalır. Yeni slice UUID'lerine bağlamak için:

1. Host detail'de yeni slice listesini gör.
2. Eski deployment'ı **Delete** et (içindeki container zaten yok).
3. **Deploy model** ile yeni slice'a yeniden başlat.

Gelecek versiyonda **auto-rebind** planlı: aynı modeli aynı profil-eşi slice'a otomatik
taşıma.

## CLI parite (geliştiriciler için)

Aynı işlemi agent'sız host'ta manuel:

```bash
# Mevcut MIG instance'ları sil
sudo nvidia-smi mig -i 0 -dci
sudo nvidia-smi mig -i 0 -dgi

# MIG mode aç (gerekirse)
sudo nvidia-smi -i 0 -mig 1

# Yeni profile + compute instance
sudo nvidia-smi mig -i 0 -cgi 3g.40gb,3g.40gb -C

# Görüntüle
nvidia-smi -L
```

Agent aynı komutları çalıştırır; tek fark drain orkestrasyonu.

## MIG yokken yapma

MIG-incapable bir GPU (T4, V100, 4090, RTX A6000) MIG UI'da gizlidir. Apple Silicon
ve CPU host'larda MIG kavramı yoktur — MIG modal "no MIG-capable GPUs" gösterir.

## Sonraki adım

→ [Terminal Access](./terminal) — host'ta diagnostik için.
