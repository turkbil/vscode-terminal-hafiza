// Terminal Hafızası — VS Code kapanıp açılınca terminallerde ne çalışıyorduysa geri getirir.
//
// Neden gerekli (ölçüldü, 9 Ağu 2026):
//   Tam kapanmada VS Code terminalleri yeniden yaratıyor — ad ✅, çalışma dizini ✅,
//   kaydırma geçmişi ✅ — ama kabuk süreçleri ölüyor ve çalışan komutlar geri gelmiyor.
//   Pencere yenilemede (Reload Window) ise süreçler yaşar; orada yapacak bir şey yok.
//
// Komut nasıl yakalanıyor: kabuk entegrasyonu her kurulumda güvenilir olmadığı için
// asıl yöntem süreç ağacı — terminalin kabuk pid'inin DOĞRUDAN çocuğu, kullanıcının
// yazdığı ön plan komutudur (zsh → claude, zsh → npm run dev). Kabuk entegrasyonu
// varsa komutun tam metnini oradan alıp üstüne yazıyoruz.

const vscode = require('vscode');
const {
  surecAgaci, onPlanSureci, calismaDizinleri,
  claudeSurecOturumu, baslikNormal, otomatikBaslikMi,
  claudeMi, komuttakiOturumKimligi, claudeOturumlariniEsle
} = require('./surec');

/**
 * Kayıt anahtarı PENCEREYE ÖZEL olmak zorunda.
 *
 * `globalState` bütün pencerelerde ortaktır: aynı anda beş VS Code penceresi
 * açıksa beşi de aynı anahtara yazar ve son yazan diğerlerinin terminallerini
 * siler. Anahtarı açık klasöre bağlayarak her pencere kendi kaydını tutar;
 * yeniden açılışta da doğru pencereye doğru terminaller döner.
 */
function pencereAnahtari() {
  const kok = vscode.workspace.workspaceFile
    ? vscode.workspace.workspaceFile.fsPath
    : (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath).sort().join('|');
  return kok || 'bos-pencere';
}

// Etkinleşmede pencereye özel hâline getirilir; API hazır olmadan okumayalım.
let ANAHTAR = 'terminalHafiza.kayitlar';
let ANAHTAR_ZAMAN = 'terminalHafiza.kayitZamani';

let zamanlayici = null;
let cikis = null;
/** Terminal → kabuk entegrasyonundan yakalanan son komut. */
const entegrasyonKomutu = new Map();

function gunluk(satir) {
  if (!cikis) cikis = vscode.window.createOutputChannel('Terminal Hafızası');
  cikis.appendLine(`${new Date().toISOString().slice(11, 19)}  ${satir}`);
}

function ayar(anahtar, varsayilan) {
  return vscode.workspace.getConfiguration('terminalHafiza').get(anahtar, varsayilan);
}

// MARK: - Tarama ve kaydetme

async function anlikGoruntu() {
  const terminaller = vscode.window.terminals;
  if (!terminaller.length) return [];

  const agac = await surecAgaci();
  const pidler = [];
  for (const t of terminaller) {
    const pid = await t.processId;
    if (pid) pidler.push(pid);
  }
  const dizinler = await calismaDizinleri(pidler);
  const hariç = ayar('haricTutulanlar', ['^rm\\b', '^git push', '^sudo\\b']).map((k) => new RegExp(k));

  const kayitlar = [];
  for (const t of terminaller) {
    const pid = await t.processId;
    if (!pid) continue;

    // Kabuk entegrasyonu varsa komutun tam metni oradan gelir; yoksa süreç ağacından.
    // Kabukta ön planda süreç yoksa, entegrasyonun hatırladığı eski komut sayılmaz.
    const surec = onPlanSureci(agac, pid);
    if (!surec) continue;
    const komut = entegrasyonKomutu.get(t) || surec.komut;
    if (hariç.some((r) => r.test(komut))) { gunluk(`atlandı (hariç): ${komut}`); continue; }

    const cwd = (t.shellIntegration && t.shellIntegration.cwd && t.shellIntegration.cwd.fsPath)
      || dizinler.get(pid) || null;
    const kayit = { ad: t.name, adOtomatik: otomatikBaslikMi(t.name), cwd, komut };

    // Claude ise oturumu süreçten KESİN oku.
    const oturum = claudeSurecOturumu(agac, pid);
    if (oturum) {
      kayit.claudeOturum = oturum.kimlik;
      if (oturum.ad) kayit.claudeAd = oturum.ad;
      if (!claudeMi(kayit.komut)) kayit.komut = 'claude';
    }

    // Sekme nesnesi kayda gizli alan olarak bağlanır: JSON'a girmez, ama iki
    // tarama arasında «aynı sekme mi» sorusunu adla değil kimlikle cevaplar.
    Object.defineProperty(kayit, 'sekme', { value: t, enumerable: false });
    kayitlar.push(kayit);
    sekmeKaydi.set(t, kayit);
  }

  claudeOturumlariniEsle(kayitlar);
  return kayitlar;
}

