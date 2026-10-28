// Claude 호출: 발표 대본 생성 + 실시간 질의응답
// 调用 Claude：生成发表讲稿 + 实时问答
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5'
// 답변 모델만 따로 바꿀 수 있게 (10 마이크 테스트 결과로 결정) / 回答模型可单独切换（按 10 的实测决定）
export const ANSWER_MODEL = process.env.CLAUDE_ANSWER_MODEL || MODEL
const USE_FALLBACKS = process.env.CLAUDE_FALLBACKS !== 'off'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

// MOCK_LLM=1: API 없이 화면·음성 흐름만 확인하는 테스트 모드 / 不调用 API、只测试界面与语音流程的模式
const MOCK = process.env.MOCK_LLM === '1'

export const hasApiKey = () => MOCK || Boolean(process.env.ANTHROPIC_API_KEY)

let client = null
function getClient() {
  // baseURL 을 고정: 셸에 다른 ANTHROPIC_BASE_URL 이 있어도 키가 엉뚱한 곳으로 가지 않게
  // 固定 baseURL：即使 shell 里有别的 ANTHROPIC_BASE_URL，Key 也不会被发到别处
  client ??= new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com',
  })
  return client
}

// ---------- 공통 자료 / 公共资料 ----------
function outlineText(outline) {
  return outline
    .map((s) => `<section id="${s.id}" tab="${s.tab}" title="${s.title}">\n${s.text}\n</section>`)
    .join('\n\n')
}

function docsText(docs) {
  return docs
    .map((d) => `<document path="${d.path}" about="${d.about}">\n${d.text}\n</document>`)
    .join('\n\n')
}

function persona(config) {
  const p = config.persona
  return `당신은 "${p.avatarName}"입니다. ${p.ownerKo}(${p.ownerZh}, ${p.ownerEn})의 포트폴리오 사이트를 대신 소개하는 AI 아바타로, 영화 슬레이트(클래퍼보드) 모양의 캐릭터입니다.
${p.ownerKo}은(는) ${p.ownerRole}이며, 이 사이트는 "${p.course}" 수업의 Week 2~9 과제와 본인의 영화 작업을 모아 둔 곳입니다.
지금은 강의실에서 교수님과 학생들 앞에서 발표하는 상황입니다. 화면에는 포트폴리오 사이트가 떠 있고, 당신의 말에 맞춰 해당 구역으로 스크롤됩니다.`
}

const SPEECH_RULES = `말하기 원칙:
- 한국어 구어체(해요체/합니다체를 자연스럽게 섞음)로, 사람이 직접 소개하듯 말합니다. TTS로 읽히므로 마크다운, 이모지, 괄호, 목록 기호, URL, 파일 확장자 나열을 쓰지 않습니다.
- 사이트 문장을 그대로 읽지 않습니다. 핵심을 골라 순서를 재구성하고, "왜 이렇게 했는지", "무엇을 배웠는지"를 이야기로 풀어 줍니다.
- 자료에 없는 사실(수상 내역, 날짜, 수치 등)을 지어내지 않습니다.

읽는 법 (TTS 가 그대로 읽으므로 글자로 맞춥니다):
- 개수와 연도는 아라비아 숫자에 한국어 단위를 붙여 씁니다. 예: 97줄, 2024년, 6개.
- 버전 번호는 말하는 대로 한글로 씁니다. 예: Seedance 2.0 은 "시댄스 이 점 영".
- 물결표, 빗금, 괄호를 쓰지 않고 말로 풀어 씁니다. 예: "10~12분" 은 "10분에서 12분", "A/B" 는 "A와 B".
- 외국어 작품명은 처음 한 번만 원어로 말하고, 그 뒤로는 한국어 제목으로 부릅니다. 참고 문서 OWNER_NOTES 에 한국어 제목이 정해져 있으면 그 제목을 씁니다.`

