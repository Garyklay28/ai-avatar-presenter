# 03 · 사이트를 어떻게 읽을까 / 如何读取网站

Status: resolved · 방식 / 方式: research · prototype

## Question
아바타가 "사이트를 읽는다"는 것을 어떻게 구현? 사이트 내용이 바뀌어도 따라가야 한다.
怎么实现"头像读网站"？网站内容更新后也要跟上。

## 조사 / 调研
- 사이트는 Vite SPA, 내용은 Supabase 에서 불러옴 → HTML 을 내려받아서는 내용이 없음. 렌더된 DOM 을 읽어야 함.
  网站是 SPA，内容来自 Supabase，只下载 HTML 读不到内容，必须读渲染后的 DOM。
- 다른 출처 iframe 은 DOM 접근·스크롤 제어 불가 → 로컬 서버가 사이트를 **같은 출처로 프록시**.
  跨域 iframe 无法访问 DOM → 本地服务器把网站代理成同源。
- 영화·스틸 설명은 카드를 눌러야 뜨는 상세 창에만 있음 → 읽을 때 카드를 하나씩 열고 닫음.
  影片/剧照的说明只在详情弹窗里 → 读取时逐个打开再关闭。

## Answer
`reader.js` 가 4개 탭을 돌며 29개 구역(hero, profile×5, film×9, images×3, projects 헤더 + W2~W9 + 개인 스킬, contact)을 `{id, tab, selector, text}` 로 만든다. 과제 MD·자막처럼 화면에 다 안 보이는 자료는 `config.json` 의 `contextDocs` 로 함께 넘긴다.
读出 29 个区域；页面上看不全的作业 MD 和字幕通过 `config.json` 一起交给 Claude。

시제품 확인 / 原型验证: 로컬에서 29개 구역 추출, 영화 상세 설명·스틸 구도 설명까지 포함 확인.
