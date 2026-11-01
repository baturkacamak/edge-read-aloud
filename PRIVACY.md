# Gizlilik Politikası — Sesli Oku

**Son güncelleme:** 1 Kasım 2026

Sesli Oku, Microsoft Edge için bir metin okuma (text-to-speech) eklentisidir.
Bu politika, eklentinin hangi verileri işlediğini açıklar.

## Özet

- Geliştirici **hiçbir kişisel veri toplamaz**, saklamaz veya satmaz.
- Eklenti kendi sunucusuna veri göndermez; analitik, reklam veya telemetri yoktur.
- Okunan metin, ses üretimi için **Microsoft'un Read Aloud servisine** gönderilir.
- Ayarlar başlangıçta yereldir. İsteğe bağlı eşitlemeyi açarsanız web konumları, yer imleri/notlar ve tercihler tarayıcı hesabınızın eşitleme hizmetine gönderilir.

## İşlenen veriler

### 1. Okunan metin

Sayfayı veya seçimi okuttuğunuzda, ilgili metin parçaları seslendirilmek üzere
`speech.platform.bing.com` adresindeki Microsoft Read Aloud servisine gönderilir.
Bu servis Microsoft Corporation tarafından işletilir ve Microsoft'un kendi
gizlilik koşullarına tabidir:

- https://privacy.microsoft.com/

Metin, geliştirici tarafından görüntülenmez, kaydedilmez veya üçüncü taraflarla
paylaşılmaz. Eklenti okumada sıradaki parçayı önceden hazırlayabilir. MP3 indirmede seçilen
okuma metninin tüm parçaları seslendirilir; tam sayfanın HTML arşivi tutulmaz.

### 2. Ayarlar

Seçtiğiniz ses, okuma hızı, ses düzeyi ve oynatma hızı `chrome.storage.local`
içinde saklanır. Eşitleme kapalıyken bu veriler cihazınızdan çıkmaz. Tarayıcı profilini silmeniz
veya eklentiyi kaldırmanız durumunda silinir.

### 3. Yerel okuma kitaplığı

Konumu hatırlama açıkken son 100 sayfanın adresi, başlığı, paragrafın kısa bir
alıntısı, hedef kelimenin çevresindeki metin ve okuma konumu `chrome.storage.local` içinde saklanır. Yer imleri
(en fazla 300), okuma listesi (50 adres), sayfa başına hariç tutulan alanlar ve
kullanıcının telaffuz sözlüğü de yereldir. Bu kayıtlar geliştiriciye gönderilmez. İsteğe bağlı hesap eşitlemesi aşağıda açıklanır. Konumu hatırlama Davranış sekmesinden kapatılabilir;
yer imleri, liste öğeleri ve hariç tutma kuralları Kitaplıktan silinebilir.
Tarayıcı profilini silmek veya eklentiyi kaldırmak bu yerel kayıtları temizler.

MP3 indirmede ses bellekte birleştirilir ve tarayıcının normal indirme
mekanizmasıyla kaydedilir. İndirilen dosya, eklenti kaldırıldığında silinmez.
Okuma listesi yalnızca kullanıcı başlattığında sıradaki adreslere gider.

### 4. Belge ve çevrimdışı ses kitaplığı

Seçtiğiniz PDF/EPUB dosyasının metni cihazınızda ayrıştırılır. Görsel ve taranmış PDF OCR işlemi paketlenmiş Tesseract motoru ve Türkçe/İngilizce modellerle cihazda yapılır; OCR için internet gerekmez. Belge metni,
başlığı ve bölümleri; çevrimdışı hazırlamada ses ve kelime zamanları uzantının
IndexedDB alanında saklanır. Bu kitaplığın sınırı toplam 250 MB'dir. Kitaplıktaki
Sil düğmesiyle kayıt kaldırılır. PDF parolası kalıcı olarak saklanmaz.
Dosyalar ayrıştırılmak veya OCR uygulanmak için bir sunucuya yüklenmez.
Sesli okuma veya çevrimdışı ses hazırlama seçildiğinde ilgili metin ses üretimi
için Microsoft servisine gönderilir. Hazır sesin çevrimdışı oynatımı sentez
servisini kullanmaz. Özgün belge HTML'i veya betikleri okuyucuda çalıştırılmaz.

Siteye özel tercihler, yer imi/liste notları ve etiketler de yerel depolamada
tutulur. JSON yedeğini yalnızca kullanıcı indirir; yedek dosyasında adresler,
notlar, konumlar ve tercihler bulunabilir. Belge ve ses dosyaları yedeğe dahil
edilmez. İndirilen JSON ve MP3 dosyaları eklenti kaldırılınca silinmez.