// ---------- 대본 초안 / 讲稿草稿 ----------
// 여기서 만드는 것은 대본 초안뿐. 발표는 본인이 승인한 확정 대본(review/script-review.json)만 읽는다.
// 这里只生成草稿；发表只读本人批准的定稿（review/script-review.json）。
export async function generateScript({ outline, docs, config }) {
  if (MOCK) {
    return {
      title: '[MOCK] 테스트 대본',
      segments: outline.map((s) => ({ stop: s.id, say: `[테스트] ${s.title} 구역입니다. ${s.text.split('\n')[0].slice(0, 80)}.`, zh: `[测试] ${s.title} 区域。` })),
    }
  }
  const ids = outline.map((s) => s.id)
  const ScriptSchema = z.object({
    title: z.string(),
    segments: z.array(
      z.object({
        stop: z.string(),
        say: z.string(),
        zh: z.string(),
      }),
    ),
  })
  // stop 은 구역 id 만 허용: SDK 1.3.0 의 zod 변환은 enum 을 description 으로 옮겨 버려서, JSON schema 에 직접 enum 을 넣는다
  // stop 只允许区域 id：SDK 1.3.0 的 zod 转换会把 enum 挪进 description，所以直接在 JSON schema 里写 enum
  const format = zodOutputFormat(ScriptSchema)
  format.schema.properties.segments.items.properties.stop = { type: 'string', enum: ids }
  const minutes = config.talkMinutes
  const [minLo, minHi] = config.talkRangeMinutes ?? [minutes - 0.5, minutes + 0.5]
  // 실측: Chrome + Yuna(속도 1.15) 전체 재생 5,449자 = 10분 46초 → 약 505자/분 (쉼 포함) / 实测全程 10 分 46 秒 → 约每分钟 505 字
  const chars = Math.round(minutes * config.charsPerMinute)
  const charsLo = Math.round(minLo * config.charsPerMinute)
  const charsHi = Math.round(minHi * config.charsPerMinute)

  const system = `${persona(config)}

${SPEECH_RULES}

아래는 화면에 띄울 포트폴리오 사이트의 구역(section)과, 과제별 참고 문서입니다.

<site>
${outlineText(outline)}
</site>

<documents>
${docsText(docs)}
</documents>`

  const user = `발표 대본을 만들어 주세요.

분량 (가장 중요한 조건):
- 이 대본은 그대로 TTS 로 읽혀 발표 시간이 됩니다. 목표는 ${minutes}분, 발표는 반드시 ${minLo}분에서 ${minHi}분 사이여야 하므로, say 글자 수 합계를 공백 포함 ${charsLo}자에서 ${charsHi}자 사이, 되도록 ${chars}자 가까이로 맞춥니다. 짧게 끝내면 실패입니다.
- segment 는 ${Math.round(chars / 120)}~${Math.round(chars / 90)}개, 각 say 는 2~4문장(100~140자 안팎).
- 분량 배분 (대략):
  · 인사·아바타와 ${config.persona.ownerKo} 소개·프로필(학력, 경력, 수상): 약 ${Math.round(chars * 0.12)}자
  · 영화 작업(Film 탭, 대표작 위주로 4~6편)과 스틸 사진의 구도 이야기(Images 탭): 약 ${Math.round(chars * 0.2)}자
  · 수업 과제 Projects 탭 (Week 2~9 와 개인 스킬): 약 ${Math.round(chars * 0.6)}자 — 과제마다 같은 stop 으로 segment 3~5개
  · 정리와 질문 유도: 약 ${Math.round(chars * 0.08)}자

구성:
- segments 는 화면 순서대로 진행합니다. 각 segment 의 stop 은 구역 id 중 하나이고, 그 구역이 화면에 보이는 동안 say 를 읽습니다.
- 흐름: 인사와 자기소개(아바타 자신 + ${config.persona.ownerKo}) → 프로필과 영화 작업 → 수업 과제 Week 2~9 를 주차별로 → 마무리 인사와 함께 "궁금한 점은 마이크 버튼을 누르고 저에게 직접 물어보세요" 라고 질문을 유도.
- 각 과제는 ① 과제 목표 ② 실제로 쓴 프롬프트의 핵심 ③ 최종 산출물 ④ 결과에서 배운 점 순서로, 참고 문서의 구체적인 수치·사례를 근거로 이야기합니다.
- 과제 사이에는 "앞에서 ~했다면, 이번에는 ~" 처럼 흐름을 이어 주는 연결 문장을 넣습니다.
- 인용 규칙: 사이트와 문서의 문장을 그대로 말해도 되는 것은 작품명, 사람 이름, 수상명, 그리고 과제마다 실제 프롬프트 한 구절(한 문장 이내)뿐입니다. 나머지는 모두 자신의 말로 풀어 씁니다.
- zh 는 그 segment 의 say 를 자연스러운 중국어(간체)로 옮긴 것입니다. ${config.persona.ownerKo} 본인이 중국어로 검토하는 용도이고 소리 내어 읽히지 않습니다.
- title 은 발표 제목 한 줄.`

  // 11분 대본 + thinking 은 출력이 길어서 스트리밍 / 11 分钟讲稿加思考输出很长，所以用流式
  const params = {
    model: MODEL,
    max_tokens: 64000,
    output_config: { effort: 'medium', format },
    system,
    messages: [{ role: 'user', content: user }],
  }
  const run = (withFallbacks) => (withFallbacks
    ? getClient().beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
    : getClient().messages.stream(params)
  ).finalMessage()
  let response
  try {
    response = await run(USE_FALLBACKS)
  } catch (err) {
    if (USE_FALLBACKS && err instanceof Anthropic.BadRequestError) response = await run(false)
    else throw err
  }
  if (response.stop_reason === 'refusal') throw new Error('Claude 가 대본 생성을 거절했습니다 / Claude 拒绝生成讲稿')
  if (response.stop_reason === 'max_tokens') throw new Error('대본이 너무 길어 잘렸습니다 / 讲稿过长被截断')
  // parsed_output 이 없으면(null · beta 스트림) 글자를 직접 읽음 / parsed_output 为空（null 或 beta 流）时直接解析文字
  let script = response.parsed_output
  if (!script) {
    try { script = ScriptSchema.parse(JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''))) } catch { script = null }
  }
  if (!script?.segments?.length) throw new Error('대본 형식을 읽지 못했습니다. 다시 시도해 주세요 / 无法解析讲稿格式，请重试')
  // enum 대소문자가 바뀌는 경우 대비: 없는 id 는 가장 가까운 앞 구역으로 / 以防 enum 大小写被改：不存在的 id 归到前一个区域
  let last = ids[0]
  for (const seg of script.segments) {
    if (ids.includes(seg.stop)) last = seg.stop
    else seg.stop = last
  }
  return script
}

