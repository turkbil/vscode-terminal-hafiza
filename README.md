# Terminal Hafızası

VS Code kapanıp açılınca terminallerde ne çalışıyorduysa geri getirir — özellikle
**Claude Code oturumlarını, tam kaldıkları yerden**.

## Neye çözüm?

VS Code'un kendi kalıcılığı iki senaryoda farklı davranıyor (9 Ağu 2026'da ölçüldü):

| | Pencere yenileme (Reload Window) | Tam kapanma / yeniden başlatma |
|---|---|---|
| Terminal sekmeleri | ✅ kalır | ✅ geri gelir |
| Terminal adı | ✅ | ✅ |
| Çalışma dizini | ✅ | ✅ |
| Kaydırma geçmişi | ✅ | ✅ son 100 satır |
| **Çalışan süreç** | ✅ **yaşar** | ❌ **ölür** |

Pencere yenilemede yapacak bir şey yok — kabuklar pty host'ta yaşar, süreçler devam eder.
Sorun tam kapanmada: kabuklar ölür, VS Code sekmeleri yalnızca *yeniden yaratır*, içlerinde
ne çalıştığını bilmez. Bu eklenti o tek eksiği kapatır.

## Claude oturumları neden özel?

`claude --continue` yeterli değil: aynı klasörde birden fazla oturum varsa **hepsi en son
oturuma bağlanır**, diğer konuşmalar kaybolur. Ölçümde tek klasörde üç ayrı oturum vardı.

Bunun yerine eklenti her sekmeye **ayrı bir oturum kimliği** iliştirir ve geri yüklerken
`claude --resume <kimlik>` çalıştırır — tam o konuşma açılır.

Kimlik nasıl bulunuyor:

1. Komutta zaten `--resume <kimlik>` varsa o kullanılır (en kesin).
2. Yoksa `~/.claude/projects/<yol>/` altındaki oturum dosyaları izlenir. Eklenti
   çalışırken **büyüyen** bir dosya, o oturumun kesinlikle açık olduğunu gösterir.
3. O da yoksa son yazılma zamanına göre sıralanır.

> **Dürüst sınır:** süreç → oturum eşlemesi dışarıdan kesin okunamıyor (Claude oturum
> dosyasını açık tutmuyor, kimliği ortam değişkenine koymuyor). Aynı klasördeki N oturum
> N sekmeye dağıtılır; hangi sekmeye hangisinin düşeceği değişebilir ama **hiçbiri
> kaybolmaz**.

## Kullanım

Açılışta, geri gelmeyen komut varsa tek bir bildirim çıkar:

```
3 terminalde komut vardı. Geri yükleyeyim mi?     [Geri yükle]  [Seçenekler]
```

**Seçenekler** şunları açar:

| Seçenek | Ne yapar |
|---|---|
| Hepsini çalıştır | Kayıtlı komutların hepsi hemen çalışır |
| Tek tek seç | Listeden işaretlediklerin geri gelir |
| Yaz, ENTER'a ben basayım | Komutlar terminale yazılır, çalıştırılmaz |
| Vazgeç | Hiçbir şey yapılmaz |

Komut paletinden: `Terminal Hafızası: Kayıtları göster`, `… Şimdi kaydet`,
`… Komutları geri yükle`, `… Günlüğü göster`.

## Ayarlar

| Ayar | Varsayılan | Açıklama |
|---|---|---|
| `terminalHafiza.kayitAraligiSaniye` | `60` | Tarama sıklığı. Aynı zamanda eşik: bir komut kaydedilmek için iki taramayı da görmeli, yani ≥1 dk çalışmalı |
| `terminalHafiza.acilisGecikmesiMs` | `4000` | Açılışta sormadan önce beklenecek süre |
| `terminalHafiza.kapanistaSor` | `true` | Sekme kapanınca hemen "geri açayım mı?" diye sorulsun mu |
| `terminalHafiza.kapananSaklamaSaati` | `24` | Kapanmış sekmeler kaç saat hatırlansın |
| `terminalHafiza.haricTutulanlar` | `["^rm\\b", "^git push", "^sudo\\b"]` | Bu kalıplara uyan komutlar hiç kaydedilmez |
| `terminalHafiza.komutDonusumleri` | `{}` | Geri yüklerken değiştirilecek komutlar |

## Nasıl çalışıyor?

Komut, terminalin kabuk sürecinin **doğrudan çocuğundan** okunur (`zsh → claude`,
`zsh → npm run dev`). Kabuk entegrasyonu varsa komutun tam metni oradan alınır.

Anlık komutların (`ls`, `grep`, `head`) yanlışlıkla kaydedilmemesi için kara liste yerine
şu kural var: bir komut ancak **iki ardışık taramada da** görülürse kaydedilir.

Bu, aynı zamanda "neyi hatırlamaya değer" eşiğidir. Varsayılan aralık 60 saniye olduğundan
yalnızca **bir dakikadan uzun süren** işler kaydedilir — Claude oturumları, `npm run dev`,
izleyiciler. Bir dakikada biten işi hatırlamanın değeri yok.

Kayıt yalnızca tablo **değiştiğinde** diske yazılır; aynı tablo tekrar tekrar yazılmaz,
günlük de boşuna dolmaz.

## Kurulum

```bash
git clone https://github.com/turkbil/vscode-terminal-hafiza.git
cd vscode-terminal-hafiza
npx @vscode/vsce package
code --install-extension terminal-hafiza-*.vsix
```

Derleme gerektirmez — saf JavaScript, bağımlılık yok. macOS için yazıldı (`ps`, `lsof` ve
`~/.claude/projects` düzenine dayanır).

## Sekme kapanınca ne oluyor?

Bir terminal sekmesi kapandığında eklenti **anında** devreye girer — 60 saniyelik taramayı
beklemez (ölçüldü: kapanıştan 3 sn sonra kayıt alınmış olur).

İçinde uzun süreli bir iş çalışıyorduysa hemen sorar:

```
Kapanan sekmede Claude oturumu çalışıyordu.     [Geri aç]  [Boş ver]
```

**Geri aç** derseniz aynı klasörde yeni bir sekme açılır ve `claude --resume <kimlik>` ile
tam o konuşma geri gelir.

Sormasını istemezseniz `terminalHafiza.kapanistaSor` ayarını kapatın; kayıt yine tutulur.
Sonradan geri açmak için: `⌘⇧P` → **Terminal Hafızası: Kapanan sekmeyi geri aç** — son 24
saatte kapanmış sekmeleri listeler.

## Birden fazla VS Code penceresi

Kayıtlar **pencere başına** tutulur. Anahtar, o pencerede açık olan klasörden türetilir
(`terminalHafiza.kayitlar::<klasör>`).

Bu önemliydi: `globalState` bütün pencerelerde ortaktır — anahtar ayrılmasaydı beş pencere
aynı yere yazar, son yazan diğer pencerelerin terminallerini silerdi.

⌘Q ile çıktığınızda bütün pencereler kapanır ve bütün kabuklar ölür. Yeniden açılışta VS Code
pencereleri geri getirir; **her pencere kendi terminallerini ayrı ayrı sorar**.

## Lisans

MIT
