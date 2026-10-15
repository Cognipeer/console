import type { accountPageEn } from './accountPage.en';

/**
 * "Hesabım": oturum açan herkesin IAM merkezi dışındaki sayfası - profili, kendi
 * parolası (yerel hesaplar) ve kişisel API token'larına giden bir yol.
 */
export const accountPageTr: typeof accountPageEn = {
  eyebrow: 'Hesap',
  title: 'Hesabım',
  subtitle: 'Profiliniz, parolanız ve kişisel API token\'larınız.',
  loading: 'Hesabınız yükleniyor…',
  loadFailed: 'Hesabınız yüklenemedi',
  retry: 'Tekrar dene',
  roles: {
    owner: 'Sahip',
    admin: 'Yönetici',
    project_admin: 'Proje yöneticisi',
    user: 'Kullanıcı',
    portal_user: 'Yalnız portal',
  },
  providers: {
    local: 'Yerel hesap',
    ldap: 'LDAP',
    oidc: 'SSO (OIDC)',
    saml: 'SSO (SAML)',
  },
  managed: {
    title: '{provider} tarafından yönetiliyor',
    body: 'Adınız, e-posta adresiniz ve parolanız dizininizde tutulduğu için burada salt okunurdur. Değişiklikleri orada yapın.',
  },
  profile: {
    title: 'Profil',
    hint: 'Konsolda nasıl göründüğünüz.',
    name: 'Ad',
    email: 'E-posta adresi',
    emailHint: 'E-posta adresinizi bir çalışma alanı yöneticisi değiştirir.',
    role: 'Rol',
    roleHint: 'Rolünüzü bir çalışma alanı yöneticisi belirler.',
    source: 'Oturum açma',
    nameInvalid: '2 ile 120 karakter arasında olmalı.',
    save: 'Değişiklikleri kaydet',
    saved: 'Profil kaydedildi',
    noEmail: 'Yok (servis hesabı)',
  },
  password: {
    title: 'Parola',
    hint: 'Oturum açtığınız parolayı değiştirin.',
    current: 'Mevcut parola',
    next: 'Yeni parola',
    confirm: 'Yeni parolayı doğrula',
    rules: 'En az 8 karakter; bir büyük harf, bir küçük harf, bir rakam ve bir özel karakter içermeli.',
    rule: {
      length: 'En az 8 karakter',
      upper: 'Bir büyük harf',
      lower: 'Bir küçük harf',
      digit: 'Bir rakam',
      special: 'Bir özel karakter',
    },
    submit: 'Parolayı değiştir',
    changed: 'Parola değiştirildi',
    mismatch: 'Parolalar eşleşmiyor',
    currentRequired: 'Mevcut parolanızı girin',
    weak: 'Yeni parola gereksinimleri karşılamıyor',
    managedTitle: 'Parolanız başka bir yerde yönetiliyor',
    managedBody: 'Hesabınız {provider} üzerinden oturum açıyor. Parolanızı orada değiştirin.',
    serviceTitle: 'Parola yok',
    serviceBody: 'Bu bir servis hesabı. Oturum açamadığı için parolası yoktur.',
  },
  tokens: {
    title: 'API token\'larınız',
    body: 'API token\'ları betiklerin ve uygulamaların sizin adınıza çalışmasını sağlar. Kendi token\'larınızı API Token\'ları sayfasından yönetirsiniz; başkalarının token\'larını yöneticiler IAM merkezinden yönetir.',
    open: 'API token\'larını aç',
  },
  errors: {
    directory_managed: 'Bu hesap dizininiz tarafından yönetiliyor. Değişikliği orada yapın.',
    password_managed_externally: 'Parolanız dizininiz tarafından yönetiliyor. Değişikliği orada yapın.',
    invalid_password: 'Yeni parola gereksinimleri karşılamıyor.',
    invalid_body: 'İstek geçerli değildi.',
    rate_limited: 'Çok fazla deneme. Daha sonra tekrar deneyin.',
    wrongCurrent: 'Mevcut parola doğru değil.',
    generic: 'Bir şeyler ters gitti. Tekrar deneyin.',
  },
};