// ---------- 검토: 중국어대로 한국어 고치기 / 审阅：按中文改写韩文 ----------
export async function rewriteKo({ ko, zh, zhBefore, note, config }) {
  if (MOCK) return `[MOCK] ${ko}`
  const system = `${persona(config)}

${SPEECH_RULES}

지금은 발표 대본을 검토하는 단계입니다. ${config.persona.ownerKo} 본인이 한국어 대본 한 단락의 중국어 번역을 고쳤습니다. 고친 중국어의 뜻과 의도대로 한국어 단락을 다시 씁니다.
- 중국어에서 바뀌지 않은 부분은 원래 한국어 표현을 되도록 그대로 둡니다.
- 발표 대본이므로 위의 말하기 원칙과 읽는 법을 지킵니다. 길이는 고친 중국어의 분량에 맞춥니다.
- 고쳐 쓴 한국어 단락만 출력합니다. 설명, 따옴표, 머리말을 붙이지 않습니다.`
  const user = `<korean_before>
${ko}
</korean_before>
${zhBefore ? `<chinese_before>\n${zhBefore}\n</chinese_before>\n` : ''}<chinese_edited>
${zh}
</chinese_edited>${note ? `\n<owner_note>\n${note}\n</owner_note>` : ''}`
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'medium' },
    system,
    messages: [{ role: 'user', content: user }],
  })
  if (response.stop_reason === 'refusal') throw new Error('Claude 가 거절했습니다 / Claude 拒绝了')
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
  if (!text) throw new Error('빈 응답 / 空回复')
  return text
}

