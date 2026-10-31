# Açılır liste hareketleri: kaynaklar ve uygulama sınırları

Bu inceleme standart combo-box listesinin açılışı içindir. Başlat/bağlam
menülerinin fade ayarı, pencere açılışı ve düğme hover animasyonu aynı kontrol
olarak değerlendirilmez. Koyu/açık renk modu hareket politikasını değiştirmez.

| Tema | Kaynağın desteklediği davranış | Bu uzantıdaki karşılığı |
| --- | --- | --- |
| Windows 95 | Aşağıdaki WEL API destek ayrımında combo animasyonu 98/2000 ve sonrasına aittir. 95'e bu sonraki efekt taşınmıyor. | Anında; animasyon yok. Bu, destek matrisine dayanan temkinli uyarlamadır. |
| Windows 98 | Microsoft KB Q272420, Windows 98 ComboBox kontrolünde Animation/Transition açıkken oluşan hatayı belgeler. WEL API destek grubu ve Win32 API efektin slide-open niteliğini tamamlar. | Efektler açık senaryosu: kayarak ortaya çıkma. |
| Windows XP | Microsoft Press'in *Windows XP Registry Guide*, Ek B, `UserPreferencesMask` tablosunda bit 2 varsayılan açık; combo box'ların slide-open davranışı belirtilir. | Kayarak ortaya çıkma. |
| Windows 7 | Microsoft Press'in *Optimizing Windows 7 Pocket Consultant*, bölüm 1, basılı sayfa 3: “Slide Open Combo Boxes” seçeneği; kapalıyken listeler anında açılır. | Efektler açık senaryosu: kayarak ortaya çıkma. |
| Modern | Tarihsel Windows taklidi değildir. | Kısa fade ve 3 px konum geçişi. |

## Doğrudan kaynaklar

- EiffelSoftware'ın Windows API sabitleri, `SystemParameter (Windows 98, Windows
  2000 and above)` grubundaki combo animasyonu sabitleri:
  https://github.com/EiffelSoftware/EiffelStudio/blob/master/Src/library/wel/consts/wel_spi_constants.e
  Bu, WEL kütüphanesinin doğrudan kaynak kodudur; Windows 95'te çalışan bir VM
  üzerinde yapılmış gözlem değildir.
- Microsoft, `SystemParametersInfo`, `SPI_GETCOMBOBOXANIMATION` ve
  `SPI_SETCOMBOBOXANIMATION`:
  https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-systemparametersinfoa
- Jerry Honeycutt, *Microsoft Windows XP Registry Guide*, Microsoft Press,
  Ek B “Control Panel”, Table B-1. Yayın metninin çevrimiçi kopyası:
  https://flylib.com/books/en/1.272.1.136/1/
- William R. Stanek, *Optimizing Windows 7 Pocket Consultant*, Microsoft Press,
  ISBN 978-0-7356-6165-3, bölüm 1, basılı sayfa 3 / PDF sayfa 15:
  https://ptgmedia.pearsoncmg.com/images/9780735661653/samplepages/9780735661653.pdf

- Microsoft Knowledge Base Q272420, “BUG: ComboBox Text Is Missing When
  DoEvents Is in GotFocus Event”, Microsoft tarafından yayımlanmış yazının
  arşiv kopyası:
  https://www.infania.net/misc/kbarchive/kb/272/Q272420/index.html
  Yazının Windows 95/98 için ortak tekrar adımları da içerdiği unutulmamalı:
  burada seçilen 95 politikası yalın klasik profildir, tüm güncelleme/ek kabuk
  kombinasyonlarına dair bir iddia değildir.

## Ölçülmemiş ayrıntılar

Bu çalışma belgeler ve API destek bilgisine dayanır; dört özgün Windows
kurulumunda video/zamanlama ölçümü yapılmadı. Kaynaklar her sürüm için kesin
milisaniye, easing veya ekran kartına bağlı kare zamanlaması vermiyor.
Bu nedenle 98/XP/7 için seçilen **200 ms ve doğrusal** açılış, bu uygulamanın
uyarlama değeridir. Modern'in **120 ms** geçişi de uygulama tasarımıdır.
Bu sayılar özgün Windows zamanlaması olarak sunulmamalıdır.

XP ve 7'nin aynı belgelenmiş efekt ailesini kullanması bilinçlidir. Yalnızca
farklı görünsünler diye 7'ye fade veya XP'ye büyütme/bounce eklenmedi. Her tema
CSS'te ayrı bir kurala sahiptir; tanımsız tema köklerine genel animasyon atanmaz.
Yukarı açılan liste yukarı, aşağı açılan liste aşağı doğru ortaya çıkar;
metin ölçeklenmez. `prefers-reduced-motion` tüm animasyonları kapatır.
Bu web uzantısı Windows'un yerel SPI ayarını okumaz; 98/XP/7 için efekt açık
senaryosunu temsil eder. Liste kapatma ve seçim işlemleri bekletilmez.
