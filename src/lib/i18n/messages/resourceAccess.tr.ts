import type { resourceAccessEn } from './resourceAccess.en';

/**
 * "Kim kullanabilir": paylaşılan bir kaynağın (MCP sunucusu, skill) erişim listesi; kaynağın kendi formunda düzenlenir
 * (components/access/AccessListFields.tsx). `tr.ts` içindeki `resourceAccess` namespace'i.
 */
export const resourceAccessTr: typeof resourceAccessEn = {
  title: 'Kim kullanabilir',
  description: 'Bu {resource} kimin ajan çalıştırmalarında kullanılabileceğini belirler. Her kanalda, çalıştırmanın yapıldığı kişi için kontrol edilir: dashboard, API, portallar, Slack ve Teams.',
  mode: 'Erişim',
  everyone: 'Ajanı çalıştırabilen herkes',
  selected: 'Seçili kişi ve gruplar',
  everyoneHint: 'Bu {resource} eklendiği her ajanda, o ajanı çalıştırabilen herkes için kullanılabilir.',
  selectedHint: 'Bu {resource} yalnızca aşağıdaki kişilerin ve aşağıdaki grupların üyelerinin çalıştırmalarında kullanılır. Başkalarının çalıştırmaları ve hiçbir kişi adına yapılmayan çalıştırmalar (akış adımı, herkese açık uç nokta) bunu almaz.',
  people: 'Kişiler',
  groups: 'Gruplar',
  peoplePlaceholder: 'Kişi ara',
  groupsPlaceholder: 'Grup ara',
  addMe: 'Beni ekle',
  you: 'Siz',
  emptyWarning: 'Listede henüz kimse yok; bu yüzden hiçbir ajan çalıştırması bu {resource} almaz.',
  pickerHint: 'Kişi ve grup aramak için IAM okuma yetkisi gerekir. Bu yetki olmadan kendinizi yine de ekleyebilirsiniz.',
  iamNote: 'Liste, bu {resource} için yerleşik IAM politikasıdır. IAM\'deki engelleme kuralları bunun üstüne yine uygulanır.',
  summaryEveryone: 'Ajanı çalıştırabilen herkes',
  summarySelected: '{people} kişi · {groups} grup',
  badgeRestricted: 'Kısıtlı',
  edit: 'Düzenle',
  cancel: 'Vazgeç',
  save: 'Kaydet',
  saveFailed: 'Erişim listesi kaydedilemedi.',
  saved: 'Erişim listesi kaydedildi.',
  resourceMcp: 'MCP sunucusu',
  resourceSkill: 'skill',
};
