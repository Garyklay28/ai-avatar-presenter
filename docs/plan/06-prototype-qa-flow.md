# 06 · 질의응답 흐름 / 问答流程

Status: resolved · 방식 / 方式: prototype

## Question
현장에서 질문을 어떻게 받고, 얼마나 빨리 답할 수 있나?
现场怎么收问题、多快能回答？

## Answer
1. 🎤 / `Space` → Chrome `webkitSpeechRecognition` (ko-KR, interim 결과를 말풍선에 실시간 표시)
2. `continuous` 모드 + 1.8초 침묵 타이머 → 질문 중간에 잠깐 쉬어도 끊기지 않음
3. `/__api/ask` SSE 스트리밍 → 마침표·물음표로 문장이 완성되는 대로 바로 TTS (전체 답변을 기다리지 않음)
4. 발표 중 질문하면 발표 일시정지 → 답변 후 "▶ 이어서"
5. 시끄러운 강의실 대비: ⌨ 글 질문
6. Chrome TTS 가 긴 문장을 끊는 문제 → 140자 이하 문장 단위로 나눠 읽음

시제품 확인 / 原型验证: `npm run mock` (API 없이) 으로 질문 → [[goto:w05]] 처리 → W5 구역 이동·강조 → 문장 단위 낭독까지 확인.
