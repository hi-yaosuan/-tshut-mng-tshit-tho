// 資料層：畫面只透過這裡讀寫資料。
// 目前是 LocalStore（存在瀏覽器 localStorage），之後換成 FirebaseStore 時介面不變。
//
// 資料結構（對應 Firestore：trips/{tripId}/{collection}/{docId}）
//   meta     : 'trip' 一筆 { name, startDate, days }
//   units    : { name, size, order }                       單位，size = 人數
//   gear     : { name, source:'rent'|'own'|'buy', need, shop, model, price, qty,
//                payer, sharedBy:[unitId], claims:{ unitId: note }, note }
//   meals    : { day, slot, unitId, title, note }          某天某餐由誰負責
//   items    : { name, qty, mealId|null, mode:'buy'|'bring', unitId, store, done }
//   expenses : { title, amount, payer, sharedBy:[unitId], note }

export const DELETE = { __delete: true };

const COLLECTIONS = ['meta', 'units', 'gear', 'meals', 'items', 'expenses'];

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 每筆資料記建立時間（at），讀出來時照這個排序；Firestore 的文件 id 是亂數，不能靠 id 排
let seq = 0;
const stamp = (data) => (data.at == null ? { ...data, at: Date.now() * 1000 + (seq++ % 1000) } : data);
const byCreated = (a, b) => (a.at ?? 0) - (b.at ?? 0); // 沒有 at 的舊資料維持原本順序

// 支援 'claims.u1' 這種路徑，讓兩個人同時認領同一件裝備時不會互相覆蓋
function applyPatch(doc, patch) {
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.split('.');
    let target = doc;
    for (const k of keys.slice(0, -1)) target = target[k] ??= {};
    const last = keys[keys.length - 1];
    if (value === DELETE) delete target[last];
    else target[last] = structuredClone(value);
  }
  return doc;
}

export class LocalStore {
  constructor(tripId) {
    this.key = 'camp:' + tripId;
    this.listeners = {};
    this.data = this.load();
    window.addEventListener('storage', (e) => {
      if (e.key !== this.key) return;
      this.data = this.load();
      COLLECTIONS.forEach((c) => this.emit(c));
    });
  }

  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) || 'null');
      if (raw) return raw;
    } catch {}
    return Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
  }

  isEmpty() {
    return Object.keys(this.data.meta || {}).length === 0;
  }

  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch {}
  }

  emit(col) {
    const docs = Object.entries(this.data[col] || {}).map(([id, d]) => ({ id, ...d })).sort(byCreated);
    (this.listeners[col] || []).forEach((cb) => cb(docs, { fromCache: false }));
  }

  async flush() {}

  subscribe(col, cb) {
    (this.listeners[col] ??= []).push(cb);
    this.emit(col);
  }

  async add(col, data, id = newId()) {
    (this.data[col] ??= {})[id] = structuredClone(stamp(data));
    this.save();
    this.emit(col);
    return id;
  }

  async update(col, id, patch) {
    const doc = this.data[col]?.[id];
    if (!doc) return;
    applyPatch(doc, patch);
    this.save();
    this.emit(col);
  }

  async remove(col, id) {
    delete this.data[col]?.[id];
    this.save();
    this.emit(col);
  }

  async reset() {
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
    this.save();
    COLLECTIONS.forEach((c) => this.emit(c));
  }
}

// ---------- Firebase Firestore ----------
// 寫入不等伺服器回應：畫面立刻更新，沒網路時先存在手機，有網路再自動同步。
const FIREBASE_VERSION = '10.14.1';

export async function createFirebaseStore(config, tripId) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [{ initializeApp, getApps }, fs] = await Promise.all([import(`${base}/firebase-app.js`), import(`${base}/firebase-firestore.js`)]);
  const app = getApps()[0] || initializeApp(config);
  let db;
  try {
    db = fs.initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }
  return new FirebaseStore(fs, db, tripId);
}

export function newTripId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const buf = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(buf, (b) => chars[b % chars.length]).join('');
}

class FirebaseStore {
  constructor(fs, db, tripId) {
    this.fs = fs;
    this.db = db;
    this.tripId = tripId;
    this.pending = new Set();
    this.onError = null;
  }

  col(col) { return this.fs.collection(this.db, 'trips', this.tripId, col); }
  ref(col, id) { return this.fs.doc(this.db, 'trips', this.tripId, col, id); }

  track(p) {
    this.pending.add(p);
    p.catch((e) => this.onError?.(e)).finally(() => this.pending.delete(p));
    return p;
  }

  // 等所有寫入真的送到伺服器（換頁前用）
  async flush() { await Promise.allSettled([...this.pending]); }

  subscribe(col, cb) {
    return this.fs.onSnapshot(this.col(col), { includeMetadataChanges: true }, (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byCreated), { fromCache: snap.metadata.fromCache });
    }, (e) => this.onError?.(e));
  }

  async add(col, data, id) {
    const r = id ? this.ref(col, id) : this.fs.doc(this.col(col));
    this.track(this.fs.setDoc(r, stamp(data)));
    return r.id;
  }

  async update(col, id, patch) {
    const p = {};
    for (const [k, v] of Object.entries(patch)) p[k] = v === DELETE ? this.fs.deleteField() : v;
    this.track(this.fs.updateDoc(this.ref(col, id), p));
  }

  async remove(col, id) {
    this.track(this.fs.deleteDoc(this.ref(col, id)));
  }

  async reset() {
    for (const c of COLLECTIONS) {
      const snap = await this.fs.getDocs(this.col(c));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = this.fs.writeBatch(this.db);
        snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        this.track(batch.commit());
      }
    }
  }
}
