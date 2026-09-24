/**
 * Sample text corpus for the PII v2 local benchmark
 * (scripts/pii-bench/run.ts). A mix of short/medium/long Turkish and
 * English support-style messages: some carry real PII of every kind the
 * v2 layers add (person names, orgs, addresses, VKN, plate, passport),
 * some are deliberately "trap" sentences with common-word names ("Deniz",
 * "Can", "Ankara" used generically) to probe false-positive behaviour.
 */

export interface Sample {
  id: string;
  bucket: 'short' | 'medium' | 'long';
  lang: 'tr' | 'en' | 'mixed';
  text: string;
}

const LONG_FILLER_TR =
  'Merhaba, geçtiğimiz hafta oluşturduğumuz destek talebiyle ilgili güncelleme almak istiyorum. ' +
  'Süreç oldukça yavaş ilerliyor ve müşteri temsilcinizle yaptığım görüşmede net bir tarih alamadım. ' +
  'Lütfen konuyu ilgili birime iletip en kısa sürede geri dönüş sağlar mısınız? ';

export const CORPUS: Sample[] = [
  { id: 'short-tr-plain', bucket: 'short', lang: 'tr', text: 'Merhaba, yarın toplantı saat kaçta?' },
  { id: 'short-tr-email', bucket: 'short', lang: 'tr', text: 'İletişim: ahmet.yilmaz@example.com' },
  {
    id: 'short-tr-person',
    bucket: 'short',
    lang: 'tr',
    text: 'Sayın Ahmet Yılmaz, talebiniz alınmıştır.',
  },
  {
    id: 'short-tr-trap-common-name',
    bucket: 'short',
    lang: 'tr',
    text: 'Bugün deniz çok dalgalıydı, can sıkıcı bir gündü.',
  },
  {
    id: 'medium-tr-support-ticket',
    bucket: 'medium',
    lang: 'tr',
    text:
      'Sayın Ahmet Yılmaz, TCKN 10000000146 ile açtığınız destek talebiniz Cognipeer Teknoloji A.Ş. ' +
      'tarafından incelenmektedir. Kayıtlı telefon numaranız 0532 123 45 67, adresiniz Kızılay Mahallesi ' +
      'Atatürk Caddesi No:12 Daire:4 Çankaya/Ankara olarak görünmektedir. Vergi No: 1234567899 ile ' +
      'faturalandırma yapılacaktır.',
  },
  {
    id: 'medium-tr-mixed-entities',
    bucket: 'medium',
    lang: 'tr',
    text:
      'Toplantıya Ayşe Demir, Barış Kaya ve Mehmet Öztürk katıldı. Vestel Elektronik firmasından ' +
      'gelen teklif İzmir Konak’taki ofiste değerlendirildi. Aracın plakası 34 ABC 123 olarak not edildi. ' +
      'Pasaport no: U12345678.',
  },
  {
    id: 'medium-en-support-ticket',
    bucket: 'medium',
    lang: 'en',
    text:
      'Hi, this is John Carter from Acme Corp. My account email is john.carter@acme.com and my card ' +
      'number is 4532015112830366. Please update my billing address to 221B Baker Street, London.',
  },
  {
    id: 'long-tr-ticket-thread',
    bucket: 'long',
    lang: 'tr',
    text:
      LONG_FILLER_TR.repeat(3) +
      'Bu arada kayıtlı bilgilerim: Ahmet Yılmaz, TCKN 10000000146, telefon 0312 456 78 90, ' +
      'IBAN TR330006100519786457841326, e-posta ahmet.yilmaz@example.com. ' +
      LONG_FILLER_TR.repeat(3),
  },
  {
    id: 'long-tr-no-pii',
    bucket: 'long',
    lang: 'tr',
    text: LONG_FILLER_TR.repeat(8),
  },
];

export function corpusByBucket(bucket: Sample['bucket']): Sample[] {
  return CORPUS.filter((s) => s.bucket === bucket);
}