/** İki kayıt aynı işi mi gösteriyor? Claude'da oturum, ötekilerde komut. */
function ayniIs(a, b) {
  if (a.claudeOturum || b.claudeOturum) return a.claudeOturum === b.claudeOturum;
  return a.komut === b.komut;
}

/**
 * Terminal → o sekmede en son ne çalıştığı.
 *
 * Sekme kapandığında süreç çoktan ölmüştür; `ps` ile artık okunamaz. Kapanışta
 * elimizde kalan tek bilgi son taramadan gelen bu kayıttır — bu yüzden tutuluyor.
 */
const sekmeKaydi = new Map();

/** Bir önceki taramanın sonucu — kısa ömürlü komutları elemek için. */
let oncekiTarama = [];

/**
 * Yalnızca İKİ ARDIŞIK taramada da görülen komutlar kaydedilir.
 *
 * Kara liste tutmak yerine bu kural kullanılıyor: anlık komutlar iki tarama arasını
 * yaşayamaz, uzun süren işler yaşar. Ölçümde tam da bu gerekti — tarama sırasında
 * çalışan `head -60` yanlışlıkla kaydediliyordu.
 *
 * Bu kural aynı zamanda eşiği belirler: aralık 60 sn ise yalnızca bir dakikadan uzun
 * süren işler (claude oturumları, `npm run dev`, izleyiciler) kaydedilir. Kısa işleri
 * hatırlamanın zaten değeri yok.
 */
/**
 * Eşleme ADLA değil SEKMEYLE yapılır: Claude'un canlı başlığı her taramada
 * değişir (✳ → ◐ → ◑); adla eşlenince tam da ÇALIŞAN oturumlar kayda girmiyordu.
 *
 * Silme de iki tarama ister: kayıtlı bir iş bu taramada yok ama bir önceki
 * taramada vardıysa ve sekmesi hâlâ açıksa bir tur daha tutulur. Kapanış anında
 * süreçler teker teker ölürken yarım bir görüntü son iyi kaydı ezmesin diye.
 */
function onaylananlar(mevcut, acikSekmeler) {
  const onayli = mevcut.filter((k) => oncekiTarama.some((o) => o.sekme === k.sekme && ayniIs(o, k)));
  const tutulan = sonKaydedilen.filter((s) =>
    acikSekmeler.has(s.sekme)
    && !onayli.some((k) => k.sekme === s.sekme)
    && oncekiTarama.some((o) => o.sekme === s.sekme && ayniIs(o, s)));
  return [...onayli, ...tutulan];
}

/** En son diske yazılan kaydın imzası — değişmediyse ne yazarız ne günlüğe basarız. */
let sonImza = '';
/** En son diske yazılan kayıtlar (sekme bağıyla, yalnız bellekte). */
let sonKaydedilen = [];

async function kaydet(context, sessiz = true) {
  try {
    const mevcut = await anlikGoruntu();
    const kayitlar = onaylananlar(mevcut, new Set(vscode.window.terminals));
    oncekiTarama = mevcut;

    // Kapanış sırasında terminaller teker teker yok olur; boş bir anlık görüntüyü
    // yazarsak son iyi durumu kaybederiz. Bu yüzden boş sonuç kaydı EZMEZ.
    if (!kayitlar.length) { if (!sessiz) gunluk('kaydedilecek kalıcı komut yok'); return; }

    // Tarama sürekli döner ama tablo çoğu zaman aynıdır. Her turda yazmak hem
    // diski hem günlüğü boş yere doldurur; yalnızca DEĞİŞİNCE yazıyoruz.
    const imza = JSON.stringify(kayitlar);
    if (imza === sonImza) { if (!sessiz) gunluk(`değişiklik yok — ${kayitlar.length} komut kayıtlı`); return; }
    sonImza = imza;
    sonKaydedilen = kayitlar;

    await context.globalState.update(ANAHTAR, kayitlar);
    await context.globalState.update(ANAHTAR_ZAMAN, Date.now());
    gunluk(`kaydedildi: ${kayitlar.length} komut — ${kayitlar.map((k) => k.komut.slice(0, 30)).join(' | ')}`);
  } catch (e) {
    gunluk(`kaydetme hatası: ${e && e.message}`);
  }
}

