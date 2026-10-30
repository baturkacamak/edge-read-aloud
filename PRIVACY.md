# Gizlilik Politikası — Sesli Oku

**Son güncelleme:** 30 Ekim 2026

Sesli Oku, Microsoft Edge için bir metin okuma (text-to-speech) eklentisidir.
Bu politika, eklentinin hangi verileri işlediğini açıklar.

## Özet

- Geliştirici **hiçbir kişisel veri toplamaz**, saklamaz veya satmaz.
- Eklenti kendi sunucusuna veri göndermez; analitik, reklam veya telemetri yoktur.
- Okunan metin, ses üretimi için **Microsoft'un Read Aloud servisine** gönderilir.
- Ayarlar yalnızca tarayıcınızın yerel depolama alanında tutulur.

## İşlenen veriler

### 1. Okunan metin

Sayfayı veya seçimi okuttuğunuzda, ilgili metin parçaları seslendirilmek üzere
`speech.platform.bing.com` adresindeki Microsoft Read Aloud servisine gönderilir.
Bu servis Microsoft Corporation tarafından işletilir ve Microsoft'un kendi
gizlilik koşullarına tabidir:

- https://privacy.microsoft.com/

Metin, geliştirici tarafından görüntülenmez, kaydedilmez veya üçüncü taraflarla
paylaşılmaz. Eklenti yalnızca o an okunacak parçayı gönderir; tam sayfa arşivi
tutulmaz.

### 2. Ayarlar

Seçtiğiniz ses, okuma hızı, ses düzeyi ve oynatma hızı `chrome.storage.local`
içinde saklanır. Bu veriler cihazınızdan çıkmaz ve tarayıcı profilini silmeniz
veya eklentiyi kaldırmanız durumunda silinir.

### 3. Ses listesi önbelleği

Microsoft'un ses listesi, gereksiz istekleri önlemek için 7 gün boyunca yerel
olarak önbelleğe alınır. Bu önbellek de cihazınızdan çıkmaz.

## İzinler ve gerekçeleri

| İzin | Neden |
| --- | --- |
| `storage` | Ses, hız ve ses düzeyi ayarlarını saklamak için |
| `contextMenus` | Sağ tık menüsüne "Sayfayı/Seçimi sesli oku" eklemek için |
| `activeTab`, `scripting` | Yalnızca kullanıcı eyleminden sonra etkin sekmedeki metne erişmek ve oynatıcıyı eklemek için |
| `https://speech.platform.bing.com/*`, `wss://speech.platform.bing.com/*` | Ses üretimi ve ses listesi için Microsoft servisine bağlanmak için |

Eklenti, izin verilmeyen sayfalarda (ör. `edge://`, mağaza sayfaları) çalışmaz.

## Çerezler ve izleme

Eklenti kendi çerezlerini oluşturmaz, üçüncü taraf izleme araçları kullanmaz ve
kullanıcı davranışını kaydetmez.

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
