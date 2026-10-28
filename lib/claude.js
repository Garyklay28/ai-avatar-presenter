// Claude 호출: 발표 대본 생성 + 실시간 질의응답
// 调用 Claude：生成发表讲稿 + 实时问答
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5'
const USE_FALLBACKS = process.env.CLAUDE_FALLBACKS !== 'off'

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
- 영어·중국어 작품명은 한 번 원어로 말하고 한국어로 풀어 줍니다. 숫자는 읽기 쉽게 말합니다.
- 자료에 없는 사실(수상 내역, 날짜, 수치 등)을 지어내지 않습니다.`

// ---------- 발표 대본 / 发表讲稿 ----------
const ScriptSchema = z.object({
  title: z.string(),
  segments: z.array(
    z.object({
      stop: z.string(),
      say: z.string(),
    }),
  ),
})

export async function generateScript({ outline, docs, config }) {
  if (MOCK) {
    return {
      title: '[MOCK] 테스트 대본',
      segments: outline.map((s) => ({ stop: s.id, say: `[테스트] ${s.title} 구역입니다. ${s.text.split('\n')[0].slice(0, 80)}.` })),
    }
  }
  const ids = outline.map((s) => s.id)
  const minutes = config.talkMinutes
  const chars = Math.round(minutes * 330) // 한국어 TTS 약 330자/분 / 韩语 TTS 约每分钟 330 字

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

조건:
- 전체 분량: 약 ${minutes}분 (공백 포함 약 ${chars}자). 너무 짧으면 안 됩니다.
- segments 는 화면 순서대로 진행합니다. 각 segment 의 stop 은 아래 구역 id 중 하나여야 하고, 그 구역이 화면에 보이는 동안 say 를 읽습니다.
  사용 가능한 id: ${ids.join(', ')}
- 한 segment 의 say 는 2~5문장. 한 구역에 할 말이 많으면 같은 stop 으로 segment 를 여러 개 만들어도 됩니다.
- 흐름: 인사와 자기소개(아바타 자신 + ${config.persona.ownerKo}) → 프로필과 대표 영화 작업은 짧고 인상적으로 → 수업 과제 Week 2~9 를 주차별로 (각 과제마다 어떤 프롬프트를 어떻게 썼고 최종 산출물이 무엇인지, 참고 문서 내용을 근거로) → 마무리 인사와 함께 "궁금한 점은 마이크 버튼을 누르고 저에게 직접 물어보세요" 라고 질문을 유도.
- 과제 구역(Projects 탭)에 전체 분량의 60% 이상을 씁니다.
- title 은 발표 제목 한 줄.`

  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: zodOutputFormat(ScriptSchema) },
    system,
    messages: [{ role: 'user', content: user }],
  })
  if (response.stop_reason === 'refusal') throw new Error('Claude 가 대본 생성을 거절했습니다 / Claude 拒绝生成讲稿')
  if (response.stop_reason === 'max_tokens') throw new Error('대본이 너무 길어 잘렸습니다 / 讲稿过长被截断')
  const script = response.parsed_output
  // 없는 id 는 가장 가까운 앞 구역으로 / 不存在的 id 归到前一个区域
  let last = ids[0]
  for (const seg of script.segments) {
    if (ids.includes(seg.stop)) last = seg.stop
    else seg.stop = last
  }
  return script
}

// ---------- 실시간 질의응답 / 实时问答 ----------
export async function streamAnswer({ question, history = [], outline, current, docs, config, onText }) {
  if (MOCK) {
    const target = outline.find((s) => s.id === 'w05') ?? outline[0]
    const text = `[[goto:${target.id}]]좋은 질문이에요. "${question}"에 대한 테스트 답변입니다. 지금 화면을 ${target.title} 구역으로 옮겼어요. 실제 답변은 API 키를 넣으면 나와요.`
    for (const ch of text.match(/.{1,6}/gs)) { onText(ch); await new Promise((r) => setTimeout(r, 30)) }
    return
  }
  const ids = outline.map((s) => s.id)
  const system = [
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

  const messages = [
    ...history.slice(-8).map((h) => ({ role: h.role, content: h.content })),
    {
      role: 'user',
      content: `${current ? `(화면에 보이는 구역: ${current})\n` : ''}질문: ${question}`,
    },
  ]

  const params = {
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' }, // 현장 응답 속도 우선 / 现场优先响应速度
    system,
    messages,
  }

  const run = async (withFallbacks) => {
    const stream = withFallbacks
      ? getClient().beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : getClient().messages.stream(params)
    let sent = false
    stream.on('text', (t) => { sent = true; onText(t) })
    const final = await stream.finalMessage()
    if (final.stop_reason === 'refusal' && !sent) onText('죄송해요, 그 질문에는 답하기 어려워요. 다른 질문을 해 주시겠어요?')
  }

  try {
    await run(USE_FALLBACKS)
  } catch (err) {
    // fallbacks 를 지원하지 않는 계정·플랫폼이면 한 번만 일반 요청으로 다시 / 账户不支持 fallbacks 时改用普通请求重试一次
    if (USE_FALLBACKS && err instanceof Anthropic.BadRequestError) await run(false)
    else throw err
  }
}
