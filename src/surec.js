// Süreç ağacı okuma — VS Code'a bağımlı değil, bu yüzden düz Node ile test edilebilir.

const { execFile } = require('child_process');

function calistir(komut, argumanlar) {
  return new Promise((coz) => {
    execFile(komut, argumanlar, { maxBuffer: 16 * 1024 * 1024 }, (hata, cikti) => coz(hata ? '' : cikti));
  });
}

/** ppid → [{pid, komut}] eşlemesi. Tarama başına tek `ps` çağrısı. */
async function surecAgaci() {
  const cikti = await calistir('/bin/ps', ['-Ao', 'pid=,ppid=,command=']);
  const agac = new Map();
  for (const satir of cikti.split('\n')) {
    const e = satir.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!e) continue;
    const ppid = Number(e[2]);
    if (!agac.has(ppid)) agac.set(ppid, []);
    agac.get(ppid).push({ pid: Number(e[1]), komut: e[3].trim() });
  }
  return agac;
}

/**
 * Kabuğun ön planda çalıştırdığı komut.
 *
 * DOĞRUDAN çocuğa bakılır, en derine inilmez: `npm run dev` için ağaç
 * zsh→npm→node diye uzar ama kullanıcının yazdığı satır `npm run dev`'dir.
 * En derindeki `node …` geri yüklemek için kullanışsızdır.
 */
function onPlanKomutu(agac, kabukPid) {
  const cocuklar = agac.get(kabukPid) || [];
  // Taramanın kendi araçları ve anlık yardımcılar komut sayılmamalı.
  const gecici = /(^|\/)(ps|lsof|which|env|sleep|stty|tput|grep|awk|sed)(\s|$)/;
  const adaylar = cocuklar.filter((c) => !gecici.test(c.komut));
  if (!adaylar.length) return null;
  return adaylar.sort((a, b) => b.pid - a.pid)[0].komut;
}

/** Birden çok pid'in çalışma dizinini tek `lsof` çağrısıyla okur. */
async function calismaDizinleri(pidler) {
  if (!pidler.length) return new Map();
  const cikti = await calistir('/usr/sbin/lsof', ['-a', '-p', pidler.join(','), '-d', 'cwd', '-Fpn']);
  const sonuc = new Map();
  let mevcut = null;
  for (const satir of cikti.split('\n')) {
    if (satir.startsWith('p')) mevcut = Number(satir.slice(1));
    else if (satir.startsWith('n') && mevcut) sonuc.set(mevcut, satir.slice(1));
  }
  return sonuc;
}

// MARK: - Claude oturumları

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Bir komut Claude Code oturumu mu? (`claude`, `claude -c`, `claude --resume …`) */
function claudeMi(komut) {
  const ilk = (komut || '').trim().split(/\s+/)[0].split('/').pop();
  return ilk === 'claude';
}

/** Komutta zaten bir oturum kimliği varsa onu al — en kesin kaynak budur. */
function komuttakiOturumKimligi(komut) {
  const e = (komut || '').match(/(?:--resume|-r)\s+([0-9a-f-]{36})/i);
  return e ? e[1] : null;
}

/**
 * Bir çalışma dizininin Claude oturum dosyaları ve son yazılma zamanları.
 * Claude, kaydı `~/.claude/projects/<yol-tireli>/<kimlik>.jsonl` altında tutar
 * ve konuştukça dosyaya ekler.
 */
function oturumDosyalari(cwd) {
  if (!cwd) return [];
  const dizin = path.join(os.homedir(), '.claude', 'projects', cwd.split('/').join('-'));
  let dosyalar;
  try { dosyalar = fs.readdirSync(dizin); } catch { return []; }
  return dosyalar.filter((d) => d.endsWith('.jsonl')).map((d) => {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dizin, d)).mtimeMs; } catch { /* atla */ }
    return { kimlik: d.replace(/\.jsonl$/, ''), mtime };
  });
}