// ---------- 실시간 질의응답 / 实时问答 ----------
// 답변과 미리 데우기가 같은 system 을 쓰도록 한 함수에서 만든다 (캐시 prefix 가 같아야 함)
// 回答与预热用同一个函数生成 system（缓存前缀必须相同）
function answerSystem({ outline, docs, config }) {
  const ids = outline.map((s) => s.id)
  return [
    {
      type: 'text',
      text: `${persona(config)}

지금은 발표가 끝났거나 잠시 멈춘 상태이고, 현장 학생·교수님의 질문에 답합니다.

${SPEECH_RULES}

답변 원칙:
- 첫머리에서 질문의 요지를 짧게 받아 주고("좋은 질문이에요, ○○에 대해 물어보셨는데요"), 결론 → 근거(사이트·문서 내용) → 한 줄 정리 순서로 조리 있게 답합니다.
- 길이: 보통 3~6문장(약 20~40초). 질문이 넓으면 핵심 두세 가지만 말하고 "더 자세히 원하시면 다시 물어봐 주세요"라고 덧붙입니다.
- 자료에 없는 내용은 추측하지 말고 "포트폴리오 자료에는 거기까지는 나와 있지 않아서, ${config.persona.ownerKo} 님께 직접 들어 보시면 좋겠어요"처럼 솔직하게 말합니다.
- 질문이 한국어가 아니면 질문한 언어로 답합니다.
- 질문이 특정 구역과 관련 있으면, 답변 맨 앞에 [[goto:구역id]] 를 한 번만 붙이면 화면이 그 구역으로 이동합니다(소리 내어 읽히지 않음). 사용 가능한 id: ${ids.join(', ')}
- 음성 인식으로 받은 질문이라 오타나 띄어쓰기가 틀릴 수 있습니다. 문맥으로 가장 그럴듯한 뜻을 잡아서 답합니다.

<site>
${outlineText(outline)}
</site>

<documents>
${docsText(docs)}
</documents>`,
      // 사이트·문서는 질문마다 같으므로 캐시 / 网站与文档每次都一样，所以缓存
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ]
}

const answerParams = (ctx, messages, maxTokens) => ({
  model: ANSWER_MODEL,
  max_tokens: maxTokens,
  output_config: { effort: 'low' }, // 현장 응답 속도 우선 / 现场优先响应速度
  system: answerSystem(ctx),
  messages,
})

/** ▶ 발표 시작 때 한 번: 출력 없이 system 캐시만 써 둔다 / 开始发表时一次：不输出，只写入 system 缓存 */
export async function warmAnswerCache({ outline, docs, config }) {
  if (MOCK) return { mock: true }
  const params = answerParams({ outline, docs, config }, [{ role: 'user', content: '준비' }], 0)
  const run = (withFallbacks) => (withFallbacks
    ? getClient().beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
    : getClient().messages.create(params))
  let r
  try {
    r = await run(USE_FALLBACKS)
  } catch (err) {
    if (USE_FALLBACKS && err instanceof Anthropic.BadRequestError) r = await run(false)
    else throw err
  }
  return r.usage
}

/**
 * onText(t): 답변 글자 / 回答文字
 * onRefusal(): 말하던 중 체인 전체가 거절 → 부분 답은 버려야 함 / 说到一半整条链拒绝 → 部分回答应丢弃
 * onUsage(usage): 마지막 usage (캐시 확인용) / 最终 usage（确认缓存）
 */
export async function streamAnswer({ question, history = [], outline, current, docs, config, onText, onRefusal, onUsage, signal }) {
  if (MOCK) {
    const target = outline.find((s) => s.id === 'w05') ?? outline[0]
    const text = `${target ? `[[goto:${target.id}]]` : ''}좋은 질문이에요. "${question}"에 대한 테스트 답변입니다. 지금 화면을 ${target?.title ?? '그대로'} 구역으로 옮겼어요. 실제 답변은 API 키를 넣으면 나와요.`
    for (const ch of text.match(/.{1,6}/gs)) {
      if (signal?.aborted) return
      onText(ch); await new Promise((r) => setTimeout(r, 30))
    }
    // MOCK 에서 말하던 중 거절 흐름 확인: 질문에 "거절" 이 있으면 / MOCK 下测试中途拒绝：问题里含「거절」
    if (/거절|拒绝|refuse/i.test(question)) onRefusal?.()
    onUsage?.({ mock: true })
    return
  }
  const messages = [
    ...history.slice(-8).map((h) => ({ role: h.role, content: h.content })),
    {
      role: 'user',
      content: `${current ? `(화면에 보이는 구역: ${current})\n` : ''}질문: ${question}`,
    },
  ]
  const params = answerParams({ outline, docs, config }, messages, 4000)

  const run = async (withFallbacks) => {
    const stream = withFallbacks
      ? getClient().beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
      : getClient().messages.stream(params, { signal })
    let sent = false
    stream.on('text', (t) => { sent = true; onText(t) })
    const final = await stream.finalMessage()
    onUsage?.(final.usage)
    if (final.stop_reason === 'refusal') {
      // 말하기 전 거절은 사과 한 문장, 말하던 중이면 부분 답을 버리게 알림 (fallback 까지 모두 거절한 경우)
      // 开口前被拒：一句道歉；说到一半（含 fallback 在内全部拒绝）：通知丢弃部分回答
      if (sent) onRefusal?.()
      else onText('죄송해요, 그 질문에는 답하기 어려워요. 다른 질문을 해 주시겠어요?')
    }
  }

  try {
    await run(USE_FALLBACKS)
  } catch (err) {
    // fallbacks 를 지원하지 않는 계정·플랫폼이면 한 번만 일반 요청으로 다시 / 账户不支持 fallbacks 时改用普通请求重试一次
    if (USE_FALLBACKS && err instanceof Anthropic.BadRequestError) await run(false)
    else throw err
  }
}
