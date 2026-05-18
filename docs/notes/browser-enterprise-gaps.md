# Browser & Browser Agent — Enterprise/Bankacılık Eksik Analizi

> İnceleme tarihi: 2026-05-17
> Kapsam: `src/lib/services/browser/*`, `src/server/api/plugins/browser*.ts`, `src/lib/database/{mongodb,sqlite}/browser.mixin.ts`, `src/app/dashboard/browser/**`, agent entegrasyonu (`agentService.ts`, `ToolSelectorModal.tsx`).

---

## 1. Mevcut Mimari Özeti

### Bileşenler
- **`BrowserManager`** (`src/lib/services/browser/browserManager.ts`) — Process-wide singleton; Playwright/Chromium'u lazy-launch eder, `BrowserContext + Page` çiftlerini `sessionKey` ile in-memory map'te tutar. Idle reaper background timer ile çalışır.
- **`BrowserSessionService`** — DB persistence + bucket artifact + tenant context köprüsü. Eylem (action) loglarını `browserSessionEvents` koleksiyonuna yazar.
- **`BrowserProfileService`** — `IBrowser` (parent profile) CRUD.
- **`MemoryConcurrencyLimiter`** (`concurrency.ts`) — Tenant başına in-memory semaphore; Redis provider için interface var ama varsayılan in-memory.
- **`agentTools.ts`** — 10 adet SDK tool'unu üretir: `browser_navigate`, `browser_click`, `browser_hover`, `browser_type`, `browser_press`, `browser_wait`, `browser_snapshot`, `browser_extract`, `browser_screenshot`, `browser_close`.
- **API plugin'leri** — `browser.ts` (cookie auth), `client-browser.ts` (token auth), `client-browser-mcp.ts` (SSE MCP endpoint).
- **DB mixin'leri** — Mongo + SQLite için ayrı, aynı domain modeli (`browsers`, `browserSessions`, `browserSessionEvents`).
- **Agent entegrasyonu** — `agentService.ts:229` üzerinde `binding.sourceKey === 'browser_use'` ile system tool olarak bind ediliyor; binding `{ browserId }` taşıyor, agent çalışırken otomatik session yaratıyor, agent tamamlanınca kapatıyor.

### Persist edilen güvenlik-ilgili alanlar
- `IBrowserSessionConfig`: `headless`, `viewport`, `userAgent`, `locale`, `idleTimeoutMs` (max 24h), `maxLifetimeMs` (max 7g), `access: { allowList, blockList }`.
- Cookie / localStorage / kimlik bilgisi DB'de **tutulmuyor** — sadece in-memory `BrowserContext`'te yaşıyor.
- Event log'da typed text `[redacted:N chars]` ile, URL query string ve hash strip edilerek persist ediliyor. `mode='html'` extraction tam HTML'i persist ediyor (zayıf nokta).

### Mevcut güvenlik kontrolleri
- Tenant + project scope check her endpoint'te (`requireProjectContextForRequest` / `getApiTokenContextForRequest`).
- `evaluateBrowserRequestAccess` her network isteğinde (`context.route('**/*', …)`) çağrılıyor: protokol (http/https), allow/block list, private network bloğu (RFC1918, link-local, CGNAT, loopback, IPv6 ULA/link-local).
- DNS lookup sonucu 5 dk cache'leniyor (`HOST_SECURITY_CACHE_TTL_MS`).
- `*` ve `*.example.com` pattern desteği var.
- Codebase'de hazır `encryptObject/decryptObject` utility'si var (`src/lib/utils/crypto.ts`, AES-GCM) — ama browser modülü kullanmıyor.
- `audit` servisi codebase'de mevcut (`src/lib/services/audit/auditService.ts`) ama browser modülü bunu çağırmıyor.
- `guardrail` servisi (PII detector + LLM evaluator) mevcut — browser modülüyle entegre değil.

---

## 2. Tespit Edilen Eksikler (Genel)

### A. Kritik güvenlik açıkları / zayıf yönler