### 5. Ses listesi önbelleği

Microsoft'un ses listesi, gereksiz istekleri önlemek için 7 gün boyunca yerel
olarak önbelleğe alınır. Bu önbellek de cihazınızdan çıkmaz.

### 6. İsteğe bağlı cihazlar arası eşitleme

Kitaplıktaki eşitleme anahtarı başlangıçta kapalıdır. Açarsanız HTTP/HTTPS sayfa
adresleri, başlıkları, kısa metin alıntıları ve konumları; yer imleri, notlar,
etiketler, genel ayarlar, profiller ve telaffuz sözlüğü `chrome.storage.sync`
üzerinden tarayıcı hesabınızın eşitleme hizmetine aktarılır. Bu aktarımı tarayıcı
sağlayıcınız işletir; kendi hesap ve gizlilik koşulları geçerlidir. Geliştirici
bu verilere erişmez. Belge/ses dosyaları, yerel belge bağlantıları, site kuralları,
hariç tutmalar, okuma kuyruğu ve istatistikler aktarılmaz.

Eşitlemeyi kapatmak yeni aktarımları durdurur; mevcut hesap kopyasını otomatik
silmez. Hesaptaki kopyayı sil ve kapat düğmesi bu uzantının eşitleme verisini
siler, yerel veriyi korur. Başka cihazlar yeniden yüklemesin diye önce oralarda
da eşitlemeyi kapatın. Uzantıyı kaldırmak hesaptaki kopyayı temizlemek yerine
geçmez. Kota/aktarım hataları panelde gösterilir, yerel kayıtlar korunur.

### 7. Dinleme istatistikleri ve medya paneli

Çalma sırasında geçen yaklaşık süre ve gün bazında tamamlanan sayfa adreslerinin SHA-256 özetleri
son 365 gün için yalnızca `chrome.storage.local` içinde tutulur. Haftalık hedef
ve bu istatistikler hesap eşitlemesine/JSON yedeğine dahil değildir. Kitaplıktaki
İstatistikleri sil düğmesi geçmişi temizler. Ses çalarken mevcut sayfa başlığı,
oynatma durumu ve ilerlemesi tarayıcı/işletim sisteminin yerel medya kontrollerine
sunulur; bu işlem geliştiriciye bir ağ isteği oluşturmaz.

## İzinler ve gerekçeleri

| İzin | Neden |
| --- | --- |
| `storage` | Ayarları, okuma konumlarını ve kullanıcı kitaplığını yerel saklamak ve kullanıcı açarsa hesapla eşitlemek için |
| `alarms` | Okuma listesindeki sayfaların yükleme zaman aşımını ve eşitleme gönderimlerini izlemek için |
| `contextMenus` | Sağ tık menüsüne "Sayfayı/Seçimi sesli oku" eklemek için |
| `activeTab`, `scripting` | Yalnızca kullanıcı eyleminden sonra etkin sekmedeki metne erişmek ve oynatıcıyı eklemek için |
| `https://speech.platform.bing.com/*`, `wss://speech.platform.bing.com/*` | Ses üretimi ve ses listesi için Microsoft servisine bağlanmak için |

Eklenti, izin verilmeyen sayfalarda (ör. `edge://`, mağaza sayfaları) çalışmaz.

## Çerezler ve izleme

Eklenti kendi çerezlerini oluşturmaz, üçüncü taraf izleme araçları kullanmaz ve
uzaktan kullanıcı davranışı izlemez. Okuma konumları yukarıda açıklandığı gibi
tarayıcı profilinde saklanır; isteğe bağlı eşitleme açıkken yukarıdaki kapsamda tarayıcı hesabına aktarılır.

## Çocukların gizliliği

Eklenti kişisel veri toplamadığı için çocuklara ait veriler de toplanmaz.

## Değişiklikler

Bu politika güncellenirse, dosyanın üstündeki "Son güncelleme" tarihi değişir.
Önemli değişiklikler mağaza listesinde veya proje deposunda duyurulur.

## İletişim

Sorular ve geri bildirimler için: https://github.com/baturkacamak

## Microsoft ile ilişki

Bu eklenti Microsoft Corporation ile bağlantılı, onun tarafından desteklenen
veya onaylanan bir ürün değildir. "Microsoft", "Edge" ve "Read Aloud",
Microsoft Corporation'ın ticari markalarıdır.
