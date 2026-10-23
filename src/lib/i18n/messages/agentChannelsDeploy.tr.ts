import type { agentChannelsDeployEn } from './agentChannelsDeploy.en';

/** Ajan kanalları: kanalın nerede yanıt vereceğini ve kimlerin kullanabileceğini düzenleme. Bkz. agentChannelsDeploy.en.ts. */
export const agentChannelsDeployTr: typeof agentChannelsDeployEn = {
  access: {
    editTitle: 'Nerede ve kimler · {name}',
    subtitle: '{platform} · {workspace}',
    save: 'Değişiklikleri kaydet',
    saved: 'Değişiklikler kaydedildi',
    ready: '{done} / {total} hazır',

    where: {
      title: 'Nerede yanıt versin?',
      description: 'Kanal, bu yerlerde kullanma izni olan kişilere yanıt verir.',
      dm: 'Doğrudan mesajlar (DM)',
      dmHint: 'Kişiler bota özel sohbetten yazabilir.',
      channels: 'Kanallar (biri botu @ ile andığında)',
      all: 'Botun eklendiği tüm kanallar',
      selected: 'Yalnızca seçili kanallar',
      none: 'Hiçbir kanal (yalnızca DM)',
      pick: 'Kanallar',
      pickPlaceholder: 'Kanal ara',
      refresh: 'Listeyi yenile',
      loadingChannels: 'Kanallar yükleniyor…',
      nothingFound: 'Kanal bulunamadı',
      private: 'Özel',
      truncated: 'Yalnızca ilk {count} kanal listeleniyor.',
      hintSlack: 'Slack yalnızca botun üyesi olduğu kanalları listeler. Önce botu davet edin:',
      hintTeams: 'Teams, botun eklendiği ekiplerin kanallarını listeler. Önce uygulamayı bir ekibe ekleyin.',
      botFallback: 'bot',
      problems: {
        nowhere: 'En az bir yer seçin: doğrudan mesajlar ya da kanallar.',
        noChannels: 'En az bir kanal seçin ya da başka bir seçenek belirleyin.',
        tooMany: 'En fazla {max} kanal seçilebilir.',
      },
    },

    who: {
      title: 'Kimler kullanabilir?',
      description: 'Diğer kişilere yöneticilerine başvurmaları söylenir.',
      mode: 'Erişim',
      everyone: 'Herkes',
      selected: 'Seçili gruplar ve kişiler',
      everyoneHint: 'Herkes = doğrulanmış e-postası bir Console kullanıcısıyla eşleşen tüm kişiler.',
      groups: 'Gruplar',
      groupsPlaceholder: 'Grup ara',
      users: 'Kişiler',
      usersPlaceholder: 'Ada veya e-postaya göre kişi ara',
      nobody: 'Grup veya kişi seçilmedi: bu kanalı kimse kullanamaz.',
      tooMany: 'Listede en fazla {max} grup ve kişi olabilir.',
      policyNote: 'Liste, ajanın bu kanaldaki yerleşik erişim kuralıdır (portallardaki gibi). IAM’deki engelleme kuralları kişileri yine de engelleyebilir.',
      openIam: 'IAM’i aç',
      missing: 'Artık yok: {names}.',
      dropMissing: 'Listeden kaldır',
    },

    publicWarning: {
      title: 'Dikkat',
      body: 'Bir kanaldaki yanıtları o kanalı gören herkes görür; yukarıdaki listede olmayanlar da. Hassas ajanları (ör. İK) yalnızca DM’de açın.',
    },
    approvals: {
      body: 'Onay gerektiren araçlar, ajanın kimsenin yanıtlayamadığı çalıştırmalar için belirlediği kurala uyar. “Duraklat” ise onay Studio’da verilir, sonuç thread’e yazılır.',
      link: 'Ajan ayarlarında değiştir',
    },

    summary: {
      title: 'Özet',
      where: 'Nerede',
      who: 'Kimler',
      dm: 'DM',
      allChannels: 'Tüm kanallar',
      everyone: 'Herkes',
      nobody: 'Henüz kimse',
      more: '+{count} daha',
    },
    checks: {
      title: 'Kontrol listesi',
      where: 'Yanıt verilecek yer',
      who: 'Kimlerin kullanacağı',
    },
  },
};