| # | Eksik | Risk | Lokasyon |
|---|---|---|---|
| 1 | Session-seviye RBAC yok — aynı project'teki her kullanıcı her session'a action gönderebiliyor | Yetkisiz session ele geçirme | `browser.ts`, `browserSessionService.ts` |
| 2 | Audit logging yok — kim hangi session'ı açtı/kapadı/komut gönderdi izi tutulmuyor (sadece `createdBy` snapshot) | Compliance kanıtı yok | Tüm service katmanı |
| 3 | DB'de at-rest encryption yok — `currentUrl`, `pageTitle`, `config`, `metadata`, extracted text plaintext | KVKK/GDPR/PCI ihlali riski | `browserSessions`, `browserSessionEvents` |
| 4 | HTML extraction (`mode='html'`) tüm outerHTML'i event `data` alanına yazıyor — form value/secret leak | Veri sızıntısı | `browserManager.ts:466`, `browserSessionService.ts` |
| 5 | Private-network bypass riski: DNS cache 5 dk; cache zehirlenirse rebinding mümkün, host header üzerinden internal hedef vurulabilir | SSRF | `browserManager.ts:674` |
| 6 | Per-session proxy yok — tüm trafik host'un default rotasından çıkıyor (egress firewall'undan geçmiyor) | Audit / network segmentation eksiği | `openSession` |
| 7 | Sandbox profili yok — Chromium `--no-sandbox` veya seccomp profili tanımlanmamış, JS/WASM kötü amaçlı sayfa node process'ini etkileyebilir | RCE riski | `chromium.launch` çağrısı (`browserManager.ts:190`) |
| 8 | Browser session token rotation yok — `sessionKey` ifşa olursa session hijack mümkün (Bearer + sessionKey yeterli) | Session hijack | `runAction` endpoint'leri |
| 9 | Rate limiting yok — bir agent saniyede yüzlerce screenshot/click gönderebilir, hem maliyet hem DoS | Resource abuse | Tüm action endpoint'leri |
| 10 | Concurrency limiter in-memory — multi-node deployment'ta tenant limiti node sayısı kadar genişliyor | Tenant fair-share kırılması | `concurrency.ts` |
| 11 | Reaper sadece local node'un session'larını görüyor — başka node'da terk edilmiş session hiç kapanmıyor | Resource leak | `reapIdleSessions` |
| 12 | Event retention politikası yok — `browserSessionEvents` sınırsız büyüyor, TTL index yok | DB şişmesi, KVKK saklama süresi uyumsuzluğu | DB schema |
| 13 | Console log / network HAR / response body yakalanmıyor — fraud investigation'da delil eksik | Forensic gap | `browserManager.ts` |
| 14 | CSP/Referrer/Permissions-Policy override edilemiyor — internal sayfa açıp external'a postlayan saldırı engellenmemiş | Data exfil | Context options |
| 15 | File download policy yok — agent indirme yapabilir, AV taraması yok, target path yok | Malware ingest | Playwright default download dir |

### B. Eksik özellikler / weak spots

- **Cookie/storage state import/export yok** — kalıcı login state (storageState.json) desteği yok; her session sıfırdan kimlik girmeli.
- **Multi-browser desteği yok** — sadece Chromium. Firefox/WebKit launch interface'te seçilemez.
- **Headful streaming yok** — VNC/WebRTC/CDP-over-WS canlı yayın endpoint'i yok, sadece statik screenshot.
- **İnsan müdahalesi (human-in-the-loop) yok** — CAPTCHA/2FA durumunda pause/resume mekanizması yok.
- **DLP entegrasyonu yok** — extracted text guardrail/PII detector'dan geçmiyor.
- **Session step-up auth yok** — kritik domain'lere (ör. `*.bankaicimerkezi`) gitmeden önce ek doğrulama istenmiyor.
- **Approval workflow yok** — yüksek riskli action'lar (örn. para transferi formuna `type`) için 2-eyes onayı yok.
- **Screenshot retention/versioning yok** — `lastScreenshot` sadece en sonu tutuyor; tam timeline replay imkânı sınırlı.
- **`evaluateBrowserRequestAccess` `goto` ve `route` arasında race** — `goto`'da pre-check var ama redirect chain'de allowList check `context.route` üzerinden gidiyor; iki katmanda kural senkronu manuel.
- **`page.evaluate` `new Function` ile çağrılıyor** (`browserManager.ts:432-434`) — `scroll` action'ında `x`, `y` template literal ile inject ediliyor. Şu an `z.number()` validation var, ama prensip olarak `evaluate(fn, arg)` kullanılmalı.
- **`requireSession` `lastActivityAt`'i her çağrıda set ediyor** — başarısız action'da bile session "alive" kalıyor, attacker idle reaper'ı atlatabilir.
- **`onClose` hook hatası sadece warn loglanıyor** — kalıcı state bozulması fark edilmeyebilir.