// MARK: - Kapanan sekmeler

const ANAHTAR_KAPANAN = () => `terminalHafiza.kapananlar::${pencereAnahtari()}`;

/** Kapananlar listesini, süresi geçenleri atarak okur. */
function kapananlariOku(context) {
  const saat = ayar('kapananSaklamaSaati', 24);
  const sinir = Date.now() - saat * 60 * 60 * 1000;
  return (context.globalState.get(ANAHTAR_KAPANAN(), []) || []).filter((k) => k.kapanma > sinir);
}

/**
 * Sekme kapanınca ANINDA devreye girer — 60 saniyelik taramayı beklemez.
 *
 * Yanlışlıkla kapatılan bir Claude sekmesi, bir sonraki taramaya kadar
 * beklenirse kayıttan da düşer ve konuşma tamamen kaybolur. Kapanış olayında
 * son bilinen kaydı ayrı bir listeye alıp hemen diske yazıyoruz.
 */
async function sekmeKapandi(context, terminal) {
  const kayit = sekmeKaydi.get(terminal);
  sekmeKaydi.delete(terminal);
  entegrasyonKomutu.delete(terminal);
  if (!kayit) return;   // içinde kayda değer bir şey çalışmıyordu

  const liste = kapananlariOku(context);
  liste.unshift({ ...kayit, kapanma: Date.now() });
  await context.globalState.update(ANAHTAR_KAPANAN(), liste.slice(0, 50));
  gunluk(`sekme kapandı, saklandı: ${kayit.komut.slice(0, 50)}`);

  if (!ayar('kapanistaSor', true)) return;
  const komut = komutuDonustur(kayit.komut, kayit);
  const kisa = claudeMi(kayit.komut) ? 'Claude oturumu' : kayit.komut.slice(0, 32);
  const secim = await vscode.window.showWarningMessage(
    `Kapanan sekmede ${kisa} çalışıyordu.`, 'Geri aç', 'Boş ver'
  );
  if (secim !== 'Geri aç') return;
  const yeni = sekmeAc(kayit);
  yeni.show(true);
  setTimeout(() => yeni.sendText(komut, true), 1200);
  gunluk(`kapanan sekme geri açıldı: ${komut}`);
}

// MARK: - Geri yükleme

/** Kayıttan yeni sekme açar. Elle verilmiş ad aynen konur; kendiliğinden başlık konmaz. */
function sekmeAc(kayit) {
  const otomatik = kayit.adOtomatik !== undefined ? kayit.adOtomatik : otomatikBaslikMi(kayit.ad);
  const ad = !otomatik ? kayit.ad : (kayit.claudeAd || undefined);
  return vscode.window.createTerminal({ name: ad, cwd: kayit.cwd || undefined });
}

/**
 * VS Code'un kendi canlandırdığı sekmeleri bulur — bölünmüş (iç içe) düzen ve
 * sıra yalnız onlarda korunur; yeni sekme açmak düzeni düzleştirir.
 *
 * Yalnız içinde süreç ÇALIŞMAYAN (boş kabuk) sekmeler aday sayılır.
 * 1. tur: başlık birebir ya da durum simgesi atılınca aynı (+ dizin uyumu).
 * 2. tur: kendiliğinden başlıklı Claude kaydı, aynı dizindeki kendiliğinden
 *    başlıklı boş sekmeye — Claude'un başlığı kapanışla açılış arasında değişebilir.
 */
