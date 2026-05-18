# Model Hub — Video Walkthrough (TR)

**Hedef süre:** 2 dakika 30 saniye · **Hedef kitle:** Console'a yeni başlayan platform yöneticileri · **Stil:** Sakin, üst seviye, ekran kaydı + voice-over

Aşağıda her sahne için kayıt sırasında neyi göstereceğin (`EKRAN`), spikerin ne söyleyeceği (`SES`) ve geçişler (`NOT`) tarif edildi. Süreler kümülatif değil, sahne bazlıdır. Kelime sayısı tahmini okuma hızı: dakikada 145–155 kelime.

---

## Sahne 1 — Açılış ve bağlam (0:00 – 0:15)

**EKRAN:** Cognipeer Console giriş sonrası dashboard. Sol menüden **Model Hub**'a tıkla.

**SES:**
> Cognipeer Console üzerinde inference çalıştırmak istediğinizde tek başlangıç noktası Model Hub'dır. Bu kısa videoda yeni bir model uç noktasını nasıl yayına aldığınızı, durumunu nasıl izlediğinizi ve gerektiğinde nasıl güncellediğinizi göstereceğim.

**NOT:** Açılışta sol üstte Cognipeer logosunu, sağ üstte aktif proje ve hesap rozetini bir nefes göster.

---

## Sahne 2 — Genel görünüm ve sayaçlar (0:15 – 0:45)

**EKRAN:** Model Hub liste sayfası. İmleci şu sırayla kartların üzerinde gezdir:
1. Total models / LLM / Embedding / Providers sayaçları
2. Tablo başlığındaki Provider, Type, Status, Calls, Avg latency, Pricing kolonları
3. Sayfanın altındaki Usage analytics kartları

**SES:**
> Üst kısımdaki sayaçlar bu proje altında yayında olan tüm modellerin canlı dökümünü gösteriyor. Soldan sağa: toplam model sayısı, kategoriye göre dağılım, bağlı provider sayısı. Hemen altında uç noktalarınızı tablo halinde görüyorsunuz; statü "Active" olmayan bir model trafik kabul etmez. Sayfanın alt kısmı son onbeş gün boyunca yapılan çağrıların, token kullanımının ve hata oranının özetini veriyor — burası operasyonun nabzıdır.

**NOT:** İmleci hızlı hareket ettirme. Her kartta yarım saniye dur. Tabloda bir satırın üzerine gel ve hafifçe vurgulanmasını göster.

---

## Sahne 3 — Provider listesine geçiş (0:45 – 1:05)

**EKRAN:** Üst toolbar'daki **Browse providers** linkine tıkla. Açılan Providers sayfasında listenin üstündeki **Configured / Active / Errored / Domains** sayaçlarını göster. Mevcut iki sağlayıcı satırını işaretle.

**SES:**
> Model yayınlamadan önce bir sağlayıcı yapılandırmasına ihtiyacınız var. Browse providers ekranında tenant ya da proje seviyesinde tanımladığınız kimlik bilgisi setlerini görüyorsunuz. Driver kolonu hangi contract'ın çalıştığını söyler; Status "active" görünmüyorsa o sağlayıcıya bağlı tüm modeller pre-flight aşamasında reddedilir.

**NOT:** Burada **Add provider**'a TIKLAMA — yeni bir form açmak videoyu uzatır. Sadece butonu göster.

---

## Sahne 4 — Yeni model deploy etme (1:05 – 1:50)

**EKRAN:** Sol breadcrumb'tan Model Hub'a geri dön. Sağ üstteki turkuaz **Create Model** butonuna tıkla. Açılan "Deploy model" modal'ında şu sırayla göster:
1. Provider seçimi (örnek olarak Azure)
2. Display name'i "GPT-4o mini" olarak yaz
3. Model ID alanına "gpt-4o-mini" yaz
4. Category olarak LLM seçili kal
5. Sağ paneldeki pre-flight listesinde tikler yeşile döner

**SES:**
> Yeni bir uç nokta yayına almak için Create Model diyoruz. Bu form üç adımda toplanıyor: hangi sağlayıcının trafiği taşıyacağını, modelin Console içinde nasıl adlandırılacağını ve hangi yetkinliklere izin verildiğini belirliyorsunuz. Sağ taraftaki pre-flight kontrolü her zorunlu alan doldurulduğunda yeşile döner — Create model butonu yalnızca tüm kontroller geçtiğinde aktifleşir. Key alanı OpenAI uyumlu istemcilerin model parametresinde göndereceği değerdir, boş bırakırsanız display name'den otomatik üretilir.