---

## 3. Banka / Enterprise için Eklenmesi Önerilen Özellikler

### A. Kimlik, yetkilendirme, segregation of duties

1. **Browser ve session seviyesinde RBAC**
   - `IBrowser` üzerine `accessPolicy: { owners[], operators[], viewers[] }`.
   - Tool binding sırasında agent'ın o browser'a yetkili olduğunun doğrulanması.
   - "Production browser"a sadece onaylı agent'lar bind olabilsin.

2. **Step-up authentication / sensitive-action gating**
   - `IBrowserAccessRules`'a `sensitiveDomains: string[]` ve `requiresApproval: boolean`.
   - Bu domain'lere `goto` öncesi human operator'dan in-app approval (push/email/Slack).
   - "Dual control" (4-eyes / maker-checker) modu — bir kullanıcı başlatır, ikinci kullanıcı onaylayınca action gider.

3. **Time-bound session tokens & ephemeral credentials**
   - `sessionKey` yerine kısa ömürlü JWT (`exp`, `aud=sessionId`, `scope=run|read`).
   - Banka tarafı kimlik vault'undan (HashiCorp Vault / AWS Secrets Manager / HSM) just-in-time credential çekilsin, in-memory'de tutulup session sonunda zeroize edilsin.

4. **mTLS / client certificate desteği**
   - Bankacılık portal'larına mTLS gereken durumlar için `context.newContext({ clientCertificates })` desteklensin.
   - Sertifika storage'ı HSM/PKCS11 ile entegre.

5. **SAML/OAuth federe kimlik bekçisi**
   - Browser kullanıcı adına aksiyon yapacaksa "on-behalf-of" token akışı; her action OBO context'iyle imzalansın.

### B. Compliance, audit ve denetlenebilirlik

6. **İmmutable audit trail**
   - Mevcut `auditService`'i browser'a entegre et: her session create/close, her action, her policy bypass denemesi.
   - Hash-chained log (her event prev_hash içerir) — tamper-evident.
   - Append-only WORM bucket'a kopyalama.

7. **Veri sınıflandırma etiketleri**
   - `IBrowser.metadata`'ya `dataClassification: 'public' | 'internal' | 'confidential' | 'restricted'`.
   - Sınıfa göre retention süresi, screenshot izni, extract içerik yasakları otomatik.

8. **KVKK / GDPR / BDDK saklama politikaları**
   - `browserSessionEvents`'e TTL (Mongo TTL index / scheduled SQL purge).
   - Per-tenant retention config (örn. BDDK için min 10 yıl audit; PII için 6 ay).
   - Right-to-be-forgotten için tenantId + userEmail eşleşmesiyle scrub job.

9. **Compliance reporting / SIEM forward**
   - Syslog / OTel / Splunk HEC adapter'i: tüm browser event'leri SIEM'e stream.
   - SOC 2 / ISO 27001 evidence export şablonları.

10. **Data residency / region pinning**
    - Browser execution node'unu tenant region'a pin'le (TR data → TR node'da run).
    - Cross-region action denemesi reddedilsin.

### C. Veri koruma & gizlilik

11. **At-rest encryption (envelope)**
    - `currentUrl`, `pageTitle`, `errorMessage`, `data`, `metadata` field'ları `encryptObject` ile (var olan `src/lib/utils/crypto.ts`).
    - Per-tenant DEK, master KEK HSM'de (AWS KMS / HSM).
    - Anahtar rotasyonu — eski kayıtlar lazy re-encrypt.

