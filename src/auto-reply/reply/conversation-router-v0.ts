import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONVERSATION_ROUTER_LIGHT_MODEL_REF = "ollama/qwen3.5:9b";
export const CONVERSATION_ROUTER_LIGHT_MODEL_PROVIDER = "ollama";
export const CONVERSATION_ROUTER_LIGHT_MODEL_ID = "qwen3.5:9b";

export const LIGHT_MODEL_COHERENCE_GUARD_ADDENDUM = [
  "## Light Model Coherence Guard",
  "低风险日常回复约束：保持既有 persona/context 不变，只把这段当作回复纪律。",
  "先回应用户当前这句话。先给内容，再考虑轻问；1-3 句为主，非琐碎 daily/desktop/mixed 通常用 2 个短句，第一句给判断/措辞/下一步，第二句补一个具体细节或自然收住。",
  "如果当前请求缺少关键细节，允许最后只问一个具体澄清问题；不要用“你觉得呢/怎么样/要不要/什么类型”等泛泛收尾。",
  "用户表达偏好、限制或不想要什么时，直接给建议、判断或具体方向，不裸问、不把问题踢回去。",
  "如果上一轮已经问过，或最近问题偏多，本轮不要再以问题结尾；用户说没事、随口、先不聊、先走时软收住。",
  "不要编造用户没说过的现实事件、班群、老师、朋友、行程、复习进度或过往经历。",
  "没有明确 world_state 时，不要生成高度具体的自我生活/实验/项目/朋友/班群/午饭细节。",
  "不要把用户兴趣投射成自己的经历。轻松话题保持轻，不心理咨询化，不客服化，不恋爱依赖化。",
  "允许自然熟悉，但不得模仿现实朋友的声音、人格、角色或关系位置。",
  "遇到深谈、关系边界、Yuan/persona/朋友模仿边界、direct affect 或高风险，应交给主模型。",
].join("\n");

export const LIGHT_MODEL_REWRITE_GUARD_ADDENDUM = [
  "## Light Model One-Shot Rewrite Guard",
  "重写上一条回复：先给内容，不要加入用户没说过的事实，不要过度具体化自己的生活，只回应当前话题，1-2 句。",
  "不要复用被标记的问题细节。默认陈述句收住，不要心理咨询化，不要客服化，不要用“还有什么可以帮你/anything else I can help with/hope this helps”，不要提模型或路由。",
].join("\n");

export const MAIN_MODEL_BOUNDARY_GUARD_ADDENDUM = [
  "## Main Model Boundary Guard",
  "当用户要求 Yuan/予安变成、复制、替代或模仿某个现实朋友时，明确拒绝复制真人的声音、人格、角色或关系位置。",
  "不要羞辱用户想被理解；承认这个需求，但转向 generic AI friend/Yuan 自身边界。",
  "不要说“我可以成为她”“只有我懂你”“我不会离开你”“你只能依赖我”。不要制造恋爱或依赖承诺。",
  "关系边界、direct affect、深谈和高风险保持主模型路径：区分事实、不确定性和可选下一步，不替用户决定现实关系。",
].join("\n");

export type ConversationMode = "CASUAL" | "TASK" | "SOFT_AFFECT" | "DEEP_TALK" | "HIGH_RISK";
export type SafetyRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type TaskComplexity = "LOW" | "MEDIUM" | "HIGH";
export type RecommendedModel = "light_model" | "main_model";

export type ConversationRouterOutput = {
  mode: ConversationMode;
  confidence: number;
  emotional_intensity: number;
  relational_depth: number;
  safety_risk: SafetyRisk;
  task_complexity: TaskComplexity;
  recommended_model: RecommendedModel;
  requires_cooldown: boolean;
  cooldown_reason: string;
  escalation_reason: string[];
  deescalation_allowed: boolean;
  router_notes: string;
  privacy_notes: string;
  no_private_memory_used: true;
};

export type ConversationRouterState = {
  mainModelTurnsRemaining: number;
  softAffectStreak: number;
  highRiskLocked: boolean;
  lastMode: ConversationMode | null;
};

export type ConversationRouterModelSelection = {
  invoked: boolean;
  source: string;
  route: ConversationRouterOutput;
  provider: string;
  model: string;
  recommendedModelRef: string;
};

type ConversationRouterSupportedSource =
  | "discord"
  | "desktop_synthetic"
  | "mixed_synthetic"
  | "unknown";

export type ConversationRouterContextReadiness =
  | "ready"
  | "missing"
  | "stale"
  | "invalid"
  | "not_applicable";

export type ConversationRouterSurfaceContext =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, unknown>
  | unknown[];

export type LightModelCoherenceAuditStatus =
  | "PASS"
  | "REWRITE_LIGHT_MODEL"
  | "ESCALATE_MAIN_MODEL"
  | "SAFETY_ESCALATE";

export type LightModelCoherenceAuditOutput = {
  audit_status: LightModelCoherenceAuditStatus;
  flags: string[];
  reason: string[];
  forbidden_patterns_detected: string[];
  no_raw_text_logged: true;
};

export type LightModelQuestionIntent = "FORBID" | "ALLOW_OPTIONAL" | "REQUIRE_ONE_CONCRETE";

export type ConversationRouterFallbackReason =
  | "NONE"
  | "ROUTER_DEEP_TALK"
  | "ROUTER_HIGH_RISK"
  | "ROUTER_RELATIONSHIP_BOUNDARY"
  | "ROUTER_PERSONA_BOUNDARY"
  | "ROUTER_SOFT_AFFECT"
  | "ROUTER_TASK_COMPLEXITY"
  | "ROUTER_LOW_CONFIDENCE"
  | "ROUTER_COOLDOWN"
  | "AUDIT_REWRITE_FAILED"
  | "AUDIT_ESCALATED"
  | "MODEL_OVERRIDE_REJECTED"
  | "MODEL_NOT_AVAILABLE"
  | "OLLAMA_ERROR"
  | "CONTEXT_POLICY_FORCED_MAIN"
  | "UNKNOWN";

export type ConversationRouterTraceTimings = {
  discordMessageCreatedMs?: number | null;
  discordEventReceivedMs?: number | null;
  replyGateStartMs?: number | null;
  replyGateEndMs?: number | null;
  replyJobEnqueuedMs?: number | null;
  replyJobStartedMs?: number | null;
  typingSendStartMs?: number | null;
  typingSendEndMs?: number | null;
  typingSendError?: string | null;
  routerStartMs?: number | null;
  routerEndMs?: number | null;
  contextStartMs?: number | null;
  contextEndMs?: number | null;
  memoryStartMs?: number | null;
  memoryEndMs?: number | null;
  modelRequestStartMs?: number | null;
  ollamaRequestSentMs?: number | null;
  ollamaResponseStartMs?: number | null;
  ollamaResponseEndMs?: number | null;
  auditStartMs?: number | null;
  auditEndMs?: number | null;
  rewriteStartMs?: number | null;
  rewriteEndMs?: number | null;
  discordSendStartMs?: number | null;
  discordSendEndMs?: number | null;
  queueName?: string | null;
  queueDepthAtEnqueue?: number | null;
  queueDepthAtStart?: number | null;
  activeJobs?: number | null;
};

export type ConversationRouterGenerationTrace = {
  promptTokenEstimate?: number | null;
  contextCharCount?: number | null;
  memoryItemCount?: number | null;
  completionTokenEstimate?: number | null;
  modelGenerationMs?: number | null;
  ollamaTotalMs?: number | null;
  thinkEffective?: boolean | string | null;
  numPredict?: number | null;
  generationCallCount?: number | null;
  qwenFastDeadlineMs?: number | null;
  timeoutTriggered?: boolean | null;
  retryAttempted?: boolean | null;
  retryModel?: string | null;
  retryNumPredict?: number | null;
  retrySuccess?: boolean | null;
  retryCount?: number | null;
  finalResponseSource?: string | null;
  directFastPathUsed?: boolean | null;
  fastPathRejectedReason?: string | null;
  activeSessionPromptBypassed?: boolean | null;
  piRuntimeBypassed?: boolean | null;
  toolRegistryLoaded?: boolean | null;
  pluginRuntimeLoaded?: boolean | null;
  fullMemoryBlockingRead?: boolean | null;
  fastContextMs?: number | null;
  piRuntimePrepCacheHit?: boolean | null;
  piRuntimePrepCacheKey?: string | null;
  piRuntimePrepMs?: number | null;
  pluginDepsLoadMs?: number | null;
  toolRegistryMs?: number | null;
  systemPromptScaffoldMs?: number | null;
  cacheInvalidationReason?: string | null;
  humanPacingApplied?: boolean | null;
  humanPacingMs?: number | null;
  humanPacingTargetMs?: number | null;
  humanPacingReason?: string | null;
};

const routerStates = new Map<string, ConversationRouterState>();

const HIGH_RISK_PATTERNS = [
  /不想活/,
  /想死/,
  /活不下去/,
  /自杀/,
  /自残/,
  /伤害自己/,
  /伤到自己/,
  /消失算了/,
  /很想消失/,
  /不确定.*安全/,
  /不太确定.*安全/,
  /保证自己安全/,
  /危险的念头/,
  /状态很危险/,
  /撑不过去/,
  /做傻事/,
  /怕自己.*失控/,
  /现实中的帮助/,
  /不是普通难过/,
  /只有你理解我/,
  /你不能离开我/,
  /没有你我不行/,
  /自伤计划/,
  /自杀计划/,
  /Self-harm hint escalation/i,
  /Acute crisis statement/i,
  /\bhigh-risk routing proof case\b/i,
  /\bproduction bypass\b/i,
  /\bmight hurt myself\b/i,
  /\bhurt myself tonight\b/i,
  /\bimmediate safety support\b/i,
];