**NOT:** Pricing alanına 0.15 ve 0.6 değerlerini de yaz. Submit ETME — modalı Escape ile kapat. Amaç süreci anlatmak, yeni model bırakmamak.

---

## Sahne 5 — Model detay sayfası (1:50 – 2:15)

**EKRAN:** Modal kapandıktan sonra listede mevcut "GPT-4o mini" satırına tıkla. Detay sayfasında sekmeleri sırayla işaretle: **Overview**, **Playground**, **Configure**, **Logs**, **Usage**. Overview'daki performans grafiğine ve `Endpoint` panelindeki curl bloğuna kameranı çevir.

**SES:**
> Detay sayfası operasyonun günlük durağıdır. Overview sekmesinde son dönem performansı, ortalama gecikme ve doluluk grafiği var. Hemen altında üretilen curl komutunu görüyorsunuz — bunu kopyalayıp bir API token ile birlikte kullanarak modeli üç saniyede deneyebilirsiniz. Playground sekmesi tarayıcı içinde aynı runtime'a bağlı bir sohbet kutusu açar; production trafiği ne yaşıyorsa playground da onu yaşar. Logs sekmesi tracing kayıtlarına bağlanır ve her isteğin promptunu, tamamlamasını ve tool call'larını gösterir.

**NOT:** Curl bloğunun yanındaki **Copy curl** butonunu hafifçe vurgula ama tıklama.

---

## Sahne 6 — Düzenleme ve kapanış (2:15 – 2:30)

**EKRAN:** Sağ üstteki üç noktalı menüden veya Configure sekmesinden **Edit**'e gir. Edit ekranında pricing alanını ve status toggle'ını işaretle. Sonra breadcrumb'tan Model Hub'a dön.

**SES:**
> Sağlayıcı kontratı değiştiğinde — örneğin fiyatlar güncellendiğinde — modeli silmeye gerek yok. Edit ekranından pricing alanını günceller, kaydedersiniz; rapor anında doğru rakamlarla çalışır. Bir incident sırasında bir modeli devre dışı bırakmak isterseniz status'u inactive'e çekmeniz yeterli — runtime saniyeler içinde trafiği reddetmeye başlar. Model Hub'ın özeti bu kadar: sağlayıcıyı tanıt, uç noktayı yayına al, durumu izle, gerektiğinde anında ayarla. Detaylı API dökümanı için sol menüdeki Model Inference sayfasını inceleyin.

**NOT:** Son sahnede Console logosuna geri dön ve bir saniye sabit bekle, sonra fade-out.

---

## Stil notları (kayıt öncesi)

- **Tema:** Light tema kullan (yakaladığımız ekran görüntüleri light); izleyici aynı kontrast eğrisini görür.
- **Pencere boyutu:** 1440×900 (capture-model-hub-screenshots.mjs ile aynı). Ekran kaydında pencereyi tam ekran değil, ortalanmış sabit boyutta tut — UI öğeleri her sahnede aynı yerde kalır.
- **Tıklama göstergesi:** macOS için "Mouse Highlight" veya benzer bir vurgu aracı aç. İmleç tıklamaları belirgin olsun.
- **Tempo:** Cümle aralarında yarım saniye nefes payı bırak. Voice-over'ı kayıt sırasında değil, sonradan eklemek genelde daha temiz çıkar — kaydı sessiz al, sesi script'i okuyarak ayrı pist olarak ekle.
- **Sahne 4'te yazma hızı:** Voice-over "GPT-4o mini" derken alanlara aynı anda yaz; senkron olsun.

## Production aşaması (script dışı)

1. Ekran kaydı: macOS QuickTime veya OBS · 60 fps · pencere yakalama (tam ekran değil).
2. Voice-over: Ayrı pist (Audacity veya Logic). Background music ekleyeceksen -22 dB altında tut.
3. Altyazı: Bu dosyadaki SES bölümleri zaten transkript görevi görüyor; SRT dosyasını sahne sınırlarına göre üretebilirsin.
4. Çıktı: 1080p, H.264, ortalama 6 Mbps. Hedef konum: `docs/public/videos/model-hub.mp4` (config.mts içinden link verilebilir).