12. **Guardrail entegrasyonu (PII/PCI masking)**
    - `extract` ve `snapshot` çıktısı `guardrail/piiDetector.ts`'den geçsin.
    - IBAN, TCKN, kart numarası (Luhn check), CVV pattern'leri otomatik maskelensin.
    - Maskelenmiş bytes hash'i tutulsun (forensic için), açık metin asla persist edilmesin.

13. **HTML extraction policy**
    - Default'ta `<input value="">`, `<form>`, `<iframe>` content strip.
    - "Sensitive selector" deny-list (örn. `[type=password]`, `[autocomplete=cc-*]`).

14. **Screenshot redaction**
    - Sensitive selector bölgeleri server-side blur (sharp/jimp).
    - "Mask zones" definition per browser profile.

15. **Clipboard / file download policy**
    - Default disabled. İzin verildiğinde:
      - İndirilen dosya AV taraması (ClamAV / CrowdStrike API).
      - SHA256 hash + sandbox detonation entegrasyonu (Cuckoo, Joe Sandbox).
      - Whitelisted MIME / max size.

### D. Ağ segmentasyonu & egress kontrolü

16. **Per-session proxy / egress gateway**
    - `IBrowserSessionConfig.proxy: { server, username, password, bypass }`.
    - Enterprise proxy (Zscaler, Netskope, internal forward proxy) routing.
    - Banka için: kurumsal SWG (Secure Web Gateway) zorunlu.

