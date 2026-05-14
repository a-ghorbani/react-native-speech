/**
 * Demo text per language for the Supertonic v3 picker.
 *
 * Each language carries the same 4-sentence demo paragraph as the
 * English default — a welcome line, a description of what the demo is,
 * the "all-local, no cloud" tagline, and a prompt to switch voices.
 * Switching the language picker swaps the speak text to its parallel
 * translation, so you hear roughly the same content in every language.
 *
 * Translations are author-quality drafts, not professionally reviewed.
 * Confidence is high for the major European / East Asian languages and
 * lower for Finno-Ugric, Baltic, and South Slavic — see review notes
 * in the PR for which ones to spot-check with a native speaker. For
 * a small example app this is the right tradeoff; for shipping copy,
 * replace these with reviewed strings.
 */

export const ENGLISH_DEFAULT_TEXT =
  'Welcome! This is a quick demo of on-device neural text-to-speech. ' +
  'Everything you hear is synthesized locally — no internet, no cloud ' +
  'API, just the model running on your phone. Switch voices above to ' +
  'hear the difference.';

export const SAMPLE_TEXT: Record<string, string> = {
  en: ENGLISH_DEFAULT_TEXT,
  ko: '환영합니다! 이것은 온디바이스 신경망 음성 합성의 간단한 데모입니다. 들리는 모든 소리는 로컬에서 생성됩니다 — 인터넷도, 클라우드 API도 없이, 휴대전화에서 실행되는 모델뿐입니다. 위에서 음성을 바꿔 차이를 들어보세요.',
  ja: 'ようこそ!これはオンデバイスのニューラル音声合成のクイックデモです。聞こえるすべての音声はローカルで合成されています — インターネットもクラウドAPIも不要、お使いの端末で動作するモデルだけです。上から音声を切り替えて違いを聞いてみてください。',
  ar: 'مرحباً! هذا عرض سريع لتحويل النص إلى كلام بواسطة شبكة عصبية تعمل على الجهاز. كل ما تسمعه يُولَّد محلياً — بدون إنترنت، وبدون واجهة سحابية، فقط النموذج يعمل على هاتفك. بدِّل الأصوات في الأعلى لتسمع الفرق.',
  bg: 'Добре дошли! Това е кратка демонстрация на невронен синтез на реч директно на устройството. Всичко, което чувате, се генерира локално — без интернет, без облачен API, само модел, който работи на вашия телефон. Сменете гласовете отгоре, за да чуете разликата.',
  cs: 'Vítejte! Toto je krátká ukázka neurálního převodu textu na řeč přímo v zařízení. Vše, co slyšíte, se generuje lokálně — žádný internet, žádné cloudové API, jen model běžící ve vašem telefonu. Přepněte hlasy nahoře a poslechněte si rozdíl.',
  da: 'Velkommen! Dette er en hurtig demo af neural tekst-til-tale på selve enheden. Alt, du hører, syntetiseres lokalt — ingen internetforbindelse, ingen sky-API, kun modellen, der kører på din telefon. Skift stemmer ovenfor for at høre forskellen.',
  de: 'Willkommen! Dies ist eine kurze Demo neuronaler Sprachsynthese direkt auf dem Gerät. Alles, was Sie hören, wird lokal erzeugt — kein Internet, keine Cloud-API, nur das Modell, das auf Ihrem Telefon läuft. Wechseln Sie oben die Stimme, um den Unterschied zu hören.',
  el: 'Καλώς ήρθατε! Αυτή είναι μια γρήγορη επίδειξη νευρωνικής μετατροπής κειμένου σε ομιλία στη συσκευή. Όλα όσα ακούτε δημιουργούνται τοπικά — χωρίς διαδίκτυο, χωρίς cloud API, μόνο το μοντέλο που τρέχει στο τηλέφωνό σας. Αλλάξτε φωνές παραπάνω για να ακούσετε τη διαφορά.',
  es: '¡Bienvenido! Esta es una demostración rápida de texto a voz neuronal en el dispositivo. Todo lo que escuchas se sintetiza localmente — sin internet, sin API en la nube, solo el modelo ejecutándose en tu teléfono. Cambia las voces arriba para oír la diferencia.',
  et: 'Tere tulemast! See on lühike demo seadmesisesest närvivõrgu kõnesünteesist. Kõik, mida kuulete, sünteesitakse kohapeal — ilma internetiühenduseta, ilma pilve-API-ta, ainult mudel teie telefonis. Vahetage hääli üleval, et kuulda erinevust.',
  fi: 'Tervetuloa! Tämä on lyhyt esittely laitteessa toimivasta neuroverkkopohjaisesta tekstistä puheeksi -muunnoksesta. Kaikki, mitä kuulet, syntetisoidaan paikallisesti — ei internetiä, ei pilvirajapintaa, vain malli, joka pyörii puhelimessasi. Vaihda ääniä yllä kuullaksesi eron.',
  fr: "Bienvenue ! Voici une démo rapide de synthèse vocale neuronale directement sur l'appareil. Tout ce que vous entendez est généré localement — pas d'internet, pas d'API cloud, juste le modèle qui tourne sur votre téléphone. Changez de voix ci-dessus pour entendre la différence.",
  hi: 'स्वागत है! यह डिवाइस पर न्यूरल टेक्स्ट-टू-स्पीच का एक त्वरित डेमो है। आप जो भी सुनते हैं वह स्थानीय रूप से बनाया जाता है — कोई इंटरनेट नहीं, कोई क्लाउड एपीआई नहीं, बस आपके फोन पर चलने वाला मॉडल। अंतर सुनने के लिए ऊपर से आवाज़ बदलें।',
  hr: 'Dobrodošli! Ovo je kratak demo neuralnog pretvaranja teksta u govor na uređaju. Sve što čujete sintetizira se lokalno — bez interneta, bez cloud API-ja, samo model koji radi na vašem telefonu. Promijenite glasove iznad da čujete razliku.',
  hu: 'Üdvözöljük! Ez egy rövid bemutató az eszközön futó neurális szövegfelolvasásról. Mindent, amit hall, helyben szintetizálunk — internet nélkül, felhőszolgáltatás nélkül, csak a telefonján futó modell. Váltson hangot fent, hogy hallja a különbséget.',
  id: 'Selamat datang! Ini adalah demo singkat text-to-speech neural di perangkat. Semua yang Anda dengar disintesis secara lokal — tanpa internet, tanpa API cloud, hanya model yang berjalan di ponsel Anda. Ganti suara di atas untuk mendengar perbedaannya.',
  it: 'Benvenuto! Questa è una breve demo di sintesi vocale neurale direttamente sul dispositivo. Tutto ciò che senti viene generato localmente — niente internet, niente API cloud, solo il modello in esecuzione sul tuo telefono. Cambia la voce sopra per sentire la differenza.',
  lt: 'Sveiki! Tai trumpa neuroninės teksto į kalbą sintezės įrenginyje demonstracija. Visa, ką girdite, sintezuojama vietoje — be interneto, be debesijos API, tik modelis, veikiantis jūsų telefone. Pakeiskite balsus viršuje, kad išgirstumėte skirtumą.',
  lv: 'Sveicināti! Šī ir īsa neironu tīkla teksta-runas demonstrācija ierīcē. Viss, ko dzirdat, tiek sintezēts lokāli — bez interneta, bez mākoņa API, tikai modelis, kas darbojas jūsu tālrunī. Mainiet balsis augšā, lai dzirdētu atšķirību.',
  nl: 'Welkom! Dit is een korte demo van neurale tekst-naar-spraak op het apparaat zelf. Alles wat je hoort, wordt lokaal gegenereerd — geen internet, geen cloud-API, alleen het model dat op je telefoon draait. Wissel hierboven van stem om het verschil te horen.',
  pl: 'Witamy! To krótka demonstracja neuronowej syntezy mowy działającej na urządzeniu. Wszystko, co słyszysz, jest generowane lokalnie — bez internetu, bez chmury, tylko model uruchomiony w Twoim telefonie. Zmień głos powyżej, aby usłyszeć różnicę.',
  pt: 'Bem-vindo! Esta é uma demonstração rápida de síntese de voz neural no dispositivo. Tudo o que você ouve é gerado localmente — sem internet, sem API na nuvem, apenas o modelo rodando no seu telefone. Troque as vozes acima para ouvir a diferença.',
  ro: 'Bun venit! Aceasta este o scurtă demonstrație de sinteză vocală neurală direct pe dispozitiv. Tot ce auziți este sintetizat local — fără internet, fără API în cloud, doar modelul care rulează pe telefonul dumneavoastră. Schimbați vocile de mai sus pentru a auzi diferența.',
  ru: 'Добро пожаловать! Это краткая демонстрация нейронного синтеза речи прямо на устройстве. Всё, что вы слышите, генерируется локально — без интернета, без облачного API, только модель, работающая на вашем телефоне. Переключайте голоса выше, чтобы услышать разницу.',
  sk: 'Vitajte! Toto je krátka ukážka neurálneho prevodu textu na reč priamo v zariadení. Všetko, čo počujete, sa generuje lokálne — bez internetu, bez cloudového API, len model bežiaci vo vašom telefóne. Prepnite hlasy hore a vypočujte si rozdiel.',
  sl: 'Dobrodošli! To je kratek prikaz nevronske sinteze govora na napravi. Vse, kar slišite, se sintetizira lokalno — brez interneta, brez API-ja v oblaku, le model, ki teče na vašem telefonu. Zamenjajte glasove zgoraj, da slišite razliko.',
  sv: 'Välkommen! Det här är en snabb demo av neural text-till-tal på själva enheten. Allt du hör syntetiseras lokalt — ingen internetanslutning, inget moln-API, bara modellen som körs på din telefon. Byt röst ovan för att höra skillnaden.',
  tr: "Hoş geldiniz! Bu, cihaz üzerinde çalışan sinir ağı tabanlı bir metin okuma demosudur. Duyduğunuz her şey yerel olarak üretilir — internet yok, bulut API'si yok, sadece telefonunuzda çalışan model. Sesleri yukarıdan değiştirerek farkı dinleyin.",
  uk: 'Ласкаво просимо! Це коротка демонстрація нейронного синтезу мовлення безпосередньо на пристрої. Усе, що ви чуєте, генерується локально — без інтернету, без хмарного API, лише модель, яка працює на вашому телефоні. Змініть голоси вгорі, щоб почути різницю.',
  vi: 'Chào mừng! Đây là bản demo nhanh về chuyển văn bản thành giọng nói bằng mạng nơ-ron ngay trên thiết bị. Mọi âm thanh bạn nghe đều được tổng hợp cục bộ — không cần internet, không cần API đám mây, chỉ mô hình chạy trên điện thoại của bạn. Đổi giọng nói ở trên để nghe sự khác biệt.',
};

/**
 * Set of every sample-text string for fast "is this an unedited demo?"
 * checks — used to decide whether changing the language picker should
 * auto-swap the speak text or leave the user's edits alone.
 */
export const SAMPLE_TEXT_SET: ReadonlySet<string> = new Set(
  Object.values(SAMPLE_TEXT),
);
