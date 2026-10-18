import type { agentTemplatesEn } from './agentTemplates.en';

export const agentTemplatesTr: typeof agentTemplatesEn = {
  categories: {
    support: 'Destek',
    knowledge: 'Bilgi',
    engineering: 'Mühendislik',
    research: 'Araştırma',
    sales_marketing: 'Satış ve pazarlama',
    operations: 'Operasyon',
    multi_agent: 'Çoklu ajan',
  },
  capabilities: {
    knowledge: 'Bilgi tabanı',
    web_search: 'Web arama',
    mcp: 'MCP',
    client_tools: 'İstemci araçları',
    approval: 'Onay',
    ask_user: 'Soru sorar',
    subagents: 'Alt ajanlar',
    skills: 'Yetenekler',
    structured_output: 'Yapılandırılmış çıktı',
    variables: 'Değişkenler',
    schedule: 'Zamanlama',
    webhook: 'Webhook',
    sandbox: 'Sandbox',
    guardrails: 'Guardrail’ler',
  },
  surfaces: {
    chat: 'Sohbet',
    api: 'API',
    trigger: 'Tetikleyici',
  },
  modelHints: {
    fast: 'Hızlı ve düşük maliyetli bir sohbet modeli yeterli.',
    balanced: 'Dengeli, genel amaçlı bir sohbet modeliyle iyi çalışır.',
    reasoning: 'En iyi sonucu bir akıl yürütme (reasoning) modeliyle verir.',
  },
  availability: {
    status: {
      ready: 'Hazır',
      needs_setup: 'Kurulum gerekli',
      unavailable: 'Kullanılamıyor',
    },
    items: {
      no_llm_model: 'Bu projede henüz bir sohbet modeli yok. Önce Model Hub’dan bir model ekleyin.',
      sandbox_unavailable: 'Bu şablon, bir Enterprise özelliği olan sandbox’a ihtiyaç duyar.',
      sandbox_template_missing: 'Sandbox’ta henüz şablon yok. Önce bir sandbox şablonu oluşturun.',
      web_search_unavailable:
        'Bu projede etkin bir web arama sağlayıcısı yok. Sağlayıcılar bölümünden bir tane ekleyin.',
      knowledge_missing:
        'Bu projede henüz bir bilgi tabanı yok. Ajanın belgelerinizden yanıt verebilmesi için bir tane oluşturun.',
    },
    sandboxReasons: {
      edition: 'Bu sürümde sandbox modülü yok.',
      license: 'Bu çalışma alanının Enterprise lisansı yok.',
    },
  },
  setup: {
    knowledge_not_bound:
      'Ajanın belgelerinizden yanıt verebilmesi için ajan ayarlarından bir bilgi tabanı bağlayın.',
    web_search_unavailable:
      'Bu projede etkin bir web arama sağlayıcısı yok; ajan henüz web’de arama yapamaz. Sağlayıcılar bölümünden bir tane ekleyin.',
    guardrails_recommended:
      'Bu ajanı son kullanıcılara açmadan önce ajan ayarlarından bir guardrail bağlayın.',
    client_tools:
      'Bu ajan, {tools} araçlarını uygulamanızın çalıştırmasını ister. Canlıya almadan önce ajanı API/SDK ya da bir portal üzerinden uygulamanıza bağlayın. Playground’da çağrıyı kendiniz yanıtlarsınız.',
    publish_needed:
      'API, tetikleyiciler ve A2A yayımlanmış sürümü çalıştırır; bunları kullanmak için ajanı yayımlayın.',
    triggers_disabled:
      'Önerilen tetikleyiciler ({names}) devre dışı oluşturuldu. Gözden geçirin, ajanı yayımlayın ve ardından etkinleştirin.',
    webhook_secret: 'Her webhook’un gizli anahtarını şimdi kopyalayın. Yalnızca bir kez gösterilir.',
  },
  hints: {
    clientTools:
      'Bu ajan, {tools} araçlarını uygulamanızın çalıştırmasını ister. Canlıya almadan önce ajanı API/SDK ya da bir portal üzerinden uygulamanıza bağlayın. Playground’da çağrıyı kendiniz yanıtlarsınız.',
  },
  items: {
    'customer-support': {
      name: 'Müşteri Destek Ajanı',
      summary: 'Bilgi tabanınızdan yanıtlar, eksik bilgiyi sorar ve gerektiğinde talep açar.',
      description:
        'Bilgi tabanınızda arama yapan, her seferinde tek bir net soru soran ve kaynaklarını gösteren samimi bir ilk basamak destek ajanı. Sorunu çözemediğinde bir meslektaşı için talep hazırlar; talep oluşturulmadan önce bir kişinin Onayı gerekir.',
      useCases: [
        'Yardım merkezinizdeki ürün ve politika sorularını yanıtlama',
        'Konuyu devretmeden önce insan temsilcinin ihtiyaç duyduğu bilgileri toplama',
        'Onay sonrasında destek sisteminizde talep oluşturma',
      ],
    },
    'support-triage': {
      name: 'Destek Talebi Triyajı',
      summary: 'Yeni talepleri sınıflandırır: kategori, öncelik, duygu, ekip ve taslak yanıt.',
      description:
        'Gelen bir talebi okuyup kategori, öncelik, duygu durumu, dil, özet ve sahiplenmesi gereken ekibi içeren bir Yapılandırılmış çıktı üretir. İnsan müdahalesi gereken talepleri işaretler ve ilk yanıtı taslak olarak hazırlar. Destek sisteminizin webhook\'unu Tetikleyiciye bağlayın veya API\'den çağırın.',
      useCases: [
        'Yeni talepleri doğru ekibe otomatik yönlendirme',
        'Acil ve öfkeli müşterileri öne çıkarma',
        'Temsilcilerin gözden geçireceği yanıt taslakları hazırlama',
      ],
    },
    'it-helpdesk': {
      name: 'BT Destek Asistanı',
      summary: 'Cihaz ve erişim sorunlarını adım adım teşhis eder, eksiksiz BT talebi açar.',
      description:
        'Güvenli çözümler önermeden önce cihazı, işletim sistemini ve tam hata mesajını soran bir ilk basamak BT asistanı; bağlı bir Bilgi tabanı varsa onu kullanır. Kendi kendine çözüm işe yaramazsa eksiksiz bir BT talebi hazırlar ve talep oluşturulmadan önce bir kişi Onay verir.',
      useCases: [
        'Çalışanlara Wi-Fi, VPN, e-posta ve yazıcı sorunlarında yol gösterme',
        'Cihaz, işletim sistemi ve hata bilgisini baştan toplayarak gidiş gelişi azaltma',
        'Olası kimlik avı veya kayıp cihaz durumlarını acil talep olarak iletme',
      ],
    },
    'refund-approval': {
      name: 'İade Onay Asistanı',
      summary: 'İade uygunluğunu politikanıza göre denetler, her iade için kişi Onayı ister.',
      description:
        'Siparişi sorgular; iade süresini, tutarı ve para birimini Değişkenler olarak belirlediğiniz politikaya göre denetler ve sonucu müşteriye açıklar. İade yalnızca bir kişi Onay verdikten sonra yapılır; böylece para hareketi yalnızca modelin kararına bağlı olmaz.',
      useCases: [
        'İade taleplerini tutarlı bir politika denetimiyle yönetme',
        'Onaylayanlara ihtiyaç duydukları bilgileri tek yerde sunma',
        'Her geri ödemede kontrolü bir insanda tutma',
      ],
    },
    'knowledge-qa': {
      name: 'Bilgi Tabanı Soru-Cevap',
      summary: 'Bilgi tabanınızdan kaynak göstererek yanıt verir; bulamazsa bunu açıkça söyler.',
      description:
        'Bağlı bilgi tabanınızda arama yapan, kullandığı belgeleri kaynak olarak gösteren ve tahmin yürütmeyen bir soru-cevap asistanı. İlgili bilgi bulunamazsa bunu belirtir ve nereye başvurulabileceğini önerir.',
      useCases: [
        'Şirket içi wiki ve el kitabı arama',
        'Müşteriler için ürün dokümantasyonu asistanı',
        'Intranet veya yardım merkezi için yanıt API\'si',
      ],
    },
    'hr-policy-assistant': {
      name: 'İK Politika Asistanı',
      summary: 'İK politikalarını belgelerinizden açıklar, hassas konuları ilgili kişilere yönlendirir.',
      description:
        'Çalışanların izin, yan haklar ve İK süreçleri hakkındaki sorularını yalnızca politika belgelerinize dayanarak yanıtlar ve sonraki adımı söyler. Kişisel veri istemez, hukuki ya da tıbbi tavsiye vermez; hassas konuları İK\'ya yönlendirir. Kişisel veri (PII) korumasının bağlanması önerilir.',
      useCases: [
        'İzin, yan haklar ve masraf politikası soruları',
        'Yeni çalışan oryantasyonu SSS',
        'Talep açılmadan önce İK\'nın ilk destek hattı',
      ],
    },
    'pr-reviewer': {
      name: 'Pull Request İnceleyici',
      summary: 'Her yeni pull request’i inceler; yapılandırılmış bulgular, risk ve karar döndürür.',
      description:
        'GitHub pull request olayını alır, değişikliği bir inceleme kontrol listesine göre değerlendirir ve yapılandırılmış bir çıktı üretir: özet, risk, önem derecesine göre bulgular, önerilen testler ve karar. Diff erişilebilir değilse tahmin yürütmek yerine neyin eksik olduğunu söyler.',
      useCases: [
        'Açılan veya güncellenen her pull request için ilk inceleme almak',
        'Bulguları API üzerinden bir CI adımına veya sohbet kanalına göndermek',
        'Ekip arkadaşından görüş istemeden önce yapıştırılan bir diff’i kontrol etmek',
      ],
    },
    'ci-failure-triage': {
      name: 'CI Hata Sınıflandırma',
      summary: 'Başarısız pipeline çalıştırmalarını inceler: hatalı adım, olası neden ve çözüm.',
      description:
        'Başarısız GitHub Actions çalıştırmalarını veya genel bir webhook üzerinden herhangi bir CI sistemini dinler ve hatayı yapılandırılmış bir teşhise çevirir. Hatalı adımı belirler, nedeni sınıflandırır, kendi güven düzeyini söyler ve log gerektiğinde bunu belirtir.',
      useCases: [
        'Her kırmızı build’in yanına tek satırlık kök neden yazmak',
        'Kararsız (flaky) testleri gerçek regresyonlardan ayırmak',
        'Başarısız bir logu Playground’a yapıştırıp sıralı sonraki adımları almak',
      ],
    },
    'release-notes-writer': {
      name: 'Sürüm Notu Yazarı',
      summary: 'Commit ve pull request’leri seçtiğiniz kitle için anlaşılır sürüm notlarına çevirir.',
      description:
        'Commit’leri, pull request başlıklarını veya değişiklik parçalarını yapıştırın; Eklenenler, Değişenler, Düzeltilenler ve Güvenlik başlıklarıyla gruplanmış Markdown sürüm notları alın. Geriye dönük uyumsuz değişiklikler en başta belirtilir, her madde kitleye göre yeniden yazılır ve özellik ya da rakam uydurulmaz.',
      useCases: [
        'Sprint sonunda müşteriye dönük sürüm notları hazırlamak',
        'Geriye dönük uyumsuz değişiklikler için geçiş adımlı geliştirici changelog’u yazmak',
        'Bir sürümü iç duyuru için özetlemek',
      ],
    },
    'incident-postmortem': {
      name: 'Olay Sonrası Analizi',
      summary: 'Olay notlarını zaman çizelgesi, kök neden ve eylemlerle suçlamasız bir analize çevirir.',
      description:
        'Bir olaydan kalan sohbet kayıtlarını, uyarıları ve notları yapıştırın; özet, etki, UTC zaman çizelgesi, kök neden ve katkıda bulunan etkenler, iyi ve kötü giden şeyler ve sorumlusu atanmış eylem maddelerinden oluşan suçlamasız bir analiz alın. Çıkarımları çıkarım olarak işaretler, eksik bilgiyi tahmin etmek yerine soru sorar.',
      useCases: [
        'Kesinti çözüldükten sonraki saatlerde analiz taslağı hazırlamak',
        'Dağınık bir olay kanalını temiz bir zaman çizelgesine dönüştürmek',
        'Eylem maddelerinin net, sorumlusu belli ve doğrulanabilir olduğunu kontrol etmek',
      ],
    },
    'sql-assistant': {
      name: 'SQL Asistanı',
      summary: 'SQL lehçenize ve şemanıza uygun salt okunur sorgular yazar, varsayımlarını belirtir.',
      description:
        'Sorunuzu düz bir dille anlatın; Postgres, MySQL, SQL Server, SQLite, BigQuery veya Snowflake için okunabilir bir sorgu alın. Verdiğiniz şemaya bağlı kalır, siz açıkça istemedikçe salt okunur çalışır, her adımı açıklar ve doğrulamanız gereken varsayımları listeler.',
      useCases: [
        'Tablo adı uydurmadan bir iş sorusunu sorguya dönüştürmek',
        'Başkasının yazdığı uzun bir sorguyu anlamak ve gözden geçirmek',
        'Bir sorguyu bir SQL lehçesinden diğerine taşımak',
      ],
    },
    'deep-research': {
      name: 'Derin Araştırma',
      summary: 'Plan yapar, web\'de paralel arar, doğrular ve kaynaklı bir rapor yazar.',
      description:
        'Sorunuzu alt sorulara bölen, web araştırmacılarını paralel çalıştıran, kritik iddiaları bir doğrulayıcıya kontrol ettiren ve numaralı kaynaklarla yapılandırılmış bir rapor yazan araştırma lideri. Çelişkileri ve eksikleri gizlemek yerine açıkça raporlar. Bir web arama sağlayıcısı gerektirir.',
      useCases: [
        'Pazar ve rakip durum raporları',
        'Yap mı satın al mı kararından önce teknoloji karşılaştırmaları',
        'Bir konu, kişi veya düzenleme hakkında ön araştırma',
      ],
    },
    'competitor-monitor': {
      name: 'Rakip Takipçisi',
      summary: 'Rakiplerin fiyat, lansman, işe alım ve yatırım haberlerinin kaynaklı haftalık özeti.',
      description:
        'Belirttiğiniz rakipleri açık web üzerinde izler ve yalnızca geçen haftaya ait doğrulanmış değişiklikleri raporlar. Her bulgu etki düzeyine göre derecelendirilir ve kaynağıyla birlikte sunulur; hareketsiz haftalar da olduğu gibi bildirilir. Haftalık Zamanlayıcı tetikleyicisiyle çalıştırabilir veya sohbette dilediğiniz zaman sorabilirsiniz.',
      useCases: [
        'Satış ve ürün ekipleri için pazartesi sabahı rakip özeti',
        'Bir rakibin fiyat değişikliğini ya da yeni lansmanını günler içinde fark etme',
        'Yönetim kurulu ve strateji toplantıları öncesi güncel pazar sinyallerini derleme',
      ],
    },
    'daily-briefing': {
      name: 'Günlük Bülten',
      summary: 'Takip ettiğiniz konularda öncelik sırasına dizilmiş, kaynak bağlantılı sabah bülteni.',
      description:
        'Her sabah konularınızda son 24 saatte olanları web\'de arar, tekrarları birleştirir ve haberleri önemine göre sıralar. Konuları, dili ve haber sayısını Değişkenler üzerinden siz belirlersiniz. Hafta içi her gün çalışacak şekilde zamanlayabilir ya da istediğiniz an bülten isteyebilirsiniz.',
      useCases: [
        'İş gününe sektörünüzle ilgili beş dakikalık bir özetle başlama',
        'Yönetimi yapay zekâ, regülasyon veya piyasa haberlerinden haberdar tutma',
        'Toplantı öncesi bir konuda tek seferlik bülten alma',
      ],
    },
    'data-analyst': {
      name: 'Veri Analisti',
      summary: 'Veri sorularını sandbox\'ta kod çalıştırarak yanıtlar; her sayı hesaplanmıştır.',
      description:
        'Verinizi inceler, yalıtılmış bir sandbox\'ta Python çalıştırır ve yanıtı yöntemi ile uyarılarıyla birlikte sunar. Sayıları hiçbir zaman hafızadan tahmin etmez; veri soruyu yanıtlamaya yetmiyorsa nelerin eksik olduğunu açıkça söyler. Enterprise sandbox modülü gerektirir.',
      useCases: [
        'Yapıştırdığınız bir CSV\'de hangi segmentin en hızlı büyüdüğünü sorma',
        'Dağınık bir dışa aktarımı temizleyip tekrar ve aykırı değerleri kontrol etme',
        'Rakamları ekibe sunmadan önce doğrulanmış bir özet alma',
      ],
    },
    'lead-qualifier': {
      name: 'Lead Nitelendirici',
      summary: 'Lead\'leri ideal müşteri profilinize göre puanlar, yapılandırılmış bir skor kartı döndürür.',
      description:
        'Bir şirketi araştırır, ideal müşteri profilinize uyumunu 0-100 arasında puanlar ve gerekçeler, riskler, satın alma sinyalleri, kaynaklar ve önerilen sonraki adımla birlikte Yapılandırılmış çıktı döndürür. Önerilen Webhook tetikleyicisini formunuza veya CRM\'inize bağlayarak her yeni lead\'i otomatik puanlayabilir, ayrıca sohbette ve API üzerinden kullanabilirsiniz.',
      useCases: [
        'Her yeni demo talebini satış temsilcisine ulaşmadan önce puanlama',
        'İçe aktarılan lead listesini uyuma göre önceliklendirme',
        'Bir şirketin giden e-posta akışına değip değmediğine hızlıca karar verme',
      ],
    },
    'meeting-prep': {
      name: 'Toplantı Hazırlığı',
      summary: 'Toplantı için konuşma noktaları, sorular ve olası itirazlar içeren tek sayfalık özet.',
      description:
        'Şirketi ve katılımcıları herkese açık kaynaklardan araştırır, bulguları toplantı hedefiniz etrafında tek sayfalık bir özete dönüştürür. Gündem, konuşma noktaları, keşif soruları, olası itirazlar ve toplantıdan önce doğrulanacaklar listesi içerir. Web araması olsa da olmasa da çalışır.',
      useCases: [
        'İlk keşif görüşmesine beş dakikada hazırlanma',
        'Müşteri toplantısına katılacak bir meslektaşı bilgilendirme',
        'Bir iş ortağı veya yatırımcı görüşmesine hazırlanma',
      ],
    },
    'content-writer': {
      name: 'İçerik yazarı',
      summary: 'Bir özeti taslağa, tam metne ve SEO başlığı ile meta açıklamasına dönüştürür.',
      description:
        'Konuyu verin; önce bir ana hat önerir, seçtiğiniz ton ve uzunlukta metni yazar, sonunda SEO başlığı, meta açıklaması ve URL uzantısı sunar. Değişkenlerle hedef kitle, ton, uzunluk ve anahtar kelimeleri bir kez tanımlarsınız, böylece tüm içerikler tutarlı kalır.',
      useCases: [
        'Kısa bir özetten blog yazısı ve duyuru metni',
        'Açılış sayfası ve ürün açıklaması metinleri',
        'İçerik ekibinde tutarlı marka tonu',
      ],
    },
    'content-repurposer': {
      name: 'İçerik dönüştürücü',
      summary: 'Tek bir makaleyi LinkedIn gönderisine, X dizisine, bülten özetine ve alıntılara çevirir.',
      description:
        'Uzun bir içerik gönderin; kanala hazır metinler tek bir yapılandırılmış JSON çıktısı olarak gelsin. Alıntılar kaynaktan kelimesi kelimesine alınır, yeni bilgi uydurulmaz. Marka sesi değişkeni tüm kanallarda tonu tutarlı tutar.',
      useCases: [
        'Her blog yazısını dakikalar içinde sosyal medyada duyurma',
        'API üzerinden içerik üretim hattını besleme',
        'Rapor ve transkriptlerden birebir alıntı çıkarma',
      ],
    },
    'meeting-notes': {
      name: 'Toplantı notları',
      summary: 'Transkripti özete, kararlara, sorumlusu atanmış aksiyonlara ve risklere çevirir.',
      description:
        'Transkripti ya da kaba notları yapıştırın; özet, kararlar, sorumlusu ve tarihi olan aksiyonlar, açık sorular ve riskler yapılandırılmış JSON olarak gelsin. Yalnızca gerçekten konuşulanı kaydeder, sorumlusu belli olmayan işleri tahmin etmek yerine atanmamış olarak işaretler.',
      useCases: [
        'Görüşmenin hemen ardından tutanak ve takip maddeleri',
        'API ile aksiyonları görev yönetim aracına aktarma',
        'Haftalık ekip toplantısı özetleri',
      ],
    },
    'email-triage': {
      name: 'E-posta sınıflandırma',
      summary: 'Gelen e-postaları sınıflandırır, öncelik atar, gerekirse yanıt taslağı hazırlar.',
      description:
        'E-postaları webhook Tetikleyicisi ya da API ile alır ve yapılandırılmış sonuç döndürür: kategori, öncelik, yanıt gerekip gerekmediği, göndericinin amacı, özet ve isteğe bağlı yanıt taslağı. Taslaklar fiyat, tarih ya da iade sözü vermez; e-posta metni bilgi olarak ele alınır, talimat olarak değil.',
      useCases: [
        'Ortak gelen kutusunu doğru ekibe otomatik yönlendirme',
        'Acil ve yüksek öncelikli e-postaları öne çıkarma',
        'Bir kişinin inceleyeceği nazik yanıtları önceden yazma',
      ],
    },
    'document-extractor': {
      name: 'Belge veri çıkarıcı',
      summary: 'Fatura, fiş ve siparişleri güven skorlarıyla temiz JSON\'a dönüştürür.',
      description:
        'Bir iş belgesinin metnini okur; alanları, kalemleri, eksik alanları ve uyarıları yapılandırılmış çıktı (katı şemalı JSON) olarak döndürür. Değerler belgede yazdığı gibi alınır, emin olunmayanların güven skoru düşürülür ve hiçbir şey tahmin edilmez.',
      useCases: [
        'Muhasebe veya ERP aktarımı için fatura verilerini yakalamak',
        'Tedarikçi e-postalarından sipariş formlarını önceden doldurmak',
        'Eksik alanı olan veya toplamı tutmayan belgeleri işaretlemek',
      ],
    },
    'contract-reviewer': {
      name: 'Sözleşme inceleyici',
      summary: 'Sözleşmeler için ilk inceleme: temel şartlar, riskli maddeler, önerilen revizyonlar.',
      description:
        'Ticari bir sözleşmeyi okuyup tarafları, süreyi, yenileme, fesih ve sorumluluk üst sınırını yapılandırılmış çıktı olarak çıkarır; riskli maddeleri önem derecesi ve önerilen revizyon metniyle işaretler. Eksik standart korumaları da listeler. Çıktı hukuki görüş değildir; insan incelemeci için ilk elden bir değerlendirmedir.',
      useCases: [
        'Tedarikçi ve SaaS sözleşmelerini hukuk ekibine gitmeden önce ön elemeden geçirmek',
        'Karşı tarafın taslağını kendi standart pozisyonlarınızla karşılaştırmak',
        'Kullanıma hazır revizyon metinleriyle müzakere gündemini hazırlamak',
      ],
    },
    translator: {
      name: 'Çevirmen',
      summary: 'Biçimi, yer tutucuları ve sözlük terimlerini koruyan doğal, sadık çeviri.',
      description:
        'Hedef dil, ton ve sözlük değişkenlerinize göre metni çevirir, sözlüğünüzü harfiyen uygular; Markdown, HTML, kod, yer tutucular ve bağlantılara dokunmaz. Belirsizlikleri sessizce tahmin etmek yerine kısa notlarla işaretler.',
      useCases: [
        'Uygulama metinlerini ve e-posta şablonlarını yer tutucuları bozmadan yerelleştirmek',
        'Destek yanıtlarını veya dokümantasyonu tutarlı bir marka tonuyla çevirmek',
        'Ürün ve hukuk terminolojisini sözlükle tutarlı tutmak',
      ],
    },
    'support-router': {
      name: 'Destek Yönlendirici',
      summary: 'Her talebi fatura, teknik veya satış uzmanına yönlendirir, yanıtları birleştirir.',
      description:
        'Gelen müşteri mesajlarını sınıflandırıp üç uzman alt ajana devreden bir karşılama ajanı; mesaj birden fazla konuya değiniyorsa uzmanları paralel çalıştırır. Talep belirsizse netleştirici bir soru sorar ve tek bir birleşik yanıt döndürür. Yanıtları temellendirmek için bir bilgi tabanı bağlayabilirsiniz.',
      useCases: [
        'Destek sohbeti veya gelen kutusu için tek giriş noktası',
        'Fatura sorunu ve plan sorusu gibi karma talepleri ayırma',
        'Kendi çok ajanlı destek ekibiniz için başlangıç noktası',
      ],
    },
  },
};