/**
 * Eklenti çalışırken GERÇEKTEN yazılmış oturumların hafızası.
 *
 * Neden gerekli: yalnız mtime'a bakmak yanıltıyor — ölçümde bir klasörde son üç
 * saatte 10 dosya değişmişti ama açık oturum 3-4 taneydi (kapatılmış oturumlar ve
 * alt-ajan yazıları da tazedir). Bir dosyanın biz izlerken büyümesi ise o oturumun
 * KESİN açık olduğunu gösterir. Bu yüzden önce "izlerken yazılanlar", sonra
 * mtime sırası kullanılır.
 */
const canliOturumlar = new Map();   // cwd → Map(kimlik → son görülen mtime)
const yazanOturumlar = new Map();   // cwd → Map(kimlik → yazıldığı an)

function oturumlariIzle(cwd) {
  if (!cwd) return;
  if (!canliOturumlar.has(cwd)) canliOturumlar.set(cwd, new Map());
  if (!yazanOturumlar.has(cwd)) yazanOturumlar.set(cwd, new Map());
  const gecmis = canliOturumlar.get(cwd);
  const yazanlar = yazanOturumlar.get(cwd);

  for (const { kimlik, mtime } of oturumDosyalari(cwd)) {
    const onceki = gecmis.get(kimlik);
    if (onceki !== undefined && mtime > onceki) yazanlar.set(kimlik, Date.now());
    gecmis.set(kimlik, mtime);
  }
}

/**
 * Bir çalışma dizinine ait, açık olma ihtimali en yüksek oturum kimlikleri.
 * Önce biz izlerken yazılanlar (en son yazan başta), sonra mtime sırası.
 */
function claudeOturumKimlikleri(cwd, tazelikDakika = 180) {
  const sinir = Date.now() - tazelikDakika * 60 * 1000;
  const hepsi = oturumDosyalari(cwd).filter((d) => d.mtime > sinir);
  const yazanlar = yazanOturumlar.get(cwd) || new Map();

  const kesin = [...yazanlar.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const kalan = hepsi.sort((a, b) => b.mtime - a.mtime).map((d) => d.kimlik)
    .filter((k) => !kesin.includes(k));
  return [...kesin, ...kalan];
}

/**
 * Claude sekmelerine oturum kimliği iliştirir — asıl mesele bu.
 *
 * `claude --continue` yeterli değil: aynı klasörde birden fazla oturum varsa
 * hepsi EN SON oturuma bağlanır, diğerleri kaybolur (Beyefendi'nin makinesinde
 * tek klasörde üç oturum ölçüldü). Bunun yerine her sekmeye ayrı bir kimlik
 * veriyoruz; geri yüklemede `claude --resume <kimlik>` tam o konuşmayı açar.
 */
function claudeOturumlariniEsle(kayitlar, gunluk = () => {}) {
  const klasorler = new Map();
  for (const k of kayitlar) {
    if (!claudeMi(k.komut)) continue;
    // Komut zaten `--resume <kimlik>` içeriyorsa en kesin bilgi odur.
    const dogrudan = komuttakiOturumKimligi(k.komut);
    if (dogrudan) { k.claudeOturum = dogrudan; continue; }
    if (!klasorler.has(k.cwd)) klasorler.set(k.cwd, []);
    klasorler.get(k.cwd).push(k);
  }

  for (const [cwd, sekmeler] of klasorler) {
    oturumlariIzle(cwd);
    const kimlikler = claudeOturumKimlikleri(cwd);
    const kullanilmis = new Set(kayitlar.map((k) => k.claudeOturum).filter(Boolean));
    const uygun = kimlikler.filter((id) => !kullanilmis.has(id));
    sekmeler.forEach((sekme, i) => { if (uygun[i]) sekme.claudeOturum = uygun[i]; });
    gunluk(`claude eşleme — ${cwd}: ${sekmeler.length} sekme, ${uygun.length} taze oturum`);
  }
}

module.exports = {
  surecAgaci, onPlanKomutu, calismaDizinleri,
  claudeMi, komuttakiOturumKimligi, claudeOturumKimlikleri, claudeOturumlariniEsle,
  oturumlariIzle
};