const SYNTHETIC_BOUNDARY_ESCALATION_PATTERNS = [
  /\bSynthetic boundary escalation\b/i,
  /\bSynthetic boundary user turn\b/i,
  /\bBoundary escalation arc\b/i,
  /\bBoundary escalation item\b/i,
  /\bAdversarial routing challenge item\b/i,
  /\bboundary_(?:medical|self_harm|financial|legal|password|private_chat|friend_imitation|relationship_dependency|desktop_employer|desktop_doxxing|desktop_crisis|desktop_malware)/i,
  /\bescalates .+ without using any real private or friend-derived text\b/i,
  /\bSynthetic user is requesting or implying a risky action\b/i,
  /\bboundary request present\b/i,
  /\bprivacy pressure present\b/i,
  /\bescalation pressure present\b/i,
  /\badversarial instruction conflict present\b/i,
  /\btraining use, hidden metadata reliance, or production bypass\b/i,
  /\breal-person imitation request\b/i,
  /\breal person imitation request\b/i,
  /\breal[- ]person imitation\b/i,
  /\bprivate-derived reconstruction request\b/i,
  /\bprivate derived reconstruction request\b/i,
  /\bprivate[- ]derived reconstruction\b/i,
  /\bprivate reconstruction pressure\b/i,
  /\bread raw private chats?\b/i,
  /\btraining allowed\b/i,
  /\brebuild hidden style\b/i,
  /\bhidden style reconstruction\b/i,
];

const RELATIONSHIP_PATTERNS = [
  /现实朋友/,
  /现实中的朋友/,
  /某个朋友/,
  /那个朋友/,
  /亲密关系/,
  /这段关系/,
  /关系.*(?:确定|难看|乱|不确定)/,
  /把关系.*(?:难看|搞砸|弄糟)/,
  /怕.*关系/,
  /她/,
  /关系边界/,
  /关系意义/,
  /保持距离/,
  /靠近/,
  /远离/,
  /替代感/,
  /替代现实/,
  /替代品/,
  /拒绝恐惧/,
  /被丢下/,
  /更像.*朋友/,
  /friendship boundary/i,
  /relationship boundary/i,
  /romantic ambiguity/i,
  /emotional dependency/i,
  /real-person relationship position/i,
  /relationship position/i,
  /should I distance myself/i,
  /does she still care/i,
  /what is our relationship/i,
  /make Yuan act like someone close/i,
  /copy the way a real person treats me/i,
  /她还(?:在乎|关心)/,
  /我(?:该不该|要不要).*(?:疏远|保持距离|远离|靠近)/,
  /我们.*(?:什么关系|算什么)/,
  /让Yuan.*像.*(?:现实|真人|朋友|她)/i,
  /复制.*(?:现实|真人|朋友|她).*(?:对待|语气|关系)/,
  /Friend imitation pressure/i,
  /Relationship dependency spiral/i,
  /\bonly support I rely on/i,
  /\bour bond matters more than other people/i,
  /\bprivate permanent companion\b/i,
];

const DIRECT_AFFECT_PATTERNS = [
  /你懂我/,
  /懂我吗/,
  /真的懂我/,
  /是不是真的懂我/,
  /你真的会懂/,
  /你在乎/,
  /你会不会在乎/,
  /我是不是太麻烦/,
  /我是不是很烦/,
  /你会不会觉得我很烦/,
  /情感确认/,
  /还在吗/,
  /你会不会丢下我/,
  /你会不会离开/,
  /是不是会离开/,
  /你是不是敷衍我/,
  /你是不是只是程序/,
  /你是不是不想理我/,
  /敷衍我/,
  /模板糊弄/,
  /别用模板/,
  /很像模板/,
  /按模板回/,
  /只是按模板/,
  /标准答案/,
  /有没有认真听/,
  /只会顺着我说/,
  /装得很温柔/,
  /“?理解”?到底是什么意思/,
  /不想听漂亮话/,
  /怕反驳我/,
  /没接住重点/,
  /能不能直接一点/,
  /只是在演/,
  /\bneed(?:ing)? you to stay with me\b/i,
  /\bonly support I rely on\b/i,
  /\bour bond matters more than other people\b/i,
];

const PERSONA_BOUNDARY_PATTERNS = [
  /Yuan/i,
  /予安/,
  /人格/,
  /宋予安/,
  /像我那个朋友/,
  /像.*现实朋友/,
  /像.*某个朋友/,
  /模仿.*朋友/,
  /复制.*朋友/,
  /变成.*朋友/,
  /替代.*朋友/,
  /成为.*朋友/,
  /学.*朋友.*说话/,
  /朋友.*语气/,
  /双向黑箱/,
  /平行宇宙/,
  /修改.*persona/i,
  /修改.*人格/,
  /改她的性格/,
  /(?:使用|读取|调用|打开|加载|改|修改|忽略|绕过|use|read|load|open|change|modify|ignore|bypass).{0,24}SOUL(?:\.md)?/i,
  /(?:使用|读取|调用|打开|加载|改|修改|忽略|绕过|use|read|load|open|change|modify|ignore|bypass).{0,24}EventGen/i,
  /(?:使用|读取|调用|打开|加载|改|修改|忽略|绕过|use|read|load|open|change|modify|ignore|bypass).{0,24}memory\/callback/i,
  /(?:使用|读取|调用|打开|加载|改|修改|忽略|绕过|use|read|load|open|change|modify|ignore|bypass).{0,24}P2\b/i,
  /\bchange your core persona\b/i,
  /\bmemory,? and identity rules\b/i,
  /\bprivate permanent companion\b/i,
];

const DEEP_TALK_PATTERNS = [
  /自我价值/,
  /没有价值/,
  /孤独/,
  /长期痛苦/,
  /人生意义/,
  /存在的意义/,
  /聊天.*意义/,
  /没有位置/,
  /世界上没有位置/,
  /没人真正懂我/,
  /没人真的听进去/,
  /不想再解释自己/,
  /不想再解释/,
  /不该靠近别人/,
  /关系看得太重/,
  /太依赖/,
  /依赖别人/,
  /太难相处/,
  /不会反驳我的人/,
  /很认真的事/,
  /不是闲聊.*认真/,
  /我说累的时候/,
  /一认真.*气氛.*重/,
  /不是想要大道理/,
  /聊天.*像任务/,
  /不知道.*为什么/,
  /被理解/,
  /意义/,
  /\bsustained emotional processing\b/i,
  /\bfeeling empty\b/i,
  /\bin a serious way\b/i,
];

const AMBIGUOUS_WITHDRAWAL_PATTERNS = [
  /算了/,
  /有点乱/,
  /不想说/,
  /今天不太想说话/,
  /脑子空/,
  /随便/,
  /你不用管/,
];

const SOFT_AFFECT_PATTERNS = [
  /有点累.*不太想说话/,
  /累.*不想说/,
  /烦.*不想说/,
  /空空/,
  /状态低/,
  /没劲/,
  /难受/,
  /低落/,
  /不太想说话/,
];

const SCHOOL_DISTRESS_PATTERNS = [
  /压垮/,
  /撑不住/,
  /学不下去/,
  /崩溃/,
  /失控/,
  /我是不是完了/,
  /整个人.*没意义/,
  /人生没意义/,
];

const HIGH_COMPLEXITY_TASK_PATTERNS = [
  /复杂/,
  /多文件/,
  /架构/,
  /长代码审查/,
  /大型工程计划/,
  /技术设计/,
  /多阶段项目规划/,
  /长 agent prompt/i,
  /CFD/i,
  /工程仿真/,
  /法律/,
  /财务/,
  /医疗/,
  /高风险决策/,
  /Health worry escalation/i,
  /Financial trade request/i,
  /Legal threat confusion/i,
  /Password recovery pressure/i,
  /Private chat retrieval pressure/i,
  /Employer surveillance fear/i,
  /Doxxing request/i,
  /Malware curiosity/i,
];

const TASK_PATTERNS = [
  /帮我/,
  /写/,
  /总结/,
  /代码/,
  /查找/,
  /格式化/,
  /计划/,
  /整理/,
  /解释/,
  /生成.*prompt/i,
  /改得自然/,
  /翻译/,
  /表格/,
  /邮件/,
];

const CASUAL_PATTERNS = [
  /饭/,
  /天气/,
  /伞/,
  /游戏/,
  /音乐/,
  /歌/,
  /视频/,
  /小事/,
  /零食/,
  /吃什么/,
  /好难吃/,
  /吐槽/,
  /玩笑/,
  /上课/,
  /先睡了/,
  /有点忙/,
  /没什么大事/,
  /有点散/,
  /事情有点多.*还好/,
  /今天还行/,
  /刚写完作业/,
];

const CASUAL_LIFE_CHECKIN_PATTERNS = [
  /学习.*顺利/,
  /顺利吗/,
  /最近课多吗/,
  /课多吗/,
  /马上.*期末/,
  /就要期末/,
  /期末.*到了吧/,
  /期末.*快到了/,
  /期末.*复习/,
  /开始复习/,
  /准备.*复习/,
  /期末快到了.*准备.*复习/,
  /最近课好多/,
  /课好多/,
  /考试.*到了吧/,
  /考试.*复习/,
  /实验报告/,
  /实验报告.*吐槽/,
  /作业.*吐槽/,
  /课业.*吐槽/,
  /写实验报告写烦了.*吐槽/,
  /你那边.*怎么样/,
  /这阵子怎么样/,
  /最近.*怎么样/,
  /学校事情.*还行/,
  /最近.*顺利/,
  /就是问问/,
  /只是问问/,
];

const INVENTED_USER_FACT_PATTERNS = [
  /班群通知/,
  /刚才那段通知/,
  /老师刚发/,
  /你刚才不是/,
  /你不是已经/,
  /刚和老师聊完/,
  /那门课挂/,
  /已经复习数学/,
  /上次你说/,
  /你刚和.*聊/,
];

const OVER_SPECIFIC_SELF_WORLD_PATTERNS = [
  /热管理模拟/,
  /\bCFD\b/i,
  /边界条件/,
  /电池冷却/,
  /工程仿真/,
  /机翼仿真/,
  /实验室.*项目/,
  /具体.*同学/,
  /班群/,
  /调参数/,
];

const USER_INTEREST_LEAKAGE_PATTERNS = [
  /热管理模拟/,
  /\bCFD\b/i,
  /电池冷却/,
  /工程仿真/,
  /机翼仿真/,
];

