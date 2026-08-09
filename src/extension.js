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
  surecAgaci, onPlanKomutu, calismaDizinleri,
  claudeMi, komuttakiOturumKimligi, claudeOturumKimlikleri, claudeOturumlariniEsle
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
    const komut = entegrasyonKomutu.get(t) || onPlanKomutu(agac, pid);
    if (!komut) continue;
    if (hariç.some((r) => r.test(komut))) { gunluk(`atlandı (hariç): ${komut}`); continue; }

    const cwd = (t.shellIntegration && t.shellIntegration.cwd && t.shellIntegration.cwd.fsPath)
      || dizinler.get(pid) || null;
    kayitlar.push({ ad: t.name, cwd, komut });
  }

  claudeOturumlariniEsle(kayitlar, gunluk);
  return kayitlar;
}

/** Bir önceki taramanın sonucu — kısa ömürlü komutları elemek için. */
let oncekiTarama = [];

/**
 * Yalnızca İKİ ARDIŞIK taramada da görülen komutlar kaydedilir.
 *
 * Kara liste tutmak yerine bu kural kullanılıyor: `head`, `grep`, `ls` gibi anlık
 * komutlar iki tarama arasını (varsayılan 5 sn) yaşayamaz; `claude`, `npm run dev`,
 * `tail -f` gibi asıl kaydetmek istediklerimiz yaşar. Ölçümde tam da bu gerekti —
 * tarama sırasında çalışan `head -60` yanlışlıkla kaydediliyordu.
 */
function onaylananlar(mevcut) {
  return mevcut.filter((k) => oncekiTarama.some((o) => o.ad === k.ad && o.komut === k.komut));
}

async function kaydet(context, sessiz = true) {
  try {
    const mevcut = await anlikGoruntu();
    const kayitlar = onaylananlar(mevcut);
    oncekiTarama = mevcut;

    // Kapanış sırasında terminaller teker teker yok olur; boş bir anlık görüntüyü
    // yazarsak son iyi durumu kaybederiz. Bu yüzden boş sonuç kaydı EZMEZ.
    if (!kayitlar.length) { if (!sessiz) gunluk('kaydedilecek kalıcı komut yok'); return; }
    await context.globalState.update(ANAHTAR, kayitlar);
    await context.globalState.update(ANAHTAR_ZAMAN, Date.now());
    gunluk(`kaydedildi: ${kayitlar.length} komut — ${kayitlar.map((k) => k.komut.slice(0, 30)).join(' | ')}`);
  } catch (e) {
    gunluk(`kaydetme hatası: ${e && e.message}`);
  }
}

// MARK: - Geri yükleme

/** Kaydı canlı terminalle eşler: önce ad+dizin, olmazsa yalnız ad. */
function eslestir(kayit, terminaller, kullanilan) {
  const uygun = (t) => !kullanilan.has(t);
  let bulunan = terminaller.find((t) => uygun(t) && t.name === kayit.ad
    && (!kayit.cwd || !t.shellIntegration || !t.shellIntegration.cwd
        || t.shellIntegration.cwd.fsPath === kayit.cwd));
  if (!bulunan) bulunan = terminaller.find((t) => uygun(t) && t.name === kayit.ad);
  return bulunan || null;
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
  const terminaller = [...vscode.window.terminals];
  const kullanilan = new Set();
  let sayac = 0;

  for (const kayit of kayitlar) {
    const hedef = eslestir(kayit, terminaller, kullanilan);
    const terminal = hedef || vscode.window.createTerminal({ name: kayit.ad, cwd: kayit.cwd || undefined });
    kullanilan.add(terminal);
    const komut = komutuDonustur(kayit.komut, kayit);
    terminal.sendText(komut, calistirilsinMi);
    sayac++;
    gunluk(`geri yüklendi${calistirilsinMi ? ' (çalıştırıldı)' : ' (yazıldı, ENTER bekliyor)'}: ${komut}`);
  }
  return sayac;
}

async function acilistaSor(context) {
  const kayitlar = context.globalState.get(ANAHTAR, []);
  if (!kayitlar.length) { gunluk('kayıt yok'); return; }

  // Yenilemede süreçler yaşar; hâlâ çalışıyorlarsa sormaya gerek yok.
  const mevcut = await anlikGoruntu();
  const halaCalisan = new Set(mevcut.map((k) => k.komut));
  const eksik = kayitlar.filter((k) => !halaCalisan.has(k.komut));
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

// MARK: - Etkinleşme

function activate(context) {
  ANAHTAR = `terminalHafiza.kayitlar::${pencereAnahtari()}`;
  ANAHTAR_ZAMAN = `terminalHafiza.kayitZamani::${pencereAnahtari()}`;
  gunluk(`Terminal Hafızası etkin — pencere: ${pencereAnahtari()}`);

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
    vscode.window.onDidCloseTerminal((t) => entegrasyonKomutu.delete(t))
  );

  const aralik = Math.max(2, ayar('kayitAraligiSaniye', 5)) * 1000;
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
    vscode.commands.registerCommand('terminalHafiza.gunlukGoster', () => cikis && cikis.show())
  );

  // Terminallerin canlanması için biraz bekle, sonra sor.
  setTimeout(() => acilistaSor(context).catch((e) => gunluk(`açılış hatası: ${e && e.message}`)),
    Math.max(1000, ayar('acilisGecikmesiMs', 4000)));
}

function deactivate() { if (zamanlayici) clearInterval(zamanlayici); }

module.exports = { activate, deactivate };
