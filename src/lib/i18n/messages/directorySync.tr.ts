import type { directorySyncEn } from './directorySync.en';

/**
 * SSO (OIDC) ve LDAP ayar ekranlarının dizin eşitleme bölümü: oturum açışın kişinin
 * rolünü belirleyip belirlemediği ve dizin gruplarının konsol gruplarını nasıl
 * beslediği.
 */
export const directorySyncTr: typeof directorySyncEn = {
  role: {
    label: 'Rolü dizinden eşitle',
    descriptionOidc:
      'Rolü her oturum açışta yönetici talebinden (veya varsayılan rolden) yeniden hesaplar: talebi kazananlar yükseltilir, kaybedenler düşürülür. Çalışma alanı sahibi hiçbir zaman değiştirilmez. SSO hesaplarının rolü böylece dizini izler ve elle değiştirilemez. Yukarıda yönetici talebi tanımlı değilse konsolda atanmış yöneticiler korunur. Yönetici talebini hiç içermeyen bir token ile giriş yapan kişi yönetici sayılmaz; bu yüzden bunu açmadan önce talebi IdP tarafında kontrol edin.',
    descriptionLdap:
      'Rolü her oturum açışta yönetici gruplarından (veya varsayılan rolden) yeniden hesaplar: gruba katılanlar yükseltilir, gruptan ayrılanlar düşürülür. Çalışma alanı sahibi hiçbir zaman değiştirilmez. LDAP hesaplarının rolü böylece dizini izler ve elle değiştirilemez. Yukarıda yönetici grubu tanımlı değilse konsolda atanmış yöneticiler korunur.',
  },
  groups: {
    title: 'Grup eşitleme',
    switchLabel: 'Grupları dizinden eşitle',
    description:
      'Her oturum açışta kişi, sahip olduğu IdP gruplarına eşlenen konsol gruplarına eklenir; artık sahip olmadığı eşitlenmiş gruplardan çıkarılır. Konsol grupları ilk kullanımda oluşturulur. Elle oluşturulan gruplara dokunulmaz ve aynı adlı elle oluşturulmuş bir grup hiçbir zaman devralınmaz. Eşitlenen bir grubun verdiği yetkiler yine Gruplar ekranından ayarlanır.',
    claimLabel: 'Grup talebi',
    claimDescription:
      'Kişinin IdP gruplarını listeleyen talep. IdP bu talebi göndermezse (örneğin Entra ID grup taşması) üyelikler olduğu gibi bırakılır.',
    claimPlaceholder: 'groups',
    idpGroupLabel: 'IdP grubu',
    idpGroupPlaceholder: 'engineers',
    consoleGroupLabel: 'Konsol grubu',
    consoleGroupPlaceholder: 'Mühendisler',
    addMapping: 'Eşleme ekle',
    removeMapping: 'Eşlemeyi kaldır',
    emptyMappings: 'Henüz eşleme yok. Eşleme olmadan hiçbir şey eşitlenmez.',
  },
};
