import type { consoleIdentityEn } from './consoleIdentity.en';

export const consoleIdentityTr: typeof consoleIdentityEn = {
  optionLabel: 'Console kimliği',
  summary:
    'Console her çağrıda, çağrının arkasındaki kişi için kısa ömürlü bir token gönderir (Authorization: Bearer, RS256 imzalı, beş dakika geçerli, audience = burada girilen URL). Gizli bir bilgi saklanmaz; oturum açmış bir kişi olmadan yapılan çağrı reddedilir.',
  verifyHint: 'Bunları sunucuyu işleten ekibe verin; her token bu anahtar setiyle doğrulanır.',
  issuer: 'Yayıncı (issuer)',
  jwks: 'Anahtar seti (JWKS)',
  copy: 'Kopyala',
  copied: 'Kopyalandı',
  learnMore: 'Token nasıl doğrulanır',
};
