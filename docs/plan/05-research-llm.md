# 05 · LLM 사용 방식 / LLM 使用方式

Status: resolved · 방식 / 方式: research

## Question
어떤 LLM 을 어떻게 써야 "각색 소개"와 "조리 있는 답변"이 되나? 비용·속도는?
用哪个 LLM、怎么用，才能做到"改编介绍"和"有条理的回答"？成本与速度？

## Answer
- **Claude API** (`claude-opus-5-5`, 공식 SDK `@anthropic-ai/sdk`).
- **대본 / 讲稿**: Structured Outputs(`output_config.format` + zod) 로 `{title, segments:[{stop, say}]}` 를 받음. `stop` 은 03 의 구역 id 중 하나만 허용 → 화면 연동이 깨지지 않음. 분량 11분: Chrome+Yuna 속도 1.15 에서 실측 약 505자/분, 48개 segment. 전체 재생 실측 10분 46초. Projects 에 60% 이상. 길어서 thinking 과 함께 한도를 넘지 않도록 스트리밍(max_tokens 64000)으로 생성. 결과는 `cache/` 에 저장해 같은 사이트 내용이면 재사용(비용 0, 오프라인 대비).
- **답변 / 回答**: 스트리밍(`messages.stream`) + effort `low` 로 첫 문장이 빨리 나오게. 사이트·문서가 담긴 system 프롬프트는 `cache_control` 1시간 캐시 → 두 번째 질문부터 입력 비용 약 1/10.
- 답변 맨 앞 `[[goto:구역id]]` 로 관련 구역으로 화면 이동(읽지 않음).
- 서버 측 refusal fallback(`fallbacks: "default"`)을 켜 두고, 계정이 지원하지 않으면 일반 요청으로 재시도.
- 키는 서버(`.env`)에만 있고 브라우저로 내려가지 않음.
  Key 只在服务器 `.env`，不会发到浏览器。
