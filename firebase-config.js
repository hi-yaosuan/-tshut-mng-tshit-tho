// Firebase 主控台「專案設定 → 你的應用程式」裡的 firebaseConfig。
// 這段不是密碼，本來就會公開在網頁裡；真正的保護是 Firestore 規則。
// 改成 null 的話，資料只會存在這台裝置（不會同步）。
export const firebaseConfig = {
  apiKey: 'AIzaSyAoTyHtbc-VXAPxoF3Kvttg4CNgDB4ATes',
  authDomain: 'tw-go-camping.firebaseapp.com',
  projectId: 'tw-go-camping',
  storageBucket: 'tw-go-camping.firebasestorage.app',
  messagingSenderId: '570828810883',
  appId: '1:570828810883:web:d09cc778ec0305a18209b6',
};
