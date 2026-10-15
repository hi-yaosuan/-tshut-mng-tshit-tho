// 開新行程時可以套用的範本。
// perPerson: 每人幾個，需要數量 = perPerson × 參與人數（人數改了會自動更新）
// need: 固定數量；兩個都沒有代表「有帶就好」

export const CATEGORIES = ['帳篷家具', '寢具', '炊具餐具', '照明電力', '清潔衛生', '其他'];

export const templates = [
  {
    id: 'basic',
    name: '露營基本清單',
    desc: '常用裝備依類別整理好，「每人一份」的東西會依人數自動算數量。',
    gear: [
      ['帳篷家具', '帳篷', { need: 1 }],
      ['帳篷家具', '天幕／客廳帳', { need: 1 }],
      ['帳篷家具', '露營桌', { need: 1 }],
      ['帳篷家具', '露營椅', { perPerson: 1 }],
      ['帳篷家具', '野餐墊', {}],
      ['寢具', '睡袋', { perPerson: 1 }],
      ['寢具', '睡墊／充氣床墊', { perPerson: 1 }],
      ['寢具', '枕頭', { perPerson: 1 }],
      ['炊具餐具', '卡式爐', { need: 2 }],
      ['炊具餐具', '瓦斯罐', {}],
      ['炊具餐具', '湯鍋', { need: 1 }],
      ['炊具餐具', '平底鍋／鐵鍋', { need: 1 }],
      ['炊具餐具', '菜刀＋砧板', { need: 1 }],
      ['炊具餐具', '湯杓、夾子、鍋鏟', { need: 1 }],
      ['炊具餐具', '煮水壺', { need: 1 }],
      ['炊具餐具', '個人碗筷杯', { perPerson: 1 }],
      ['炊具餐具', '保鮮盒', {}],
      ['炊具餐具', '冰桶', { need: 1 }],
      ['炊具餐具', '調味料', {}],
      ['照明電力', '露營燈', { need: 2 }],
      ['照明電力', '頭燈', {}],
      ['照明電力', '動力線', { need: 2 }],
      ['照明電力', '三轉二插頭', { need: 1 }],
      ['清潔衛生', '洗碗精、菜瓜布', { need: 1 }],
      ['清潔衛生', '曬碗架', { need: 1 }],
      ['清潔衛生', '垃圾袋', {}],
      ['清潔衛生', '衛生紙', {}],
      ['清潔衛生', '濕紙巾', {}],
      ['其他', '防蚊液、蚊香', {}],
      ['其他', '打火機', { need: 1 }],
      ['其他', '急救包', { need: 1 }],
    ],
    items: ['飲用水', '冰塊', '飲料', '零食'],
  },
];

export function templateDocs(t) {
  return {
    gear: t.gear.map(([cat, name, opt]) => ({ name, cat, source: 'own', need: opt.need ?? null, perPerson: opt.perPerson ?? null, claims: {} })),
    items: t.items.map((name) => ({ name, qty: '', mealId: null, mode: 'buy', unitId: null, done: false })),
  };
}