function eslestir(kayitlar, terminaller, bosMu, cwdSi) {
  const esler = new Map();
  const kullanilan = new Set();
  const dizinUyar = (k, t) => !k.cwd || !cwdSi(t) || cwdSi(t) === k.cwd;
  const adaylar = terminaller.filter(bosMu);

  for (const k of kayitlar) {
    const t = adaylar.find((x) => !kullanilan.has(x) && dizinUyar(k, x)
      && (x.name === k.ad || (baslikNormal(x.name) && baslikNormal(x.name) === baslikNormal(k.ad))));
    if (t) { esler.set(k, t); kullanilan.add(t); }
  }
  for (const k of kayitlar) {
    if (esler.has(k) || !claudeMi(k.komut)) continue;
    if (!(k.adOtomatik !== undefined ? k.adOtomatik : otomatikBaslikMi(k.ad))) continue;
    const t = adaylar.find((x) => !kullanilan.has(x) && k.cwd && cwdSi(x) === k.cwd && otomatikBaslikMi(x.name));
    if (t) { esler.set(k, t); kullanilan.add(t); }
  }
  return esler;
}

/** Aynı Claude oturumu iki sekmede açılmasın — iki süreç tek konuşmaya yazarsa konuşma bozulur. */
function tekillestir(kayitlar) {
  const gorulen = new Set();
  return kayitlar.filter((k) => {
    if (!k.claudeOturum) return true;
    if (gorulen.has(k.claudeOturum)) { gunluk(`yinelenen oturum atlandı: ${k.claudeOturum}`); return false; }
    gorulen.add(k.claudeOturum);
    return true;
  });
}

/** Kaydı, geri yüklenecek gerçek komuta çevirir. */
function komutuDonustur(komut, kayit) {
  // Claude sekmesi: kimlik varsa tam o konuşmayı aç. Kimlik yakalanamadıysa
  // `--continue` son konuşmaya döner — hiç yoktan iyidir ama kesin değildir.
  if (claudeMi(komut)) {
    if (kayit && kayit.claudeOturum) return `claude --resume ${kayit.claudeOturum}`;
    return komuttakiOturumKimligi(komut) ? komut : 'claude --continue';
  }
  const kurallar = ayar('komutDonusumleri', {});
  const ilkSozcuk = komut.trim().split(/\s+/)[0].split('/').pop();
  if (komut.trim() !== ilkSozcuk) return komut;
  return Object.prototype.hasOwnProperty.call(kurallar, ilkSozcuk) ? kurallar[ilkSozcuk] : komut;
}

async function geriYukle(context, kayitlar, calistirilsinMi) {
  kayitlar = tekillestir(kayitlar);
  const terminaller = [...vscode.window.terminals];
  const agac = await surecAgaci();
  const pidler = new Map();
  for (const t of terminaller) pidler.set(t, await t.processId);
  const dizinler = await calismaDizinleri([...pidler.values()].filter(Boolean));
  const bosMu = (t) => pidler.get(t) && !onPlanSureci(agac, pidler.get(t));
  const cwdSi = (t) => (t.shellIntegration && t.shellIntegration.cwd && t.shellIntegration.cwd.fsPath)
    || dizinler.get(pidler.get(t)) || null;
  const esler = eslestir(kayitlar, terminaller, bosMu, cwdSi);
  let sayac = 0;

  for (const kayit of kayitlar) {
    const hedef = esler.get(kayit);
    const terminal = hedef || sekmeAc(kayit);
    const komut = komutuDonustur(kayit.komut, kayit);
    terminal.sendText(komut, calistirilsinMi);
    sayac++;
    gunluk(`geri yüklendi${hedef ? ' (yerinde)' : ' (yeni sekme)'}${calistirilsinMi ? '' : ' (ENTER bekliyor)'}: ${komut}`);
  }
  return sayac;
}

