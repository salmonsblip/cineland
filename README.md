# Salmon's Lab — сайт

Одна страница, без сборки и без платных сервисов. Английский по умолчанию, русский — кнопкой RU или ссылкой с `#ru` на конце.

## 1. Добавьте картинки

Пока файла нет, на его месте виден серый плейсхолдер с путём. Положите файлы с точно такими именами (JPG, длинная сторона ~1600 px, до 400 КБ; видео MP4 H.264 без звука, до 3–4 МБ, 6–10 сек):

**img/posters/** — оригинальные постеры
leclisse, lanotte, lavventura, desertorosso, offret, coffeeandcigarettes, pierrotlefou, permanentvacation, cuckoo, audition, anymart, machinist, masterandmargarita (всё `.jpg`)

**img/loc/** — локализации
paterson, donniedarko, thefall, memento, chao, theconversation, thestraightstory, theelephantman, ran, sirat

**img/cases/** — coffee-banner.jpg (16:9), maywin-2.jpg, maywin-3.jpg (два других постера Maywin)

**video/** — reel-1…reel-4.mp4 (9:16), coffee-reel.mp4

**img/** — portrait.jpg (4:5), og.jpg (1200×630, превью ссылки в мессенджерах)

Порядок и подписи постеров меняются в `index.html`, в массивах `ORIG` и `LOC` внизу файла.

## 2. Выложите бесплатно (GitHub Pages)

1. Войдите на github.com под `salmonsblip`.
2. New repository → имя `salmonsblip.github.io` → Public → Create.
3. «uploading an existing file» → перетащите всё содержимое этой папки (кроме body.html и README.md) → Commit.
4. Settings → Pages → Source: Deploy from branch, `main`, `/ (root)` → Save. Через 1–2 минуты сайт открыт.

Домен salmonslab.com: файл `CNAME` уже лежит в папке. В Pages → Custom domain впишите `salmonslab.com` → Save, после проверки DNS включите Enforce HTTPS.

DNS в Рег.ру (раздел «DNS-серверы и управление зоной», серверы Рег.ру не менять):

| Тип | Имя | Значение |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | salmonsblip.github.io |

Старые A-записи на @ и записи для www (парковка Рег.ру) удалить.

Альтернатива без Git: Cloudflare Pages или Netlify Drop — перетащить папку в браузер.

## 3. Перед рассылкой

- Проверить сайт с телефона по ссылке из письма.
- Попросить у ИНОЕКИНО и Maywin одну-две фразы рекомендации — добавлю блок.
- Заменить «Salmon» на настоящее имя, если будете выступать под ним.