17. **Strict private network / SSRF defense**
    - DNS pinning: lookup sonucunu session boyunca sabitle, rebinding'i engelle.
    - `Host` header validation.
    - Internal CA-only TLS (sadece bankanın PKI'inden gelen sertifikalar).

18. **Domain category enforcement**
    - 3rd party URL categorization API (Cisco Talos, Symantec) entegrasyonu.
    - "Phishing / malware / gambling" kategorisi otomatik block.

19. **CRL/OCSP zorla, HTTPS-only mode**
    - `ignoreHTTPSErrors: false` (default false zaten ama explicit policy).
    - Self-signed sertifika sadece allowlist'teki internal CN'ler için.

20. **HAR + response body capture (forensic)**
    - Per session HAR file kaydı + encrypted bucket'a upload.
    - Header'lar (Authorization vb.) otomatik redact.

### E. İşletim, gözlemlenebilirlik, dayanıklılık

21. **Distributed concurrency & session ownership**
    - Redis-backed limiter (interface zaten hazır, implementation eksik).
    - Session→node mapping Redis'te, leadership/heartbeat ile başka node'lara fail-over.

22. **Health endpoint & crash recovery**
    - Per-session crash detection; agent runtime'a "session lost" callback.
    - Snapshot-on-error otomatik (son aria-snapshot + screenshot + console logs).

23. **Rate limiting & quota**
    - Per-tenant: action/dakika, screenshot/dakika, total CPU sn.
    - Mevcut `quota` servisini browser action'larına bağla.

24. **Console + network event capture**
    - `page.on('console')`, `page.on('pageerror')`, `page.on('requestfailed')` → event log'a düşür.
    - PerformanceObserver metrikleri (FCP, LCP, TBT) — anomaly detection için baseline.

25. **Anomaly detection / behavioral monitoring**
    - Unusual: kısa süre çok fazla action, normal session'dan farklı domain dağılımı, başarısız `goto` patlaması.
    - Realtime alerting → `alerts` modülüne route.

26. **Resource limits per session**
    - Chromium `--js-flags="--max-old-space-size=512"`, `--memory-pressure-off=false`.
    - cgroups / Docker container per session (heavy ama bank-grade isolation için gerekli).

### F. İnsan müdahalesi & operasyonel akışlar

27. **Live session takeover (operator handoff)**
    - WebSocket üzerinden operator browser'ı görüp kontrolü alabilsin (mouse/keyboard inject).
    - Mevcut MCP plugin'i baseline; üstüne CDP relay endpoint.

28. **CAPTCHA / 2FA pause-resume**
    - Action sonucunda `requiresHumanInput: true` flag → agent waits.
    - In-app inbox, operator çözer/2FA kodu girer, session devam eder.
    - Tüm "human input" event'leri ayrıca audit'lensin.

29. **Persistent storage profile (vault'lu)**
    - `storageStateRef` — cookie/localStorage encrypted vault'ta tutulsun, session başlangıcında inject, kapanırken diff persist.
    - "Pinned identity" — belirli bir banka portal'ına aynı identity ile dön.

30. **Recording & replay**
    - Playwright `tracing.start()` + `tracing.stop({ path })` zip'i encrypted bucket'a; trace viewer link'i audit'e iliştirilsin.
    - Sub-poena / regülatör isteğine cevap için replay imkânı.

### G. Banka-spesifik nice-to-have

31. **Maker-Checker (Çift İmza) modu** — kritik transaction sayfalarında ikinci onay olmadan submit yok.
32. **Üç değil dört göz kuralı** — yüksek tutarlı işlemler için.
33. **Time-of-day & geo enforcement** — sadece mesai içinde, sadece TR IP'lerden session açılabilir.
34. **EFT/havale formu detection** — `aria-snapshot` üzerinden form intent classifier (LLM/regex hybrid); kritik form algılandığında otomatik step-up.
35. **PCI-DSS scope minimization** — PAN içeren sayfalardan ekran görüntüsü yasak, extracted DOM'da PAN otomatik maskeli (Luhn validated).
36. **Fraud signal export** — session davranışı (mouse hareketleri, klavye temposu) → fraud platformu (RSA, ThreatMetrix) feed.
37. **Sanctioned-entity check** — `goto` URL'inde domain owner / WHOIS country = sanctioned ise reddet (OFAC/EU/BM listesi).
38. **BDDK Bilgi Sistemleri Yönetmeliği uyumluluğu** — kritik sistem erişimi loglarının imzalı, zaman damgalı, 10 yıl saklamalı olması.
39. **Disaster recovery & deterministic replay** — aynı session config + recorded events ile DR site'ta replay edilebilirlik (test rehearsal).
40. **Privileged Access Management entegrasyonu** — CyberArk / BeyondTrust üzerinden çekilen ephemeral creds, session sonrası invalidate.

---

## 4. Önerilen Yol Haritası (Öncelik Sırası)

**Faz 1 — Güvenlik tabanı (4-6 hafta)**
- At-rest encryption (#11), audit trail (#6), session-seviye RBAC (#1), rate limiting (#23), event TTL (#8).
- Guardrail/PII detector entegrasyonu (#12), HTML extraction policy (#13).
- DNS pinning & SSRF sertleştirme (#17).

**Faz 2 — Compliance & gözlemlenebilirlik (6-8 hafta)**
- HAR capture + console events (#20, #24), screenshot redaction (#14).
- Per-tenant retention & KVKK scrub (#8), SIEM forward (#9).
- Distributed concurrency/Redis limiter + session ownership (#21).

**Faz 3 — Banka modu (8-12 hafta)**
- Per-session proxy + mTLS (#16, #4), persistent storage state (#29).
- Maker-checker / step-up auth (#2, #31), CAPTCHA pause-resume (#28).
- Tracing/replay (#30), live takeover (#27).
- Fraud signal + sanctioned entity checks (#36, #37).

**Faz 4 — Hardening & sandbox**
- Container-per-session / seccomp (#26), download AV scanning (#15), data residency (#10).

---

## 5. Hızlı Referanslar

- Kripto utility: `src/lib/utils/crypto.ts` (`encryptObject`/`decryptObject`, AES-256-GCM)
- Audit servisi: `src/lib/services/audit/auditService.ts`
- Guardrail / PII: `src/lib/services/guardrail/piiDetector.ts`
- Quota servisi: `src/lib/services/quota/`
- Concurrency provider arayüzü: `src/lib/services/browser/concurrency.ts`
- DB mixins: `src/lib/database/{mongodb,sqlite}/browser.mixin.ts`