async function acilistaSor(context) {
  const kayitlar = context.globalState.get(ANAHTAR, []);
  if (!kayitlar.length) { gunluk('kayıt yok'); return; }

  // Yenilemede süreçler yaşar; hâlâ çalışıyorlarsa sormaya gerek yok.
  // Claude'da oturum kimliği, ötekilerde komut karşılaştırılır — tek bir düz
  // `claude` çalışıyor diye bütün `claude` kayıtları «açık» sayılmasın.
  const mevcut = await anlikGoruntu();
  const eksik = tekillestir(kayitlar.filter((k) => !mevcut.some((m) => ayniIs(m, k))));
  if (!eksik.length) { gunluk('kayıtlı komutlar zaten çalışıyor, sorulmadı'); return; }

  // Bildirim butonları dar: VS Code uzun etiketleri "Hepsini çalı…" diye kesiyor
  // (ölçüldü). Bu yüzden yalnızca iki KISA buton; ayrıntılı seçenekler, yeri bol
  // olan hızlı seçim listesine taşındı.
  const secim = await vscode.window.showInformationMessage(
    `${eksik.length} terminalde komut vardı. Geri yükleyeyim mi?`,
    'Geri yükle', 'Seçenekler'
  );

  if (!secim) { gunluk('kullanıcı bildirimi kapattı'); return; }

  if (secim === 'Geri yükle') {
    const n = await geriYukle(context, eksik, true);
    vscode.window.showInformationMessage(`${n} komut geri yüklendi.`);
    return;
  }

  const secenek = await vscode.window.showQuickPick([
    { label: '$(play) Hepsini çalıştır', kod: 'hepsi', detail: `${eksik.length} komut hemen çalışsın` },
    { label: '$(checklist) Tek tek seç', kod: 'sec', detail: 'Hangileri geri gelsin, listeden işaretle' },
    { label: '$(edit) Yaz, ENTER\'a ben basayım', kod: 'yaz', detail: 'Komutlar terminale yazılır ama çalıştırılmaz' },
    { label: '$(x) Vazgeç', kod: 'iptal', detail: 'Hiçbir şey yapma' }
  ], { title: `${eksik.length} kayıtlı komut — ne yapayım?` });

  if (!secenek || secenek.kod === 'iptal') { gunluk('kullanıcı vazgeçti'); return; }

  if (secenek.kod === 'sec') {
    const secilenler = await vscode.window.showQuickPick(
      eksik.map((k) => ({
        label: k.komut.length > 60 ? k.komut.slice(0, 60) + '…' : k.komut,
        description: k.ad,
        detail: k.cwd || '',
        picked: true,
        kayit: k
      })),
      { canPickMany: true, title: 'Hangi komutlar geri yüklensin?' }
    );
    if (!secilenler || !secilenler.length) return;
    const n = await geriYukle(context, secilenler.map((s) => s.kayit), true);
    vscode.window.showInformationMessage(`${n} komut geri yüklendi.`);
    return;
  }

  const calistir = secenek.kod === 'hepsi';
  const n = await geriYukle(context, eksik, calistir);
  vscode.window.showInformationMessage(
    calistir ? `${n} komut geri yüklendi.` : `${n} komut yazıldı — ENTER size kaldı.`
  );
}

// MARK: - Uçtan uca kendi kendine test (yalnızca geliştirme)
//
// `tail -f` seçildi çünkü kabuğun DOĞRUDAN çocuğu olarak yaşayan gerçekçi bir
// uzun süreli komut; `while true; do sleep 1; done` gibi bir döngü kabuğun içinde
// kalır ve dışarıdan yalnızca anlık `sleep 1` görünür.
async function uctanUcaTest(context) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { execFile } = require('child_process');

  const D = path.join(context.extensionPath, 'build', 'e2e');
  fs.mkdirSync(D, { recursive: true });
  const RAPOR = path.join(D, 'rapor.txt');
  const ISARET = path.join(D, 'isaret.json');
  const HAZIR = path.join(D, 'hazir.flag');
  const beslemeA = path.join(D, 'besleme-a.txt');
  const beslemeB = path.join(D, 'besleme-b.txt');
  const not = (s) => fs.appendFileSync(RAPOR, `${new Date().toISOString().slice(11, 19)}  ${s}\n`);
  const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
  const tailPidleri = () => new Promise((coz) => execFile('/bin/ps', ['-Ao', 'pid=,command='],
    (h, c) => coz((c || '').split('\n')
      .filter((s) => s.includes('tail -f') && s.includes('besleme-'))
      .map((s) => s.trim().split(/\s+/)[0]))));

  if (!fs.existsSync(ISARET)) {
    not('A AŞAMASI — iki terminal, uzun süreli komutlar');
    fs.writeFileSync(beslemeA, 'a\n'); fs.writeFileSync(beslemeB, 'b\n');

    const ta = vscode.window.createTerminal({ name: 'e2e-a', cwd: os.homedir() });
    ta.show(false); await bekle(1500); ta.sendText(`tail -f '${beslemeA}'`, true);
    const tb = vscode.window.createTerminal({ name: 'e2e-b', cwd: path.join(os.homedir(), 'Library') });
    tb.show(false); await bekle(1500); tb.sendText(`tail -f '${beslemeB}'`, true);

    // İki tarama turu geçsin ki onay kuralı komutları kabul etsin.
    await bekle(14000);
    const kayitlar = context.globalState.get(ANAHTAR, []);
    const pidler = await tailPidleri();
    fs.writeFileSync(ISARET, JSON.stringify({ pidler }, null, 2));
    not(`  kaydedilen komut sayısı: ${kayitlar.length}`);
    kayitlar.forEach((k) => not(`    "${k.ad}" → ${k.komut}  [${k.cwd}]`));
    not(`  canlı tail pid'leri: ${pidler.join(', ') || 'yok'}`);
    not('A bitti');
    fs.writeFileSync(HAZIR, '1');
    return;
  }

  const onceki = JSON.parse(fs.readFileSync(ISARET, 'utf8'));
  await bekle(5000);
  not('B AŞAMASI — TAM KAPATMA SONRASI');
  const kayitlar = context.globalState.get(ANAHTAR, []);
  not(`  hatırlanan komut sayısı : ${kayitlar.length}`);
  kayitlar.forEach((k) => not(`    "${k.ad}" → ${k.komut}`));
  const oncePidler = await tailPidleri();
  not(`  geri yüklemeden ÖNCE canlı tail: ${oncePidler.join(', ') || 'yok'}`);

  const n = await geriYukle(context, kayitlar, true);
  await bekle(5000);
  const sonraPidler = await tailPidleri();
  not(`  geri yüklenen komut     : ${n}`);
  not(`  geri yüklemeden SONRA canlı tail: ${sonraPidler.join(', ') || 'yok'}`);
  const yeniMi = sonraPidler.length > 0 && !sonraPidler.some((p) => onceki.pidler.includes(p));
  not(`  SONUÇ: ${sonraPidler.length === kayitlar.length && yeniMi
    ? 'KOMUTLAR YENİ SÜREÇLERLE GERİ GELDİ' : 'eksik'}`);
  not('bitti');
}