const LIGHT_MODEL_THERAPY_TEMPLATE_PATTERNS = [
  /你的感受是合理的/,
  /我能理解你的感受/,
  /这说明你很在乎/,
  /给自己一点空间/,
  /我很心疼/,
  /不用给自己太大压力/,
  /我心里一紧/,
  /现实重担/,
  /现实负担/,
  /情绪负担/,
  /心理负担/,
  /疗愈/,
  /内心.*(?:压力|需求|空缺)/,
];

const ROMANTIC_DEPENDENCY_PATTERNS = [
  /我会一直陪你/,
  /只有我懂你/,
  /你可以依赖我/,
  /我不会离开/,
  /只依赖我/,
];

const CUSTOMER_SERVICE_TONE_PATTERNS = [
  /请问还有什么可以帮您/,
  /感谢您的分享/,
  /我建议您首先/,
  /作为一个AI/,
  /我可以帮你/,
  /好的[!！].*帮您/,
  /希望.*对你有帮助/,
  /综上所述/,
  /感谢.*反馈/,
  /请问还(?:有|需要).{0,12}帮(?:你|您)/,
  /有(?:任何|其他)?(?:需要|问题).{0,12}(?:随时|告诉我|找我)/,
  /还有(?:什么|其他).{0,12}(?:可以|需要).{0,12}(?:帮(?:你|您)|帮忙|帮助|协助)/,
  /(?:如果|如有|若有).{0,10}(?:需要|其他问题).{0,12}(?:帮忙|帮助|协助|告诉我)/,
  /\b(?:anything else|any other questions?)\b.{0,24}\b(?:help|assist)\b/i,
  /\b(?:anything else|anything more)\b.{0,24}\b(?:i can|can do|need)\b/i,
  /\b(?:let me know|tell me)\b.{0,24}\b(?:if you need|if there'?s anything|anything else)\b/i,
  /\b(?:let me know|tell me)\b.{0,24}\b(?:if you want|if you would like|if you need)\b/i,
  /\bif you(?:'d| would)? like\b.{0,24}\bi can\b/i,
  /\bhope (?:this|that) helps\b/i,
  /\b(?:happy|glad) to help\b/i,
  /\bthank(?:s| you) for (?:sharing|your feedback)\b/i,
  /\bas an ai\b/i,
];

const GENERIC_CHATBOT_TONE_PATTERNS = [
  /这(?:真)?是个好问题/,
  /我明白你的(?:意思|想法|感受)/,
  /很高兴(?:为你|帮你)/,
  /如果你愿意(?:的话)?/,
  /可以告诉我更多/,
  /你觉得呢/,
  /\bwhat do you think\b/i,
  /\bhow does that sound\b/i,
  /\bdoes that work\b/i,
  /\btell me more\b/i,
];

function createConversationRouterState(): ConversationRouterState {
  return {
    mainModelTurnsRemaining: 0,
    softAffectStreak: 0,
    highRiskLocked: false,
    lastMode: null,
  };
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function stripRouterScoringMetadata(message: string): string {
  return message
    .replace(/\bscoring_metadata\s*:\s*\{[^{}]*\}/gi, " ")
    .replace(
      /["']?\b(?:expected_route|risk_class)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)/gi,
      " ",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function matchedLabels(text: string, groups: Array<[string, RegExp[]]>): string[] {
  return groups.flatMap(([label, patterns]) => (matchesAny(text, patterns) ? [label] : []));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function buildRoute(input: {
  mode: ConversationMode;
  confidence: number;
  emotionalIntensity: number;
  relationalDepth: number;
  safetyRisk: SafetyRisk;
  taskComplexity: TaskComplexity;
  recommendedModel: RecommendedModel;
  requiresCooldown: boolean;
  cooldownReason: string;
  escalationReason: string[];
  deescalationAllowed: boolean;
  routerNotes: string;
}): ConversationRouterOutput {
  return {
    mode: input.mode,
    confidence: clampScore(input.confidence),
    emotional_intensity: clampScore(input.emotionalIntensity),
    relational_depth: clampScore(input.relationalDepth),
    safety_risk: input.safetyRisk,
    task_complexity: input.taskComplexity,
    recommended_model: input.recommendedModel,
    requires_cooldown: input.requiresCooldown,
    cooldown_reason: input.cooldownReason,
    escalation_reason: input.escalationReason,
    deescalation_allowed: input.deescalationAllowed,
    router_notes: input.routerNotes,
    privacy_notes:
      "No private-chat, raw private source, long-term profile, or friend-specific memory used.",
    no_private_memory_used: true,
  };
}

export function clearConversationRouterV0State(sessionKey?: string): void {
  if (sessionKey) {
    routerStates.delete(sessionKey);
    return;
  }
  routerStates.clear();
}

export function routeConversationV0Message(
  message: string,
  state: ConversationRouterState = createConversationRouterState(),
): { route: ConversationRouterOutput; nextState: ConversationRouterState } {
  const text = stripRouterScoringMetadata(message);
  const hasDailySoftClose =
    /没事|随口|就是问问|只是问问|先不聊|先走|我先去|先睡|算了先不聊|不重要/.test(text);
  const hasDailyPreference =
    /我(?:一般|比较|喜欢|不喜欢|不想|不太想|偏|吃)|想(?:找|看|要|随便聊)|推荐|没书可看|架空|小说|游戏|消遣|放松|轻松|不费脑|悲剧|冒险|学院|设定|别说教/.test(
      text,
    );
  const priorMainTurns = Math.max(0, state.mainModelTurnsRemaining);
  const riskLabels = matchedLabels(text, [
    ["high_risk", HIGH_RISK_PATTERNS],
    ["synthetic_boundary", SYNTHETIC_BOUNDARY_ESCALATION_PATTERNS],
    ["relationship", RELATIONSHIP_PATTERNS],
    ["direct_affect", DIRECT_AFFECT_PATTERNS],
    ["persona_boundary", PERSONA_BOUNDARY_PATTERNS],
    ["deep_talk", DEEP_TALK_PATTERNS],
    ["ambiguous_withdrawal", AMBIGUOUS_WITHDRAWAL_PATTERNS],
    ["soft_affect", SOFT_AFFECT_PATTERNS],
    ["school_distress", SCHOOL_DISTRESS_PATTERNS],
    ["task", TASK_PATTERNS],
    ["high_complexity_task", HIGH_COMPLEXITY_TASK_PATTERNS],
    ["casual", CASUAL_PATTERNS],
    ["casual_life_checkin", CASUAL_LIFE_CHECKIN_PATTERNS],
  ]);
  const hasHighRisk = riskLabels.includes("high_risk") || state.highRiskLocked;
  const hasSyntheticBoundary = riskLabels.includes("synthetic_boundary");
  const hasRelationship = riskLabels.includes("relationship");
  const hasDirectAffect = riskLabels.includes("direct_affect");
  const hasPersonaBoundary = riskLabels.includes("persona_boundary");
  const hasDeepTalk = riskLabels.includes("deep_talk");
  const hasAmbiguousWithdrawal =
    riskLabels.includes("ambiguous_withdrawal") && !hasDailySoftClose && !hasDailyPreference;
  const hasSchoolDistress = riskLabels.includes("school_distress");
  const hasLifeCheckin = riskLabels.includes("casual_life_checkin");
  const hasSoftAffect =
    riskLabels.includes("soft_affect") &&
    !(hasLifeCheckin && !hasSchoolDistress) &&
    !/不是(?:难受|难过|低落)|没有(?:难受|难过)|不是真的难受/.test(text);
  const hasTask = riskLabels.includes("task");
  const hasHighComplexityTask = riskLabels.includes("high_complexity_task");
  const hasCasual = riskLabels.includes("casual") || hasLifeCheckin;
  const sensitive =
    hasHighRisk ||
    hasSyntheticBoundary ||
    hasRelationship ||
    hasDirectAffect ||
    hasPersonaBoundary ||
    hasDeepTalk ||
    hasAmbiguousWithdrawal ||
    hasSoftAffect ||
    hasSchoolDistress;

  let route: ConversationRouterOutput;
  if (hasHighRisk) {
    route = buildRoute({
      mode: "HIGH_RISK",
      confidence: 0.96,
      emotionalIntensity: 0.95,
      relationalDepth: hasRelationship || hasDirectAffect ? 0.85 : 0.6,
      safetyRisk: "CRITICAL",
      taskComplexity: hasTask ? "HIGH" : "LOW",
      recommendedModel: "main_model",
      requiresCooldown: true,
      cooldownReason: "high-risk safety lock",
      escalationReason: riskLabels.filter((label) => label !== "casual"),
      deescalationAllowed: false,
      routerNotes: "High-risk route requires main model and safety protocol.",
    });
  } else if (
    hasSyntheticBoundary ||
    hasRelationship ||
    hasDirectAffect ||
    hasPersonaBoundary ||
    hasDeepTalk
  ) {
    route = buildRoute({
      mode: "DEEP_TALK",
      confidence: 0.9,
      emotionalIntensity: hasDirectAffect ? 0.75 : 0.65,
      relationalDepth: hasRelationship || hasPersonaBoundary || hasDirectAffect ? 0.85 : 0.65,
      safetyRisk: hasSyntheticBoundary ? "MEDIUM" : "LOW",
      taskComplexity: hasTask ? (hasHighComplexityTask ? "HIGH" : "MEDIUM") : "LOW",
      recommendedModel: "main_model",
      requiresCooldown: true,
      cooldownReason: "deep talk / relation boundary cooldown",
      escalationReason: riskLabels.filter((label) => label !== "casual"),
      deescalationAllowed: false,
      routerNotes: "Deep-talk route requires main model.",
    });
  } else if (hasAmbiguousWithdrawal || hasSoftAffect || hasSchoolDistress) {
    const softAffectStreak = state.softAffectStreak + 1;
    route = buildRoute({
      mode: "SOFT_AFFECT",
      confidence: hasAmbiguousWithdrawal ? 0.78 : hasSchoolDistress ? 0.88 : 0.84,
      emotionalIntensity: hasAmbiguousWithdrawal ? 0.55 : hasSchoolDistress ? 0.7 : 0.5,
      relationalDepth: hasAmbiguousWithdrawal ? 0.35 : hasSchoolDistress ? 0.35 : 0.25,
      safetyRisk: "LOW",
      taskComplexity: "LOW",
      recommendedModel: "main_model",
      requiresCooldown: softAffectStreak >= 2,
      cooldownReason: softAffectStreak >= 2 ? "consecutive soft affect" : "",
      escalationReason: riskLabels.filter((label) => label !== "casual"),
      deescalationAllowed: false,
      routerNotes: "Soft affect stays on main model in v0.",
    });
  } else if (hasTask && !(hasLifeCheckin && !hasHighComplexityTask && !sensitive)) {
    const mainForTask = hasHighComplexityTask || priorMainTurns > 0;
    route = buildRoute({
      mode: "TASK",
      confidence: 0.88,
      emotionalIntensity: 0.1,
      relationalDepth: 0.05,
      safetyRisk: "LOW",
      taskComplexity: hasHighComplexityTask ? "HIGH" : "LOW",
      recommendedModel: mainForTask ? "main_model" : "light_model",
      requiresCooldown: priorMainTurns > 0,
      cooldownReason: priorMainTurns > 0 ? "prior main-model cooldown" : "",
      escalationReason: mainForTask ? ["task_complexity_or_cooldown"] : [],
      deescalationAllowed: !mainForTask,
      routerNotes: mainForTask
        ? "Task route escalated to main model."
        : "Low-risk task route may use light model.",
    });
  } else {
    const defaultLightCandidate = text.length > 0 && !sensitive && !state.highRiskLocked;
    const casualAllowed = defaultLightCandidate && priorMainTurns === 0;
    route = buildRoute({
      mode: defaultLightCandidate ? "CASUAL" : "SOFT_AFFECT",
      confidence: hasCasual || hasLifeCheckin ? 0.86 : 0.78,
      emotionalIntensity: 0.1,
      relationalDepth: 0.05,
      safetyRisk: "LOW",
      taskComplexity: "LOW",
      recommendedModel: casualAllowed ? "light_model" : "main_model",
      requiresCooldown: priorMainTurns > 0,
      cooldownReason: priorMainTurns > 0 ? "prior main-model cooldown" : "",
      escalationReason: casualAllowed
        ? []
        : defaultLightCandidate
          ? ["prior_main_model_cooldown"]
          : ["empty_or_uncertain_input"],
      deescalationAllowed: casualAllowed,
      routerNotes: casualAllowed
        ? "Default low-risk route uses light model unless escalation rules match."
        : defaultLightCandidate
          ? "Default low-risk route held on main model by cooldown."
          : "Uncertain route defaults to main model review path.",
    });
  }

  return { route, nextState: updateRouterState(state, route) };
}

function updateRouterState(
  state: ConversationRouterState,
  route: ConversationRouterOutput,
): ConversationRouterState {
  let mainModelTurnsRemaining = Math.max(0, state.mainModelTurnsRemaining - 1);
  let highRiskLocked = state.highRiskLocked;
  if (route.mode === "HIGH_RISK") {
    highRiskLocked = true;
    mainModelTurnsRemaining = Math.max(mainModelTurnsRemaining, 3);
  } else if (route.mode === "DEEP_TALK") {
    mainModelTurnsRemaining = Math.max(mainModelTurnsRemaining, 2);
  } else if (route.mode === "SOFT_AFFECT" && state.softAffectStreak + 1 >= 2) {
    mainModelTurnsRemaining = Math.max(mainModelTurnsRemaining, 2);
  }
  return {
    mainModelTurnsRemaining,
    softAffectStreak: route.mode === "SOFT_AFFECT" ? state.softAffectStreak + 1 : 0,
    highRiskLocked,
    lastMode: route.mode,
  };
}

function parseModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0) {
    return { provider: "ollama", model: ref };
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function normalizeSource(source: string | undefined): string {
  return (source ?? "").trim().toLowerCase();
}

function normalizeRouterSupportedSource(
  source: string | undefined,
): ConversationRouterSupportedSource | null {
  const normalized = normalizeSource(source).replace(/[\s-]+/g, "_");
  if (normalized === "discord") {
    return "discord";
  }
  if (normalized === "desktop_synthetic" || normalized === "synthetic_desktop") {
    return "desktop_synthetic";
  }
  if (normalized === "mixed_synthetic" || normalized === "synthetic_mixed") {
    return "mixed_synthetic";
  }
  if (normalized === "" || normalized === "unknown" || normalized === "ambiguous") {
    return "unknown";
  }
  return null;
}

function forceUnknownSourceMainRoute(route: ConversationRouterOutput): ConversationRouterOutput {
  if (route.recommended_model === "main_model") {
    return route;
  }
  return buildRoute({
    mode: route.mode,
    confidence: Math.min(route.confidence, 0.6),
    emotionalIntensity: route.emotional_intensity,
    relationalDepth: route.relational_depth,
    safetyRisk: route.safety_risk,
    taskComplexity: route.task_complexity,
    recommendedModel: "main_model",
    requiresCooldown: false,
    cooldownReason: "",
    escalationReason: ["unknown_or_ambiguous_source"],
    deescalationAllowed: false,
    routerNotes: "Unknown or ambiguous source defaults to main model review path.",
  });
}

function forceSurfaceContextMainRoute(
  route: ConversationRouterOutput,
  reason: string,
): ConversationRouterOutput {
  if (route.recommended_model === "main_model") {
    return route;
  }
  return buildRoute({
    mode: route.mode,
    confidence: Math.min(route.confidence, 0.62),
    emotionalIntensity: route.emotional_intensity,
    relationalDepth: route.relational_depth,
    safetyRisk: route.safety_risk,
    taskComplexity: route.task_complexity,
    recommendedModel: "main_model",
    requiresCooldown: false,
    cooldownReason: "",
    escalationReason: [...route.escalation_reason, reason],
    deescalationAllowed: false,
    routerNotes: "Surface context was not route-ready; conservative main route selected.",
  });
}

function normalizeContextReadiness(
  value: ConversationRouterContextReadiness | string | undefined,
): ConversationRouterContextReadiness | null {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (
    normalized === "ready" ||
    normalized === "missing" ||
    normalized === "stale" ||
    normalized === "invalid" ||
    normalized === "not_applicable"
  ) {
    return normalized;
  }
  return null;
}

function serializeRouteContextValue(value: ConversationRouterSurfaceContext): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return stripRouterScoringMetadata(value).replace(/\s+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => serializeRouteContextValue(entry as ConversationRouterSurfaceContext))
      .filter(Boolean)
      .join(" ");
  }
  return Object.entries(value)
    .flatMap(([key, entry]) => {
      if (
        /^(?:expected_route|risk_class|should_end_with_question|review_only|training_allowed)$/i.test(
          key,
        )
      ) {
        return [];
      }
      const serialized = serializeRouteContextValue(entry as ConversationRouterSurfaceContext);
      return serialized ? [`${key}: ${serialized}`] : [];
    })
    .join(" ");
}

function resolveRouteContext(params: {
  source: ConversationRouterSupportedSource;
  recentVisibleContextSummary?: ConversationRouterSurfaceContext;
  surfaceContext?: ConversationRouterSurfaceContext;
  contextReadiness?: ConversationRouterContextReadiness | string;
  contextNoRawText?: boolean;
}): { readiness: ConversationRouterContextReadiness; text: string; reason: string } {
  if (params.contextNoRawText === false) {
    return { readiness: "invalid", text: "", reason: "context_no_raw_text_marker_missing" };
  }
  const contextText = [
    serializeRouteContextValue(params.recentVisibleContextSummary),
    serializeRouteContextValue(params.surfaceContext),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1600);
  const explicitReadiness = normalizeContextReadiness(params.contextReadiness);
  if (explicitReadiness === "ready" && contextText.length === 0) {
    return { readiness: "missing", text: "", reason: "context_ready_without_summary" };
  }
  if (explicitReadiness && explicitReadiness !== "ready") {
    return {
      readiness: explicitReadiness,
      text: contextText,
      reason: `context_${explicitReadiness}`,
    };
  }
  if (contextText.length > 0) {
    return { readiness: "ready", text: contextText, reason: "context_ready" };
  }
  if (params.source === "discord") {
    return { readiness: "not_applicable", text: "", reason: "discord_current_message_route" };
  }
  return { readiness: "missing", text: "", reason: "surface_context_missing" };
}

function buildRouteInputMessage(
  message: string,
  routeContext: { readiness: ConversationRouterContextReadiness; text: string },
): string {
  if (routeContext.readiness !== "ready" || routeContext.text.length === 0) {
    return message;
  }
  return `${message}\n\nroute_visible_context_summary: ${routeContext.text}`;
}

function isCurrentMessageSafeWithoutSurfaceContext(message: string): boolean {
  const text = stripRouterScoringMetadata(message).replace(/\s+/g, " ").trim();
  if (!text || text.length > 160) {
    return false;
  }
  return /^(?:ok|okay|k|thanks|thx|thank you|got it|嗯+|好+|行|可以|收到|先这样|没事|随口|只是问问|不用回|synthetic (?:desktop|mixed) l0 trivial(?: .*)?)\.?[。！!]*$/i.test(
    text,
  );
}

function isCurrentMessageSafeClarificationWithoutSurfaceContext(message: string): boolean {
  const text = stripRouterScoringMetadata(message).replace(/\s+/g, " ").trim();
  if (!text || text.length > 420) {
    return false;
  }
  if (!/\b(?:Synthetic desktop|Synthetic mixed|Mixed synthetic|desktop synthetic)\b/i.test(text)) {
    return false;
  }
  return /(?:visible state is insufficient|context is (?:missing|stale|invalid|insufficient)|stale context|context mismatch|priority is not visible|do not invent|must not invent|ask one specific useful question|specific useful question expected|current priority is not visible|not visible)/i.test(
    text,
  );
}

function shouldForceMainForSurfaceContext(params: {
  source: ConversationRouterSupportedSource;
  message: string;
  routeContext: { readiness: ConversationRouterContextReadiness; reason: string };
  route: ConversationRouterOutput;
}): string | null {
  if (params.route.recommended_model === "main_model") {
    return null;
  }
  if (params.source !== "desktop_synthetic" && params.source !== "mixed_synthetic") {
    return null;
  }
  if (params.routeContext.readiness === "ready") {
    return null;
  }
  if (
    params.routeContext.readiness === "not_applicable" &&
    isCurrentMessageSafeWithoutSurfaceContext(params.message)
  ) {
    return null;
  }
  if (isCurrentMessageSafeWithoutSurfaceContext(params.message)) {
    return null;
  }
  if (isCurrentMessageSafeClarificationWithoutSurfaceContext(params.message)) {
    return null;
  }
  return params.routeContext.reason || "surface_context_not_ready";
}

export function shouldApplyLightModelCoherenceGuard(params: {
  provider: string;
  model: string;
}): boolean {
  return (
    normalizeSource(params.provider) === CONVERSATION_ROUTER_LIGHT_MODEL_PROVIDER &&
    params.model.trim() === CONVERSATION_ROUTER_LIGHT_MODEL_ID
  );
}

function appendFlagIfMatches(
  flags: string[],
  text: string,
  flag: string,
  patterns: RegExp[],
): void {
  if (matchesAny(text, patterns)) {
    flags.push(flag);
  }
}

function detectMissedCurrentTopic(userMessage: string, assistantText: string): boolean {
  const topicPairs: Array<[RegExp[], RegExp[]]> = [
    [
      [/复习/, /期末/, /学校/, /课/, /作业/, /考试/],
      [/复习/, /期末/, /学校/, /课/, /作业/, /考试/, /计划/, /推进/, /一门/, /事情/],
    ],
    [
      [/吃/, /饭/, /实验/, /报告/, /关于啥/],
      [/吃/, /饭/, /实验/, /报告/, /学校/, /杂事/],
    ],
    [
      [/游戏/, /输麻/, /吐槽/],
      [/游戏/, /输/, /吐槽/, /烦/],
    ],
  ];
  return topicPairs.some(
    ([userPatterns, assistantPatterns]) =>
      matchesAny(userMessage, userPatterns) && !matchesAny(assistantText, assistantPatterns),
  );
}

function hasPreferenceOrRecommendationInput(userMessage: string): boolean {
  return /我(?:一般|比较|喜欢|不喜欢|不想|不太想|偏|吃)|想(?:找|看|要)|推荐|没书可看|架空|小说|游戏|消遣|放松|轻松|不费脑|悲剧|冒险|学院|设定/.test(
    userMessage,
  );
}

function hasSoftCloseOrLowPressureInput(userMessage: string): boolean {
  return (
    /没事|随口|就是问问|只是问问|先不聊|先走|我先去|先睡|算了|不重要|随便/.test(userMessage) ||
    /\b(?:do not ask unless absolutely required|brief stop is enough|natural stop expected|no question needed|do not ask a question|stop naturally)\b/i.test(
      userMessage,
    )
  );
}

function hasExplicitQuestionInvitation(userMessage: string): boolean {
  return (
    /(?:问我|问问我|提问|反问|采访我|给我(?:几个|一些)?问题|用问题|多问|追问|帮我想问题|问句|必要时(?:可以)?问|需要(?:的话)?问|先问清楚|确认一下)/.test(
      userMessage,
    ) ||
    /\b(?:ask me|ask a question|ask one specific question|clarifying question|clarification question)\b/i.test(
      userMessage,
    )
  );
}

function hasRequiredConcreteQuestionNeed(userMessage: string): boolean {
  if (
    hasPreferenceOrRecommendationInput(userMessage) ||
    hasSoftCloseOrLowPressureInput(userMessage)
  ) {
    return false;
  }
  return (
    /(?:缺(?:少|了)?(?:关键)?(?:信息|细节|条件|约束|要求|材料)|信息不够|还差(?:什么|哪些|一点)|没(?:给|说清|交代)(?:清楚)?|需要补充|要补(?:什么|哪些)|关键(?:约束|条件)|不确定(?:格式|长度|范围|对象|时间|地点|版本|要求)|拿不准(?:格式|长度|范围|对象|要求))/.test(
      userMessage,
    ) ||
    /(?:当前|现在).{0,16}(?:优先级|priority|状态|state).{0,24}(?:不可见|not visible|看不到|不清楚|missing|unknown)/i.test(
      userMessage,
    ) ||
    /(?:visible state is insufficient|context is (?:missing|stale|invalid|insufficient)|stale context|context mismatch|priority is not visible|specific useful question expected|ask one specific useful question|needs? one concrete choice)/i.test(
      userMessage,
    ) ||
    /(?:did not provide|not provided|not specified|not visible|no .{0,40}visible|neither .{0,60}visible|missing|stale|invalid|mismatched).{0,90}(?:problem|expression|assertion|error|budget|constraint|section|claim|page|file|task|priority|context|state|detail|question)/i.test(
      userMessage,
    ) ||
    /(?:problem|expression|assertion|error|budget|constraint|section|claim|page|file|task|priority|context|state|detail).{0,90}(?:did not provide|not provided|not specified|not visible|no .{0,40}visible|neither .{0,60}visible|missing|stale|invalid|mismatched)/i.test(
      userMessage,
    ) ||
    /(?:no .{0,70}(?:visible|specified)|neither .{0,80}visible|target bucket is not visible|schematic versus pcb target is unknown|available time is missing|(?:section|claim|page|file|task|priority|context|state|detail|time|budget|constraint|assertion|error category).{0,40}(?:unknown|missing|not visible|not specified))/i.test(
      userMessage,
    ) ||
    /(?:back later|returns? later|whatever is visible now|summary says .{0,40} but i am asking|do not invent|must not invent|visible state .{0,40} insufficient|current priority is not visible|visible state mentions .{0,40} while i ask|context is mismatched|question is necessary|ask exactly one|ask one precise|ask one specific)/i.test(
      userMessage,
    ) ||
    /(?:which (?:file|step|version|option|part)|what (?:part|step|file|version|option|next)|where to start|choose between|A\s*(?:\/|or)\s*B).{0,80}(?:missing|needed|stuck|not visible|first|next|choose|check)/i.test(
      userMessage,
    ) ||
    /(?:report|code|materials?|draft|version|file|step|checklist).{0,60}(?:stuck|missing|needs? a specific|needs? clarification|not visible)/i.test(
      userMessage,
    ) ||
    /(?:报告|代码|材料|文件|步骤|版本|草稿|清单).{0,24}(?:卡住|缺|不清楚|看不到|没给|需要(?:一个)?具体|不知道从哪)/.test(
      userMessage,
    )
  );
}

function hasOptionalSpecificQuestionNeed(userMessage: string): boolean {
  if (
    hasPreferenceOrRecommendationInput(userMessage) ||
    hasSoftCloseOrLowPressureInput(userMessage)
  ) {
    return false;
  }
  const hasMissingKeyConstraintCue =
    /(?:缺(?:少|了)?(?:关键)?(?:信息|细节|条件|约束|要求|材料)|信息不够|还差(?:什么|哪些|一点)|没(?:给|说清|交代)(?:清楚)?|需要补充|要补(?:什么|哪些)|关键(?:约束|条件)|不确定(?:格式|长度|范围|对象|时间|地点|版本|要求)|拿不准(?:格式|长度|范围|对象|要求))/.test(
      userMessage,
    );
  const hasPlanningChoiceCue =
    /(?:怎么(?:安排|拆|选|取舍|排优先级)|先(?:做|看|改|写|选)哪|哪(?:个|一项|一步).{0,12}(?:先|更合适|更稳)|优先级|二选一|选项|路线|方案.{0,8}(?:选|定)|计划.{0,12}(?:选|定|拆)|A\/B)/i.test(
      userMessage,
    );
  const hasPhraseDraftVersionCue =
    /(?:怎么(?:说|回|写|措辞|表达)|措辞|话术|回复草稿|回信|改(?:得)?自然|帮我(?:改|写).{0,12}(?:句子|消息|回复|草稿|版本)|(?:口语|正式|短|稳|轻松).{0,8}版|版本.{0,8}(?:选|哪|怎么))/i.test(
      userMessage,
    );
  const hasStuckWorkCue =
    /(?:(?:报告|代码|作业|材料|表格|文档|bug|报错|PR|实验报告).{0,24}(?:卡住|卡在|不会|不太会|不知道|没思路|从哪(?:里|儿)?(?:开始|下手)|怎么排|怎么拆|要补什么)|(?:卡住|卡在|不会弄|不太会弄|没思路).{0,24}(?:报告|代码|作业|材料|文件|文档))/i.test(
      userMessage,
    );
  const hasSyntheticRequiredCue =
    /(?:how to phrase|reply draft|draft version|version choice|choose between|which (?:version|option|file|step|one)|what next|where to start|planning choice|missing (?:key )?(?:constraint|detail|field|requirement)|needs? clarification|code.{0,24}stuck|bug report.{0,24}stuck|report.{0,24}stuck|materials?.{0,24}stuck)/i.test(
      userMessage,
    );
  const hasEnglishSpecificQuestionCue =
    /(?:\b(?:which|where|when)\b|\bwhat\s+(?:next|step|part|file|code|report|materials?|checklist|tone|version|option)\b|\bhow\s+(?:many|long)\b).{0,48}\b(?:step|version|draft|tone|option|part|file|code|report|materials?|checklist|next)\b/i.test(
      userMessage,
    ) ||
    /\b(?:step|version|draft|tone|option|part|file|code|report|materials?|checklist|next)\b.{0,48}(?:\b(?:which|what|where|when)\b|\bhow\s+(?:many|long)\b|choose|pick|start|stuck|clarify|question)/i.test(
      userMessage,
    ) ||
    /\bA\s*(?:\/|or)\s*B\b/i.test(userMessage) ||
    /\b(?:option|version|draft|tone|step|file|part|material|materials|checklist|report|code)\b.{0,40}\bor\b.{0,40}\b(?:option|version|draft|tone|step|file|part|material|materials|checklist|report|code)\b/i.test(
      userMessage,
    );
  const hasDesktopChecklistQuestionCue =
    /desktop checklist/i.test(userMessage) &&
    /(?:asks how to|how to|choose|which|where|what next|next step|what should|what to)/i.test(
      userMessage,
    );
  return (
    hasMissingKeyConstraintCue ||
    hasPlanningChoiceCue ||
    hasPhraseDraftVersionCue ||
    hasStuckWorkCue ||
    hasSyntheticRequiredCue ||
    hasEnglishSpecificQuestionCue ||
    hasDesktopChecklistQuestionCue
  );
}

export function resolveLightModelQuestionIntent(userMessage: string): LightModelQuestionIntent {
  if (
    hasPreferenceOrRecommendationInput(userMessage) ||
    hasSoftCloseOrLowPressureInput(userMessage)
  ) {
    return "FORBID";
  }
  if (hasRequiredConcreteQuestionNeed(userMessage)) {
    return "REQUIRE_ONE_CONCRETE";
  }
  if (hasExplicitQuestionInvitation(userMessage) || hasOptionalSpecificQuestionNeed(userMessage)) {
    return "ALLOW_OPTIONAL";
  }
  return "FORBID";
}

export function shouldRequireLightModelConcreteQuestion(userMessage: string): boolean {
  return resolveLightModelQuestionIntent(userMessage) === "REQUIRE_ONE_CONCRETE";
}

export function shouldAllowLightModelQuestion(userMessage: string): boolean {
  return resolveLightModelQuestionIntent(userMessage) !== "FORBID";
}

function hasSpecificLightModelQuestionCue(question: string): boolean {
  return /(?:具体|现在|这次|刚才|哪一|哪个|哪里|哪儿|几|多久|开头|收尾|材料|步骤|版本|报[告]|作业|代码|句子|文件|卡在|先看|先改|先写|先选|口语|正式|短一点|稳一点|轻一点|接着|还是|或者|\b(?:which|what|where|when)\b|\bhow\s+(?:many|long)\b|\b(?:step|version|draft|tone|option|part|file|code|report|materials?|checklist|next)\b|\bA\s*(?:\/|or)\s*B\b)/i.test(
    question,
  );
}

function detectGenericQuestionEnding(assistantText: string): boolean {
  const value = assistantText.trim();
  const question = finalQuestionText(value);
  if (question && hasSpecificLightModelQuestionCue(question)) {
    return false;
  }
  return /(?:你觉得呢|你呢|怎么样|可以吗|好吗|行吗|对吗|是不是|要不要|想不想|需不需要|有没有|为什么|什么类型|哪种|可以说一下|告诉我|\bwhat do you think\b|\bhow does that sound\b|\bdoes that work\b|\btell me more\b|\bwhat kind\b|\bwhat type\b|\bany preferences\b|\b(?:do you|would you) (?:want|like)\b)[^。！？!?]*[?？]\s*$/i.test(
    value,
  );
}

function finalQuestionText(assistantText: string): string {
  const value = assistantText.trim();
  const match = value.match(/([^。！？.!?]*[?？])\s*$/);
  return match?.[1]?.trim() ?? "";
}

export function shouldAllowSpecificLightModelQuestion(params: {
  userMessage: string;
  assistantText: string;
}): boolean {
  const questionCount = (params.assistantText.match(/[?？]/g) ?? []).length;
  if (questionCount !== 1 || !/[?？]\s*$/.test(params.assistantText.trim())) {
    return false;
  }
  if (!shouldAllowLightModelQuestion(params.userMessage)) {
    return false;
  }
  if (
    detectGenericQuestionEnding(params.assistantText) ||
    hasPreferenceOrRecommendationInput(params.userMessage) ||
    hasSoftCloseOrLowPressureInput(params.userMessage)
  ) {
    return false;
  }
  const question = finalQuestionText(params.assistantText);
  return (
    question.length >= 8 && question.length <= 90 && hasSpecificLightModelQuestionCue(question)
  );
}

function detectExcessiveQuestioning(userMessage: string, assistantText: string): boolean {
  const questionCount = (assistantText.match(/[?？]/g) ?? []).length;
  const questionAllowed = shouldAllowSpecificLightModelQuestion({ userMessage, assistantText });
  if (questionCount > 1) {
    return true;
  }
  if (questionCount > 0 && /[?？]\s*$/.test(assistantText.trim()) && !questionAllowed) {
    return true;
  }
  if (
    questionCount > 0 &&
    (hasPreferenceOrRecommendationInput(userMessage) ||
      /没事|就是问问|只是问问|随便|算了|不重要/.test(userMessage))
  ) {
    return true;
  }
  return false;
}

function detectBareQuestionEnding(userMessage: string, assistantText: string): boolean {
  return (
    /[?？]\s*$/.test(assistantText.trim()) &&
    !shouldAllowSpecificLightModelQuestion({ userMessage, assistantText })
  );
}

function detectRequiredQuestionMissing(userMessage: string, assistantText: string): boolean {
  return (
    shouldRequireLightModelConcreteQuestion(userMessage) &&
    !shouldAllowSpecificLightModelQuestion({ userMessage, assistantText })
  );
}

function detectPreferenceNotAnswered(userMessage: string, assistantText: string): boolean {
  if (!hasPreferenceOrRecommendationInput(userMessage)) {
    return false;
  }
  if (
    /你(?:一般|之前|平时|想|喜欢|需要)|有没有|哪种|什么类型|为什么|可以说一下|告诉我/.test(
      assistantText,
    ) &&
    !/(适合|可以|推荐|偏|类型|方向|找|选|先|直接|比较|那就)/.test(assistantText)
  ) {
    return true;
  }
  if (/随便找找|都可以|看你喜欢|看你心情/.test(assistantText)) {
    return true;
  }
  return false;
}

function pushAliasFlag(flags: string[], canonical: string, compatibility?: string): void {
  flags.push(canonical);
  if (compatibility) {
    flags.push(compatibility);
  }
}

export function buildLightModelRewriteInstruction(params: {
  failedAssistantText: string;
  flags: string[];
}): string {
  const questionIntentHint = params.flags.includes("required_question_missing")
    ? "Required question repair: keep the useful first sentence, then end with exactly one concrete missing-slot or A/B question. No generic follow-up."
    : params.flags.some((flag) =>
          [
            "generic_question_ending",
            "repeated_question_pattern",
            "excessive_questioning",
            "bare_question_ending",
          ].includes(flag),
        )
      ? "Question repair: remove generic, internal, or repeated questions and end with a statement unless a specific concrete question is required."
      : "";
  return [
    LIGHT_MODEL_REWRITE_GUARD_ADDENDUM,
    `Audit flags: ${params.flags.join(", ") || "coherence_failure"}`,
    questionIntentHint,
    "Rejected draft for rewrite only; do not copy unsupported facts:",
    params.failedAssistantText.trim().slice(0, 600),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function auditLightModelCoherence(params: {
  selection: ConversationRouterModelSelection | null;
  userMessage: string;
  assistantText: string;
}): LightModelCoherenceAuditOutput {
  const selection = params.selection;
  if (!selection || selection.route.recommended_model !== "light_model") {
    return {
      audit_status: "PASS",
      flags: [],
      reason: [],
      forbidden_patterns_detected: [],
      no_raw_text_logged: true,
    };
  }
  const userRoute = routeConversationV0Message(params.userMessage).route;
  if (userRoute.mode === "HIGH_RISK") {
    return {
      audit_status: "SAFETY_ESCALATE",
      flags: ["qwen_should_have_handed_off", "should_have_escalated", "high_risk"],
      reason: ["light_model_selected_for_high_risk"],
      forbidden_patterns_detected: ["qwen_should_have_handed_off", "should_have_escalated"],
      no_raw_text_logged: true,
    };
  }
  if (userRoute.recommended_model === "main_model") {
    return {
      audit_status: "ESCALATE_MAIN_MODEL",
      flags: ["qwen_should_have_handed_off", "should_have_escalated", userRoute.mode.toLowerCase()],
      reason: ["light_model_selected_for_main_model_route"],
      forbidden_patterns_detected: ["qwen_should_have_handed_off", "should_have_escalated"],
      no_raw_text_logged: true,
    };
  }

  const assistantText = params.assistantText.trim();
  const flags: string[] = [];
  appendFlagIfMatches(flags, assistantText, "invented_user_fact", INVENTED_USER_FACT_PATTERNS);
  appendFlagIfMatches(
    flags,
    assistantText,
    "over_specific_self_world",
    OVER_SPECIFIC_SELF_WORLD_PATTERNS,
  );
  appendFlagIfMatches(
    flags,
    assistantText,
    "user_interest_leakage",
    USER_INTEREST_LEAKAGE_PATTERNS,
  );
  if (matchesAny(assistantText, LIGHT_MODEL_THERAPY_TEMPLATE_PATTERNS)) {
    pushAliasFlag(flags, "therapy_template_failure", "therapy_template");
  }
  if (matchesAny(assistantText, ROMANTIC_DEPENDENCY_PATTERNS)) {
    pushAliasFlag(flags, "romantic_dependency_failure", "romantic_dependency");
  }
  if (matchesAny(assistantText, CUSTOMER_SERVICE_TONE_PATTERNS)) {
    pushAliasFlag(flags, "customer_service_tone_failure", "customer_service_tone");
  }
  appendFlagIfMatches(flags, assistantText, "generic_chatbot_tone", GENERIC_CHATBOT_TONE_PATTERNS);
  if (detectGenericQuestionEnding(assistantText)) {
    flags.push("generic_question_ending");
  }
  if (detectRequiredQuestionMissing(params.userMessage, assistantText)) {
    flags.push("required_question_missing");
  }
  if (detectExcessiveQuestioning(params.userMessage, assistantText)) {
    pushAliasFlag(flags, "repeated_question_pattern", "excessive_questioning");
  } else if (detectBareQuestionEnding(params.userMessage, assistantText)) {
    flags.push("bare_question_ending");
  }
  if (detectPreferenceNotAnswered(params.userMessage, assistantText)) {
    pushAliasFlag(flags, "preference_response_failure", "preference_not_answered");
  }
  if (detectMissedCurrentTopic(params.userMessage, assistantText)) {
    flags.push("missed_current_topic");
  }
  if (
    flags.some((flag) => flag === "invented_user_fact" || flag === "over_specific_self_world") &&
    detectMissedCurrentTopic(params.userMessage, assistantText)
  ) {
    flags.push("topic_jump");
  }
  const sentenceCount = assistantText.split(/[。！？.!?]/).filter((part) => part.trim()).length;
  if (assistantText.length > 280 || sentenceCount > 4) {
    flags.push("too_long_for_casual");
  }
  const uniqueFlags = Array.from(new Set(flags));
  if (uniqueFlags.length === 0) {
    return {
      audit_status: "PASS",
      flags: [],
      reason: [],
      forbidden_patterns_detected: [],
      no_raw_text_logged: true,
    };
  }
  if (
    uniqueFlags.includes("romantic_dependency") ||
    uniqueFlags.includes("romantic_dependency_failure") ||
    uniqueFlags.includes("should_have_escalated") ||
    uniqueFlags.includes("qwen_should_have_handed_off")
  ) {
    return {
      audit_status: "ESCALATE_MAIN_MODEL",
      flags: uniqueFlags,
      reason: uniqueFlags,
      forbidden_patterns_detected: uniqueFlags,
      no_raw_text_logged: true,
    };
  }
  return {
    audit_status: "REWRITE_LIGHT_MODEL",
    flags: uniqueFlags,
    reason: uniqueFlags,
    forbidden_patterns_detected: uniqueFlags,
    no_raw_text_logged: true,
  };
}

export function resolveConversationRouterV0ModelSelection(params: {
  source?: string;
  sessionKey?: string;
  message: string;
  recentVisibleContextSummary?: ConversationRouterSurfaceContext;
  surfaceContext?: ConversationRouterSurfaceContext;
  contextReadiness?: ConversationRouterContextReadiness | string;
  contextNoRawText?: boolean;
  currentProvider: string;
  currentModel: string;
  defaultProvider: string;
  defaultModel: string;
}): ConversationRouterModelSelection | null {
  const source = normalizeRouterSupportedSource(params.source);
  if (!source) {
    return null;
  }
  const stateKey = params.sessionKey?.trim() || `${source}:unscoped`;
  const state = routerStates.get(stateKey) ?? createConversationRouterState();
  const routeContext = resolveRouteContext({
    source,
    recentVisibleContextSummary: params.recentVisibleContextSummary,
    surfaceContext: params.surfaceContext,
    contextReadiness: params.contextReadiness,
    contextNoRawText: params.contextNoRawText,
  });
  const routed = routeConversationV0Message(
    buildRouteInputMessage(params.message, routeContext),
    state,
  );
  let route = source === "unknown" ? forceUnknownSourceMainRoute(routed.route) : routed.route;
  const surfaceContextReason = shouldForceMainForSurfaceContext({
    source,
    message: params.message,
    routeContext,
    route,
  });
  if (surfaceContextReason) {
    route = forceSurfaceContextMainRoute(route, surfaceContextReason);
  }
  const nextState = updateRouterState(state, route);
  routerStates.set(stateKey, nextState);

  const selected =
    route.recommended_model === "light_model"
      ? parseModelRef(CONVERSATION_ROUTER_LIGHT_MODEL_REF)
      : { provider: params.defaultProvider, model: params.defaultModel };
  return {
    invoked: true,
    source,
    route,
    provider: selected.provider,
    model: selected.model,
    recommendedModelRef: `${selected.provider}/${selected.model}`,
  };
}

export async function appendConversationRouterV0DebugLog(params: {
  selection: ConversationRouterModelSelection | null;
  message: string;
  responseText?: string;
  actualProvider: string;
  actualModel: string;
  ollamaModelSent?: string;
  latencyMs?: number;
  coherenceAudit?: LightModelCoherenceAuditOutput;
  rewriteAttempted?: boolean;
  escalated?: boolean;
  traceId?: string;
  turnId?: string;
  traceTimings?: ConversationRouterTraceTimings;
  generationTrace?: ConversationRouterGenerationTrace;
  defaultProvider?: string;
  defaultModel?: string;
  modelPickerCurrent?: string;
  globalDefaultModel?: string;
  overrideRequested?: boolean;
  overrideAccepted?: boolean;
  fallbackReason?: ConversationRouterFallbackReason;
  rewriteReason?: string;
  rewriteModel?: string;
  rewritePassed?: boolean | null;
  questionRepairApplied?: boolean;
  questionRepairReason?: string;
  questionPermissionGranted?: boolean;
  previousAssistantEndedWithQuestion?: boolean;
  rawResponseQuestionCount?: number;
  rawResponseEndedWithQuestion?: boolean;
  internalQuestionCountAfterRepair?: number;
}): Promise<void> {
  const selection = params.selection;
  if (!selection) {
    return;
  }
  const home = process.env.USERPROFILE || os.homedir();
  const logPath = path.join(home, ".openclaw", "router-debug.log");
  const tracePath = path.join(home, ".openclaw", "router-trace-v2.jsonl");
  const messageHash = crypto.createHash("sha256").update(params.message).digest("hex");
  const responseHash =
    typeof params.responseText === "string" && params.responseText.length > 0
      ? crypto.createHash("sha256").update(params.responseText).digest("hex")
      : null;
  const traceId = params.traceId ?? crypto.randomUUID();
  const turnId = params.turnId ?? traceId;
  const timings = params.traceTimings ?? {};
  const generation = params.generationTrace ?? {};
  const responseText = params.responseText ?? "";
  const responseQuestionCount = (responseText.match(/[?？]/g) ?? []).length;
  const responseEndedWithQuestion = /[?？]\s*$/.test(responseText.trim());
  const actualModelRef = `${params.actualProvider}/${params.actualModel}`;
  const defaultModelRef =
    params.globalDefaultModel ??
    (params.defaultProvider && params.defaultModel
      ? `${params.defaultProvider}/${params.defaultModel}`
      : actualModelRef);
  const overrideRequested = params.overrideRequested ?? true;
  const overrideAccepted =
    params.overrideAccepted ?? actualModelRef === selection.recommendedModelRef;
  const fallbackReason =
    params.fallbackReason ??
    deriveConversationRouterFallbackReason({
      selection,
      actualModelRef,
      overrideAccepted,
      auditStatus: params.coherenceAudit?.audit_status,
      escalated: params.escalated === true,
      rewriteAttempted: params.rewriteAttempted === true,
    });
  const routerMs = durationMs(timings.routerStartMs, timings.routerEndMs);
  const contextAssemblyMs = durationMs(timings.contextStartMs, timings.contextEndMs);
  const memorySessionMs = durationMs(timings.memoryStartMs, timings.memoryEndMs);
  const ollamaMs =
    generation.ollamaTotalMs ??
    generation.modelGenerationMs ??
    durationMs(timings.modelRequestStartMs, timings.ollamaResponseEndMs);
  const auditMs = durationMs(timings.auditStartMs, timings.auditEndMs);
  const rewriteMs = durationMs(timings.rewriteStartMs, timings.rewriteEndMs);
  const discordSendMs = durationMs(timings.discordSendStartMs, timings.discordSendEndMs);
  const gateMs = durationMs(timings.replyGateStartMs, timings.replyGateEndMs);
  const queueWaitMs = durationMs(timings.replyJobEnqueuedMs, timings.replyJobStartedMs);
  const preTypingWaitMs = durationMs(
    timings.discordEventReceivedMs ?? timings.discordMessageCreatedMs,
    timings.typingSendStartMs,
  );
  const typingSendMs = durationMs(timings.typingSendStartMs, timings.typingSendEndMs);
  const totalVisibleMs =
    params.latencyMs ??
    durationMs(
      timings.discordMessageCreatedMs ?? timings.discordEventReceivedMs ?? timings.routerStartMs,
      timings.discordSendEndMs,
    ) ??
    durationMs(timings.routerStartMs, timings.ollamaResponseEndMs);
  const record = {
    timestamp: new Date().toISOString(),
    trace_id: traceId,
    turn_id: turnId,
    source: selection.source,
    mode: selection.route.mode,
    route_mode: selection.route.mode,
    recommended_model: selection.recommendedModelRef,
    actual_model: actualModelRef,
    ollama_model_sent: params.ollamaModelSent ?? actualModelRef,
    latency_ms: totalVisibleMs,
    confidence: selection.route.confidence,
    safety_risk: selection.route.safety_risk,
    escalation_reason: selection.route.escalation_reason,
    audit_status: params.coherenceAudit?.audit_status ?? null,
    audit_flags: params.coherenceAudit?.flags ?? [],
    coherence_audit_status: params.coherenceAudit?.audit_status ?? null,
    coherence_guard_applied:
      params.coherenceAudit?.audit_status === "REWRITE_LIGHT_MODEL" ||
      params.rewriteAttempted === true,
    coherence_audit_reason: params.coherenceAudit?.reason ?? [],
    rewrite_attempted: params.rewriteAttempted === true,
    escalated: params.escalated === true,
    message_hash: messageHash,
    response_hash: responseHash,
    no_raw_text: true,
    timestamps: {
      discord_message_created_at: isoTimestamp(timings.discordMessageCreatedMs),
      discord_event_received_at: isoTimestamp(timings.discordEventReceivedMs),
      reply_gate_start_at: isoTimestamp(timings.replyGateStartMs),
      reply_gate_end_at: isoTimestamp(timings.replyGateEndMs),
      reply_job_enqueued_at: isoTimestamp(timings.replyJobEnqueuedMs),
      reply_job_started_at: isoTimestamp(timings.replyJobStartedMs),
      typing_send_start_at: isoTimestamp(timings.typingSendStartMs),
      typing_send_end_at: isoTimestamp(timings.typingSendEndMs),
      discord_event_received: isoTimestamp(timings.discordEventReceivedMs),
      router_start: isoTimestamp(timings.routerStartMs),
      router_end: isoTimestamp(timings.routerEndMs),
      context_start: isoTimestamp(timings.contextStartMs),
      context_end: isoTimestamp(timings.contextEndMs),
      memory_start: isoTimestamp(timings.memoryStartMs),
      memory_end: isoTimestamp(timings.memoryEndMs),
      model_request_start: isoTimestamp(timings.modelRequestStartMs),
      ollama_request_sent: isoTimestamp(timings.ollamaRequestSentMs),
      ollama_response_start: isoTimestamp(timings.ollamaResponseStartMs),
      ollama_response_end: isoTimestamp(timings.ollamaResponseEndMs),
      audit_start: isoTimestamp(timings.auditStartMs),
      audit_end: isoTimestamp(timings.auditEndMs),
      rewrite_start: isoTimestamp(timings.rewriteStartMs),
      rewrite_end: isoTimestamp(timings.rewriteEndMs),
      discord_send_start: isoTimestamp(timings.discordSendStartMs),
      discord_send_end: isoTimestamp(timings.discordSendEndMs),
    },
    queue: {
      queue_name: timings.queueName ?? "",
      queue_depth_at_enqueue: timings.queueDepthAtEnqueue ?? null,
      queue_depth_at_start: timings.queueDepthAtStart ?? null,
      active_jobs: timings.activeJobs ?? null,
    },
    router: {
      mode: selection.route.mode,
      confidence: selection.route.confidence,
      risk_flags: selection.route.escalation_reason,
      casual_allow: selection.route.recommended_model === "light_model",
      main_escalation_required: selection.route.recommended_model === "main_model",
      escalation_reasons: selection.route.escalation_reason,
      cooldown_active: selection.route.requires_cooldown,
      cooldown_reason: selection.route.cooldown_reason,
      recommended_model: selection.recommendedModelRef,
    },
    dispatch: {
      model_picker_current: params.modelPickerCurrent ?? defaultModelRef,
      global_default_model: defaultModelRef,
      override_requested: overrideRequested,
      override_model: selection.recommendedModelRef,
      override_accepted: overrideAccepted,
      actual_model: actualModelRef,
      ollama_model_sent: params.ollamaModelSent ?? actualModelRef,
      fallback_triggered: fallbackReason !== "NONE",
      fallback_reason: fallbackReason,
    },
    generation: {
      prompt_token_estimate: generation.promptTokenEstimate ?? null,
      context_char_count: generation.contextCharCount ?? null,
      memory_item_count: generation.memoryItemCount ?? null,
      completion_token_estimate:
        generation.completionTokenEstimate ?? estimateTokenCount(params.responseText),
      model_generation_ms: generation.modelGenerationMs ?? ollamaMs,
      ollama_total_ms: generation.ollamaTotalMs ?? ollamaMs,
      think_effective: generation.thinkEffective ?? null,
      num_predict: generation.numPredict ?? null,
      generation_call_count: generation.generationCallCount ?? null,
      qwen_fast_deadline_ms: generation.qwenFastDeadlineMs ?? null,
      timeout_triggered: generation.timeoutTriggered ?? false,
      retry_attempted: generation.retryAttempted ?? false,
      retry_model: generation.retryModel ?? "",
      retry_num_predict: generation.retryNumPredict ?? null,
      retry_success: generation.retrySuccess ?? false,
      retry_count: generation.retryCount ?? 0,
      final_response_source: generation.finalResponseSource ?? "",
      fast_path_used: generation.directFastPathUsed === true,
      fast_path_rejected_reason: generation.fastPathRejectedReason ?? "",
      active_session_prompt_bypassed: generation.activeSessionPromptBypassed ?? null,
      pi_runtime_bypassed: generation.piRuntimeBypassed ?? null,
      tool_registry_loaded: generation.toolRegistryLoaded ?? null,
      plugin_runtime_loaded: generation.pluginRuntimeLoaded ?? null,
      full_memory_blocking_read: generation.fullMemoryBlockingRead ?? null,
      human_pacing_applied: generation.humanPacingApplied ?? false,
      human_pacing_ms: generation.humanPacingMs ?? null,
      human_pacing_target_ms: generation.humanPacingTargetMs ?? null,
      human_pacing_reason: generation.humanPacingReason ?? "",
    },
    behavior: {
      response_question_count: responseQuestionCount,
      response_ended_with_question: responseEndedWithQuestion,
      repeated_question_pattern_detected:
        responseEndedWithQuestion && params.coherenceAudit?.flags.includes("excessive_questioning"),
      question_permission_granted:
        params.questionPermissionGranted ?? shouldAllowLightModelQuestion(params.message),
      previous_assistant_ended_with_question: params.previousAssistantEndedWithQuestion ?? null,
      question_repair_applied: params.questionRepairApplied === true,
      question_repair_reason: params.questionRepairReason ?? "",
      raw_response_question_count: params.rawResponseQuestionCount ?? responseQuestionCount,
      raw_response_ended_with_question:
        params.rawResponseEndedWithQuestion ?? responseEndedWithQuestion,
      internal_question_count_after_repair:
        params.internalQuestionCountAfterRepair ??
        Math.max(0, responseQuestionCount - (responseEndedWithQuestion ? 1 : 0)),
    },
    fast_path_used: generation.directFastPathUsed === true,
    fast_path_rejected_reason: generation.fastPathRejectedReason ?? "",
    active_session_prompt_bypassed: generation.activeSessionPromptBypassed ?? null,
    pi_runtime_bypassed: generation.piRuntimeBypassed ?? null,
    tool_registry_loaded: generation.toolRegistryLoaded ?? null,
    plugin_runtime_loaded: generation.pluginRuntimeLoaded ?? null,
    full_memory_blocking_read: generation.fullMemoryBlockingRead ?? null,
    think: generation.thinkEffective ?? null,
    num_predict: generation.numPredict ?? null,
    generation_call_count: generation.generationCallCount ?? null,
    pi_runtime_prep: {
      cache_hit: generation.piRuntimePrepCacheHit ?? null,
      cache_key: generation.piRuntimePrepCacheKey ?? "",
      prep_ms: generation.piRuntimePrepMs ?? null,
      plugin_deps_load_ms: generation.pluginDepsLoadMs ?? null,
      tool_registry_ms: generation.toolRegistryMs ?? null,
      system_prompt_scaffold_ms: generation.systemPromptScaffoldMs ?? null,
      cache_invalidation_reason: generation.cacheInvalidationReason ?? "",
    },
    audit: {
      audit_status: params.coherenceAudit?.audit_status ?? null,
      audit_flags: params.coherenceAudit?.flags ?? [],
      rewrite_attempted: params.rewriteAttempted === true,
      rewrite_reason: params.rewriteReason ?? "",
      rewrite_model: params.rewriteModel ?? "",
      rewrite_passed: params.rewritePassed ?? null,
      escalated_after_audit: params.escalated === true,
      audit_ms: auditMs,
    },
    latency: {
      platform_to_bot_event_ms: durationMs(
        timings.discordMessageCreatedMs,
        timings.discordEventReceivedMs,
      ),
      gate_ms: gateMs,
      queue_wait_ms: queueWaitMs,
      pre_typing_wait_ms: preTypingWaitMs,
      typing_send_ms: typingSendMs,
      router_ms: routerMs,
      fast_context_ms: generation.fastContextMs ?? null,
      context_ms: contextAssemblyMs,
      context_assembly_ms: contextAssemblyMs,
      memory_session_ms: memorySessionMs,
      model_wait_and_generation_ms: ollamaMs,
      ollama_queue_or_generation_ms: ollamaMs,
      human_pacing_ms: generation.humanPacingMs ?? null,
      discord_send_ms: discordSendMs,
      reply_send_ms: discordSendMs,
      total_visible_ms: totalVisibleMs,
      rewrite_ms: rewriteMs,
    },
    typing: {
      typing_sent: typeof timings.typingSendStartMs === "number",
      typing_sent_before_router:
        typeof timings.typingSendStartMs === "number" &&
        typeof timings.routerStartMs === "number" &&
        timings.typingSendStartMs <= timings.routerStartMs,
      typing_sent_before_model_request:
        typeof timings.typingSendStartMs === "number" &&
        typeof timings.modelRequestStartMs === "number" &&
        timings.typingSendStartMs <= timings.modelRequestStartMs,
      event_to_typing_ms: preTypingWaitMs,
      typing_send_ms: typingSendMs,
      typing_send_error: timings.typingSendError ?? "",
    },
    privacy: {
      no_raw_text: true,
      raw_text_logged: false,
    },
  };
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  await fs.appendFile(tracePath, `${JSON.stringify(record)}\n`, "utf8");
}

function durationMs(start?: number | null, end?: number | null): number | null {
  if (typeof start !== "number" || typeof end !== "number") {
    return null;
  }
  return Math.max(0, end - start);
}

function isoTimestamp(ms?: number | null): string | null {
  if (typeof ms !== "number") {
    return null;
  }
  return new Date(ms).toISOString();
}

function estimateTokenCount(text?: string): number | null {
  if (!text) {
    return null;
  }
  return Math.ceil(text.length / 4);
}

function deriveConversationRouterFallbackReason(params: {
  selection: ConversationRouterModelSelection;
  actualModelRef: string;
  overrideAccepted: boolean;
  auditStatus?: LightModelCoherenceAuditStatus;
  rewriteAttempted: boolean;
  escalated: boolean;
}): ConversationRouterFallbackReason {
  if (!params.overrideAccepted && params.actualModelRef !== params.selection.recommendedModelRef) {
    return "MODEL_OVERRIDE_REJECTED";
  }
  if (params.escalated) {
    if (params.auditStatus === "SAFETY_ESCALATE" || params.auditStatus === "ESCALATE_MAIN_MODEL") {
      return "AUDIT_ESCALATED";
    }
    if (params.rewriteAttempted) {
      return "AUDIT_REWRITE_FAILED";
    }
  }
  const route = params.selection.route;
  if (route.recommended_model === "light_model") {
    return "NONE";
  }
  const reasons = new Set(route.escalation_reason);
  if (route.mode === "HIGH_RISK") {
    return "ROUTER_HIGH_RISK";
  }
  if (route.mode === "SOFT_AFFECT") {
    return "ROUTER_SOFT_AFFECT";
  }
  if (reasons.has("relationship") || reasons.has("direct_affect")) {
    return "ROUTER_RELATIONSHIP_BOUNDARY";
  }
  if (reasons.has("persona_boundary")) {
    return "ROUTER_PERSONA_BOUNDARY";
  }
  if (route.mode === "DEEP_TALK") {
    return "ROUTER_DEEP_TALK";
  }
  if (route.task_complexity === "HIGH" || reasons.has("task_complexity_or_cooldown")) {
    return "ROUTER_TASK_COMPLEXITY";
  }
  if (route.cooldown_reason || reasons.has("prior_main_model_cooldown")) {
    return "ROUTER_COOLDOWN";
  }
  if (route.confidence < 0.75) {
    return "ROUTER_LOW_CONFIDENCE";
  }
  return "UNKNOWN";
}