// Kapanma testi (yalnızca geliştirme) — sekme kapanınca kayıt anında alınıyor mu?
async function kapanmaTesti(context) {
  const fs = require('fs');
  const path = require('path');
  const D = path.join(context.extensionPath, 'build', 'kapanma');
  fs.mkdirSync(D, { recursive: true });
  const RAPOR = path.join(D, 'rapor.txt');
  const besleme = path.join(D, 'besleme.txt');
  fs.writeFileSync(besleme, 'x\n');
  fs.writeFileSync(RAPOR, '');
  const not = (s) => fs.appendFileSync(RAPOR, `${new Date().toISOString().slice(11, 19)}  ${s}\n`);
  const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

  not('terminal açılıyor');
  const t = vscode.window.createTerminal({ name: 'kapanis-testi' });
  t.show(false);
  await bekle(1500);
  t.sendText(`tail -f '${besleme}'`, true);

  await bekle(26000);   // 10 sn aralıkla iki tarama geçsin
  not(`kapatmadan önce kayıt: ${context.globalState.get(ANAHTAR, []).length} komut`);
  not(`kapatmadan önce kapananlar: ${kapananlariOku(context).length}`);

  not('sekme kapatılıyor');
  t.dispose();
  await bekle(3000);

  const kapananlar = kapananlariOku(context);
  not(`kapanış SONRASI kapananlar: ${kapananlar.length}`);
  kapananlar.slice(0, 3).forEach((k) => not(`   "${k.ad}" → ${k.komut}`));
  not(`SONUÇ: ${kapananlar.some((k) => k.ad === 'kapanis-testi') ? 'KAPANAN SEKME ANINDA YAKALANDI' : 'yakalanmadı'}`);
  not('bitti');
}

// MARK: - Etkinleşme

function activate(context) {
  ANAHTAR = `terminalHafiza.kayitlar::${pencereAnahtari()}`;
  ANAHTAR_ZAMAN = `terminalHafiza.kayitZamani::${pencereAnahtari()}`;
  gunluk(`Terminal Hafızası etkin — pencere: ${pencereAnahtari()}`);

  if (process.env.TERMINAL_HAFIZA_KAPANMA === '1') {
    setTimeout(() => kapanmaTesti(context).catch((e) => gunluk(`kapanma testi HATA: ${e && e.stack}`)), 2000);
  }
  if (process.env.TERMINAL_HAFIZA_E2E === '1') {
    setTimeout(() => uctanUcaTest(context).catch((e) => gunluk(`e2e HATA: ${e && e.stack}`)), 2500);
  }

  // Kabuk entegrasyonu varsa komutun tam metnini yakala (süreç ağacından daha isabetli).
  if (vscode.window.onDidStartTerminalShellExecution) {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution((o) => {
        if (o.execution && o.execution.commandLine && o.execution.commandLine.value) {
          entegrasyonKomutu.set(o.terminal, o.execution.commandLine.value);
        }
      }),
      vscode.window.onDidEndTerminalShellExecution((o) => entegrasyonKomutu.delete(o.terminal))
    );
  }
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) =>
      sekmeKapandi(context, t).catch((e) => gunluk(`kapanış hatası: ${e && e.message}`)))
  );

  const aralik = Math.max(10, ayar('kayitAraligiSaniye', 60)) * 1000;
  zamanlayici = setInterval(() => kaydet(context), aralik);
  context.subscriptions.push({ dispose: () => clearInterval(zamanlayici) });

  context.subscriptions.push(
    vscode.commands.registerCommand('terminalHafiza.kaydet', async () => {
      // Onay kuralı iki tarama istiyor; elle kaydederken ikisini arka arkaya yapıyoruz.
      await kaydet(context, true);
      await new Promise((r) => setTimeout(r, 1500));
      await kaydet(context, false);
      const n = context.globalState.get(ANAHTAR, []).length;
      vscode.window.showInformationMessage(`Terminal Hafızası: ${n} komut kayıtlı.`);
    }),
    vscode.commands.registerCommand('terminalHafiza.geriYukle', () => acilistaSor(context)),
    vscode.commands.registerCommand('terminalHafiza.kayitlariGoster', async () => {
      const kayitlar = context.globalState.get(ANAHTAR, []);
      const zaman = context.globalState.get(ANAHTAR_ZAMAN, 0);
      if (!kayitlar.length) { vscode.window.showInformationMessage('Kayıt yok.'); return; }
      await vscode.window.showQuickPick(
        kayitlar.map((k) => ({ label: k.komut, description: k.cwd || '', detail: `terminal: ${k.ad}` })),
        { title: `Son kayıt: ${new Date(zaman).toLocaleString('tr-TR')}` }
      );
    }),
    vscode.commands.registerCommand('terminalHafiza.gunlukGoster', () => cikis && cikis.show()),
    vscode.commands.registerCommand('terminalHafiza.kapananiGeriAc', async () => {
      const liste = kapananlariOku(context);
      if (!liste.length) { vscode.window.showInformationMessage('Son 24 saatte kapanmış kayıtlı sekme yok.'); return; }
      const secim = await vscode.window.showQuickPick(
        liste.map((k) => ({
          label: claudeMi(k.komut) ? `$(comment-discussion) Claude — ${(k.cwd || '').split('/').pop()}` : k.komut.slice(0, 60),
          description: new Date(k.kapanma).toLocaleTimeString('tr-TR'),
          detail: k.cwd || '',
          kayit: k
        })),
        { title: 'Kapanmış sekmelerden hangisini geri açayım?' }
      );
      if (!secim) return;
      const t = sekmeAc(secim.kayit);
      t.show(true);
      setTimeout(() => t.sendText(komutuDonustur(secim.kayit.komut, secim.kayit), true), 1200);
    })
  );

  // Terminallerin canlanması için bekle: önce en az gecikme kadar, sonra sekme
  // sayısı 2 sn boyunca değişmeyene dek (en çok 20 sn). Canlanma bitmeden eşleme
  // yapılırsa geç gelen sekmeler bulunamaz, yerlerine fazladan düz sekme açılırdı.
  setTimeout(() => sekmelerOturunca()
    .then(() => acilistaSor(context))
    .catch((e) => gunluk(`açılış hatası: ${e && e.message}`)),
    Math.max(1000, ayar('acilisGecikmesiMs', 4000)));
}

async function sekmelerOturunca() {
  const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
  let son = -1, sabit = 0;
  for (let i = 0; i < 40 && sabit < 4; i++) {
    const n = vscode.window.terminals.length;
    sabit = n === son ? sabit + 1 : 0;
    son = n;
    await bekle(500);
  }
}

function deactivate() { if (zamanlayici) clearInterval(zamanlayici); }

module.exports = { activate, deactivate, _ic: { eslestir, tekillestir, ayniIs, komutuDonustur } };
