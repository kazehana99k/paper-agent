// Paper Agent — Overleaf + local agent 一体化本地应用
// 左侧: 反向代理的 Overleaf (同源 iframe); 右侧: WebSocket ⇄ Codex / Claude Code / API / custom agent
// 同步: 拉取 = 下载项目 zip 解压到论文目录; 推送 = 走 Overleaf upload API 覆盖同名文件

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');
const { execFileSync, spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');
const projectContract = require('./lib/project-contract');
const localAuth = require('./lib/local-auth');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const RUNTIME_ROOT = path.join(ROOT, 'runtime');
const MODULES_ROOT = path.join(ROOT, 'modules');
const LEGACY_JAPANESE_RAG_ROOT = process.env.PAPER_AGENT_LEGACY_JSTYLE_ROOT || '';
const JAPANESE_RAG_ROOT = path.join(MODULES_ROOT, 'japanese-style-rag', 'project');
const JSTYLE_RUNTIME_ROOT = path.join(RUNTIME_ROOT, 'modules', 'japanese-style-rag');
const JSTYLE_DATA_ROOT = path.join(RUNTIME_ROOT, 'module-data', 'japanese-style-rag');
const PROJECTS_ROOT = path.join(ROOT, 'projects');
const DEFAULT_PUSH_PATHS = projectContract.PAPER_PUSH_PATHS;

const DEFAULT_CONFIG = {
  port: 8080,
  overleafUrl: 'http://127.0.0.1:80',
  paperDir: path.resolve(ROOT, '..'),
  projectName: '',
  email: '',
  password: '',
  pushPaths: DEFAULT_PUSH_PATHS,
  codexCmd: 'codex',
  agents: {},
  activeProjectId: 'workspace',
  projects: [],
};

const DEFAULT_AGENTS = {
  codex: {
    id: 'codex',
    type: 'codex',
    label: 'Codex',
    command: 'codex',
    model: '',
  },
  claude: {
    id: 'claude',
    type: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    model: '',
    permissionMode: 'bypassPermissions',
  },
  api: {
    id: 'api',
    type: 'openai-compatible',
    label: 'API 助手',
    baseUrl: 'http://localhost:8000/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  custom: {
    id: 'custom',
    type: 'custom-cli',
    label: '自定义命令',
    command: '',
    args: '',
    promptMode: 'stdin',
  },
};

const FALLBACK_MODEL_OPTIONS = {
  claude: ['sonnet', 'opus', 'fable'],
  custom: [],
};

const JSTYLE_FLOW_IDS = ['jstyleStatus', 'jstyleMaterial', 'jstyleGenerate', 'jstyleIndex', 'jstyleGuard'];

const DEFAULT_FLOW_PROMPTS = {
  brainstorm: {
    label: '构思',
    title: '论文构思',
    argLabel: '构思主题 / 问题',
    defaultArg: '当前论文的核心故事和贡献边界',
    prompt: '请使用 paper-agent-brainstorm 模块，为当前项目做构思。主题：{{target}}。先读当前项目的 AGENTS.md 和 .paper-agent/project.json；若项目规则包含专属红线或评分要求，必须保留；若使用日语报告助手，必须遵守 style_corpus 只做风格、source_corpus 才支撑事实。请输出并保存 work/brainstorm/project_context.md、claim_map.md、outline.md、next_actions.md。不要编造实验结果、引用或数据。',
  },
  polish: {
    label: '润色',
    title: '中文润色',
    argLabel: '润色范围',
    defaultArg: 'Introduction',
    prompt: '请使用 research-writing-skill 和 writing-core，对 main.tex 的「{{target}}」做中文论文润色。\n\n流程：先拉取 Overleaf（只运行下一行命令，不要带说明文字）：\n{{paperAgentPullCommand}}\n\n然后读取本项目 AGENTS.md 和 .paper-agent/project.json；如果本项目有 docs/terminology.md 再读取它。保留公式、数字、引用、表格数据和项目红线；重点去翻译腔、AI 腔和超长句，但不要过度压缩论证；改完优先运行 node tools/compile.mjs 和 node tools/lint.mjs，若项目没有这些工具再按项目说明选择可用命令；最后给出修改摘要，等待我确认后再 push。',
  },
  translate: {
    label: '翻译',
    title: '英文翻译',
    argLabel: '翻译范围',
    defaultArg: 'Introduction',
    prompt: '请把 main.tex 的「{{target}}」翻译成英文顶会/顶刊论文写法。使用 research-writing-skill；先读 docs/terminology.md，公式、引用 key、\\ref{}、数字原样保留，AGENTS.md 中的复现进行中、AU 开放项、跨论文数字不可严格对比等限定必须逐条保留。输出中英对照到 work/translation/，不要直接覆盖 main.tex，完成后说明文件路径。',
  },
  review: {
    label: '审稿',
    title: '项目审查',
    argLabel: '审查重点 / 模式',
    defaultArg: 'full',
    prompt: '请按 {{target}} 模式审查当前项目的 main.tex。重要：不要默认套用其他项目规则或不匹配的论文审稿标准；先根据项目内容判断文档类型。当前项目类型提示：{{reviewProfile}}。\n\n{{reviewInstructions}}\n\n当前模块资料位置：\n{{jstyleModuleContext}}\n\n通用流程：\n1. 先拉取 Overleaf 最新版（只运行下一行命令）：\n{{paperAgentPullCommand}}\n2. 读取 main.tex、本项目 AGENTS.md 和 .paper-agent/project.json。\n3. 如果项目启用了 Japanese Style RAG，先查看资料状态（只运行下一行命令）：\n{{jstyleStatusCommand}}\n4. 再读取 processed source chunks 和必要的 raw/meta 文件。\n\n注意：status API 只列资料状态，不等于正文内容；正文内容在 processed source chunks。不要把 report_template 当事实来源。只审查当前项目，不跨项目拿上下文。把结果保存到 {{reviewOutputPath}}，并在聊天中输出：判定、主要问题、按优先级排序的修改路线图。',
  },
  reportPolish: {
    label: '日语润色',
    title: '日语报告润色',
    argLabel: '润色范围',
    defaultArg: '全文',
    prompt: '请按日本語の授業レポート标准润色当前 main.tex 的「{{target}}」。当前项目类型提示：{{reviewProfile}}。\n\n要求：先拉取 Overleaf 最新版（只运行下一行命令）：\n{{paperAgentPullCommand}}\n\n然后读取 main.tex、本项目 AGENTS.md、以及 Japanese Style RAG 的 processed source chunks。只改日语表达、结构清晰度、符号一致性和 LaTeX 小问题；不得改写成研究论文，不得套其他论文项目或顶会审稿标准，不得把 report_template 当事实来源。若涉及课程事实、定理、定义，必须以 course_slide/course_handout/lecture_note/book 为依据。改完运行可用的编译/检查命令；如果当前项目没有这些工具，明确说明未运行。',
  },
  citecheck: {
    label: '引文',
    title: '引文核验',
    argLabel: '',
    defaultArg: '',
    prompt: '请使用 source-command-citecheck 做当前项目的引文完整性检查。若项目内存在 tools/citecheck.py，可运行 tools/citecheck.py --online；若不存在，改为手动核对 main.tex 的 \\cite、references.bib 元数据和正文声称，并明确说明未运行在线脚本。不要编造 DOI、venue 或论文结论。修复后优先运行 node tools/compile.mjs；若项目没有该工具，再按项目说明选择可用编译命令。',
  },
  compile: {
    label: '编译',
    title: '编译检查',
    argLabel: '',
    defaultArg: '',
    prompt: '请执行当前项目的 LaTeX 编译与质量检查。\n\n{{compileInstructions}}\n\n若有 overfull hbox、引用未定义或图表排版风险，说明具体位置；不要改动与编译无关的正文。',
  },
  ruleAudit: {
    label: '规则',
    title: '规则审核',
    argLabel: '',
    defaultArg: '',
    prompt: '请使用 paper-agent-audit skill，只审核当前项目目录内与本次任务相关的改动是否遵守项目 AGENTS.md、相关 skill 规则、用户最新命令和 Paper Agent 项目边界。禁止修改文件、禁止 push。不要读取或评价父级仓库的无关日志、论文历史、配置和旧项目文件。请运行 git status --short -- .、git diff --stat -- .、git diff -- .，然后按“通过/不通过、阻塞问题、建议修复”输出。',
  },
  jstyleGenerate: {
    label: '日语生成',
    title: '日语报告草稿',
    argLabel: 'レポート題目',
    defaultArg: 'SNSが若者のコミュニケーションに与える影響',
    prompt: '通过 Paper Agent 的日语报告助手生成日语报告草稿。题目：{{target}}。必须使用任务模板、参考资料、风格资料、出处检查和相似风险检查；style corpus 只能提供抽象文体，不得支撑事实。',
  },
  jstyleMaterial: {
    label: '日语资料',
    title: '导入日语报告资料',
    argLabel: '资料文件绝对路径',
    defaultArg: '',
    prompt: '通过 Paper Agent 的日语报告助手导入资料：{{target}}。资料必须标注为作业要求、课堂 PPT、讲义/笔记、课程资料、教材、学术论文、公开报告或我的笔记。不要导入未授权材料。',
  },
  jstyleStatus: {
    label: '日语状态',
    title: '日语报告助手状态',
    argLabel: '',
    defaultArg: '',
    prompt: '显示 Paper Agent 日语报告助手状态，包括资料分类计数、任务模板和最近输出。',
  },
  jstyleIndex: {
    label: '整理资料',
    title: '整理日语报告资料',
    argLabel: '',
    defaultArg: '',
    prompt: '通过 Paper Agent 的日语报告助手整理已导入资料：准备任务模板、整理风格资料、整理参考资料、分类资料信息。不要自动爬取或导入未经授权材料。',
  },
  jstyleGuard: {
    label: '检查草稿',
    title: '检查日语报告草稿',
    argLabel: '',
    defaultArg: '',
    prompt: '通过 Paper Agent 的日语报告助手检查最近草稿：是否存在无来源事实、风格资料原句泄漏、引用伪造或相似度过高风险。',
  },
};

const DEFAULT_SKILL_PROMPTS = {
  projectAgent: `# Paper Agent Project Boundary

Use when an AI agent is launched by Paper Agent for this project.

- Treat this project profile as the active boundary: {{projectLabel}} ({{projectId}}).
- Work primarily inside {{paperDir}}.
- Do not import context, task assumptions, prompts, or generated files from other Paper Agent projects unless the user explicitly asks.
- Read .paper-agent/project.json and the AGENTS.md that belongs to the active project before making non-trivial edits.
- Current document profile: {{reviewProfile}}. If repository-level AGENTS.md conflicts with the active project profile, treat the conflicting repository text as background only. Do not apply unrelated paper claims, benchmark rules, course rubrics, or domain assumptions unless the active project document explicitly asks for them.
- If a task belongs to another project profile, tell the user to switch projects through Paper Agent instead of silently crossing the boundary.
- Prefer project-local skills and instructions over global habits.
- Paper Agent API calls from this spawned agent must use the project-local Node helper. It reads $PAPER_AGENT_API_BASE, $PAPER_AGENT_TOKEN, and the active project id:
  - Pull example:
    {{paperAgentPullCommand}}
  - Module status example:
    {{jstyleStatusCommand}}
- Never call http://localhost:8080/__agent/api/* or http://127.0.0.1:8080/__agent/api/* manually without the token. If PAPER_AGENT_TOKEN is missing, report that Paper Agent did not provide the local runtime token instead of guessing.

{{moduleContext}}`,
  audit: `# Paper Agent Audit Skill

Use when the prompt asks for Paper Agent rule audit, post-diff audit, or skill compliance review.

You are an auditor, not an editor.

- Do not modify files.
- Do not run push/deploy commands.
- Read only the active project's .paper-agent/project.json, AGENTS.md, and relevant local skill instructions before judging compliance.
- Inspect git status and diffs scoped to the active project directory or explicit files from the user request.
- Ignore parent-repository logs, old paper reviews, unrelated configuration, and generated files outside the active project boundary unless the user explicitly asks to audit them.
- Check whether the change obeys the user's latest command, project boundaries, writing/citation rules, and frontend/backend implementation constraints.
- For code changes, check that behavior, UI, and verification match the requested workflow.
- Output only: pass/fail, blocking issues, non-blocking concerns, and concrete next repair steps.`,
  brainstorm: `# Paper Agent Brainstorm

Use before drafting when the project idea, paper story, claims, section plan, or module integration plan is still under-specified.

Output durable planning artifacts under work/brainstorm/ unless the user asks for chat-only output:
- project_context.md
- claim_map.md
- outline.md
- next_actions.md

Workflow:
1. Read AGENTS.md and active project/module rules.
2. Separate known facts, user assumptions, model inferences, and open questions.
3. Name the central contribution in 2-4 words.
4. Build claims around evidence and missing evidence.
5. Preserve honesty constraints. Do not invent metrics, citations, baselines, source claims, or publication facts.
6. For the Japanese report assistant, style_corpus is style-only and source_corpus is the only factual grounding.

When the idea is vague, use this question spine:
- What is the concrete phenomenon or failure case?
- What does the baseline explanation get wrong?
- What is the smallest interesting claim?
- What evidence already exists?
- What evidence is missing but feasible?
- What reviewer objection is strongest?
- Which negative result should stay in the story?`,
};

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function moduleManifests() {
  if (!fs.existsSync(MODULES_ROOT)) return [];
  return fs.readdirSync(MODULES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(MODULES_ROOT, entry.name);
      const manifest = readJson(path.join(dir, 'module.json'), null);
      if (!manifest) return null;
      return {
        ...manifest,
        dir,
        projectDir: manifest.projectDir ? path.join(dir, manifest.projectDir) : undefined,
      };
    })
    .filter(Boolean);
}

function safeProjectId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';
}

function resolveLocalPath(value, base = ROOT) {
  if (!value) return value;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

function orderedUnique(preferred, existing = []) {
  const out = [];
  for (const item of [...preferred, ...existing]) {
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

function normalizeProjectKind(value, fallback = 'paper') {
  const text = String(value || '').trim().toLowerCase();
  if (['paper', 'report', 'module', 'generic'].includes(text)) return text;
  return fallback;
}

function inferProjectKind(project = {}, id = '') {
  if (project.kind) return normalizeProjectKind(project.kind);
  if (id === 'japanese-style-rag') return 'module';
  const label = `${project.label || ''} ${project.overleafProjectName || project.projectName || ''}`.toLowerCase();
  if (/report|レポート|课程报告|授業/.test(label)) return 'report';
  const promptSet = Array.isArray(project.promptSet) ? project.promptSet : [];
  if (promptSet.includes('polish') || promptSet.includes('translate') || promptSet.includes('citecheck')) return 'paper';
  return 'paper';
}

function defaultDocumentProfile(kind) {
  if (kind === 'report') return 'course_report_japanese';
  if (kind === 'paper') return 'auto';
  return 'generic_project';
}

function defaultWorkspaceProject(source = {}) {
  return {
    id: 'workspace',
    label: source.projectName || '写作项目',
    paperDir: source.paperDir || path.resolve(ROOT, '..'),
    overleafProjectName: source.projectName || '',
    kind: 'paper',
    documentProfile: 'auto',
    pushPaths: Array.isArray(source.pushPaths) ? source.pushPaths : DEFAULT_PUSH_PATHS,
    codexHome: path.join(RUNTIME_ROOT, 'codex-home', 'workspace'),
    agentProvider: source.agentProvider || 'codex',
    promptSet: ['brainstorm', 'polish', 'translate', 'review', 'citecheck', 'compile', 'ruleAudit'],
    modules: ['brainstorm', 'japanese-style-rag'],
    skills: ['paper-agent-brainstorm', 'research-writing-skill', 'writing-core', 'source-command-citecheck', 'paper-agent-audit'],
    prompts: {},
    skillPrompts: {},
    audit: { enabled: true, mode: 'post-diff' },
  };
}

function defaultJapaneseProject() {
  return {
    id: 'japanese-style-rag',
    label: '日语报告助手',
    paperDir: JAPANESE_RAG_ROOT,
    overleafProjectName: '',
    kind: 'module',
    documentProfile: 'generic_project',
    pushPaths: [],
    codexHome: path.join(RUNTIME_ROOT, 'codex-home', 'japanese-style-rag'),
    agentProvider: 'codex',
    promptSet: ['brainstorm', 'ruleAudit'],
    modules: ['brainstorm', 'japanese-style-rag'],
    skills: ['paper-agent-brainstorm', 'paper-agent-audit'],
    prompts: {},
    skillPrompts: {},
    audit: { enabled: true, mode: 'post-diff' },
    rag: {
      enabled: true,
      root: JAPANESE_RAG_ROOT,
      python: process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python',
      guardCommand: 'node tools/paper-agent-api.mjs jstyle-guard',
    },
  };
}

function normalizeProject(project = {}, index = 0) {
  const id = safeProjectId(project.id || project.label || `project-${index + 1}`);
  const kind = inferProjectKind(project, id);
  let pushPaths = Array.isArray(project.pushPaths)
    ? project.pushPaths
    : String(project.pushPaths || '')
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
  if (!pushPaths.length) pushPaths = projectContract.defaultPushPathsForKind(kind);
  let paperDir = resolveLocalPath(project.paperDir || DEFAULT_CONFIG.paperDir);
  const rag = { enabled: false, ...(project.rag || {}) };
  if (id === 'japanese-style-rag' && ((LEGACY_JAPANESE_RAG_ROOT && paperDir === LEGACY_JAPANESE_RAG_ROOT) || !fs.existsSync(paperDir))) {
    paperDir = JAPANESE_RAG_ROOT;
    rag.enabled = true;
    rag.root = JAPANESE_RAG_ROOT;
  }
  let promptSet = Array.isArray(project.promptSet) && project.promptSet.length
    ? [...project.promptSet]
    : projectContract.defaultPromptSetForKind(kind);
  let skills = Array.isArray(project.skills) ? [...project.skills] : [];
  let modules = Array.isArray(project.modules) ? [...project.modules] : projectContract.defaultModulesForKind(kind);
  if (kind === 'report') {
    promptSet = orderedUnique(projectContract.defaultPromptSetForKind('report'), promptSet.filter((flowId) => !['polish', 'translate', 'citecheck'].includes(flowId)));
    skills = orderedUnique(['paper-agent-project', 'paper-agent-brainstorm', 'paper-agent-audit'], skills);
    modules = orderedUnique(['brainstorm', 'japanese-style-rag'], modules);
  }
  if (id === 'japanese-style-rag') {
    promptSet = orderedUnique(['brainstorm', 'ruleAudit'], promptSet.filter((flowId) => !JSTYLE_FLOW_IDS.includes(flowId)));
    skills = orderedUnique(['paper-agent-brainstorm', 'paper-agent-audit'], skills.filter((skill) => skill !== 'japanese-style-rag'));
    modules = orderedUnique(['brainstorm', 'japanese-style-rag'], modules);
    pushPaths = [];
    rag.enabled = true;
    rag.root = LEGACY_JAPANESE_RAG_ROOT && rag.root === LEGACY_JAPANESE_RAG_ROOT ? JAPANESE_RAG_ROOT : (rag.root || JAPANESE_RAG_ROOT);
  }
  if (id !== 'japanese-style-rag' && kind !== 'report') modules = orderedUnique(['brainstorm'], modules);
  if (rag.root) rag.root = resolveLocalPath(rag.root);
  const isEmbeddedJstyleProfile = id.startsWith('japanese-style-rag') && path.resolve(paperDir) === path.resolve(JAPANESE_RAG_ROOT);
  return {
    ...project,
    id,
    label: project.label || id,
    paperDir,
    overleafProjectName: isEmbeddedJstyleProfile ? '' : (project.overleafProjectName ?? project.projectName ?? ''),
    overleafProjectId: isEmbeddedJstyleProfile ? '' : (project.overleafProjectId || ''),
    kind,
    documentProfile: project.documentProfile || defaultDocumentProfile(kind),
    pushPaths,
    codexHome: resolveLocalPath(project.codexHome || path.join(RUNTIME_ROOT, 'codex-home', id)),
    agentProvider: project.agentProvider || 'codex',
    promptSet,
    modules,
    skills,
    prompts: project.prompts && typeof project.prompts === 'object' ? project.prompts : {},
    skillPrompts: project.skillPrompts && typeof project.skillPrompts === 'object' ? project.skillPrompts : {},
    audit: { enabled: true, mode: 'post-diff', ...(project.audit || {}) },
    rag,
  };
}

function applyEffectiveProjectDefaults(project) {
  const profile = reviewProfileForProject(project);
  if (profile !== 'course_report_japanese') return project;
  const oldPaperPush = JSON.stringify(project.pushPaths || []) === JSON.stringify(DEFAULT_PUSH_PATHS);
  const hasLegacySingleTeaser = (project.pushPaths || []).some((item) => /^figures\/teaser[-_a-z0-9]*\.pdf$/i.test(String(item)));
  return {
    ...project,
    pushPaths: oldPaperPush || hasLegacySingleTeaser || !(project.pushPaths || []).length
      ? projectContract.defaultPushPathsForKind('report')
      : project.pushPaths,
    promptSet: projectContract.defaultPromptSetForKind('report'),
    modules: orderedUnique(['brainstorm', 'japanese-style-rag'], project.modules || []),
    skills: orderedUnique(['paper-agent-project', 'paper-agent-brainstorm', 'paper-agent-audit'], project.skills || []),
  };
}

function normalizeConfig(raw = {}) {
  const merged = { ...DEFAULT_CONFIG, ...raw };
  if (!merged.codexCmd || merged.codexCmd === 'claude') merged.codexCmd = DEFAULT_CONFIG.codexCmd;
  const rawAgents = merged.agents && typeof merged.agents === 'object' ? merged.agents : {};
  merged.agents = { ...rawAgents };
  for (const [id, defaults] of Object.entries(DEFAULT_AGENTS)) {
    merged.agents[id] = { ...defaults, ...(rawAgents[id] || {}) };
  }
  if (merged.agents.api?.label === 'API Agent') merged.agents.api.label = DEFAULT_AGENTS.api.label;
  if (merged.agents.custom?.label === 'Custom CLI') merged.agents.custom.label = DEFAULT_AGENTS.custom.label;
  merged.agents.codex = {
    ...DEFAULT_AGENTS.codex,
    ...(merged.agents.codex || {}),
    command: merged.agents.codex?.command || merged.codexCmd || DEFAULT_AGENTS.codex.command,
  };
  merged.codexCmd = merged.agents.codex.command || DEFAULT_CONFIG.codexCmd;
  delete merged.claudeCmd;

  let projects = Array.isArray(merged.projects) && merged.projects.length
    ? merged.projects
    : [defaultWorkspaceProject(merged)];

  merged.projects = projects.map(normalizeProject).map(applyEffectiveProjectDefaults);
  const dedupedProjects = [];
  const seenProfileKeys = new Map();
  let activeProjectRemap = '';
  const normalizedProjects = merged.projects;
  for (const project of normalizedProjects) {
    const isEmbeddedJstyleProfile = project.id.startsWith('japanese-style-rag') &&
      path.resolve(project.paperDir) === path.resolve(JAPANESE_RAG_ROOT);
    if (isEmbeddedJstyleProfile && normalizedProjects.length > 1) {
      if (merged.activeProjectId === project.id) activeProjectRemap = '';
      continue;
    }
    const profileKey = isEmbeddedJstyleProfile ? 'embedded:japanese-style-rag' : `id:${project.id}`;
    if (seenProfileKeys.has(profileKey)) {
      if (merged.activeProjectId === project.id) activeProjectRemap = seenProfileKeys.get(profileKey);
      continue;
    }
    seenProfileKeys.set(profileKey, project.id);
    dedupedProjects.push(project);
  }
  merged.projects = dedupedProjects;
  if (activeProjectRemap) merged.activeProjectId = activeProjectRemap;
  if (!merged.projects.some((p) => p.id === merged.activeProjectId)) {
    merged.activeProjectId = merged.projects[0]?.id || 'workspace';
  }

  const active = merged.projects.find((p) => p.id === merged.activeProjectId) || merged.projects[0];
  if (active) {
    merged.paperDir = active.paperDir;
    merged.projectName = active.overleafProjectName || '';
    merged.pushPaths = active.pushPaths;
  }
  return merged;
}

function loadConfig() {
  return normalizeConfig(readJson(CONFIG_PATH, {}));
}

function saveConfig(next) {
  const clean = normalizeConfig(next);
  delete clean.claudeCmd;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2), { mode: 0o600 });
  config = clean;
}

let config = loadConfig();

function currentProject() {
  return config.projects.find((p) => p.id === config.activeProjectId) || config.projects[0];
}

function projectById(id) {
  if (!id) return currentProject();
  return config.projects.find((p) => p.id === safeProjectId(id));
}

function updateActiveProject(patch) {
  const project = currentProject();
  if (!project) throw new Error('没有可用项目');
  const nextProject = normalizeProject({ ...project, ...patch, id: project.id });
  config.projects = config.projects.map((p) => (p.id === project.id ? nextProject : p));
  saveConfig(config);
  return currentProject();
}

function defaultPaperProjectFromOverleaf(name) {
  const id = safeProjectId(name);
  let overleafProjectId = '';
  try { overleafProjectId = oid(getProjectInfo(name)?._id) || ''; } catch {}
  return normalizeProject({
    id,
    label: name,
    paperDir: path.join(PROJECTS_ROOT, id),
    overleafProjectName: name,
    overleafProjectId,
    pushPaths: DEFAULT_PUSH_PATHS,
    codexHome: path.join(RUNTIME_ROOT, 'codex-home', id),
    agentProvider: currentProject()?.agentProvider || 'codex',
    promptSet: ['brainstorm', 'polish', 'translate', 'review', 'citecheck', 'compile', 'ruleAudit'],
    modules: ['brainstorm', 'japanese-style-rag'],
    skills: ['paper-agent-brainstorm', 'research-writing-skill', 'writing-core', 'source-command-citecheck', 'paper-agent-audit'],
    prompts: {},
    skillPrompts: {},
    audit: { enabled: true, mode: 'post-diff' },
  });
}

function sanitizeProject(project) {
  return {
    id: project.id,
    label: project.label,
    paperDir: project.paperDir,
    overleafProjectName: project.overleafProjectName || '',
    overleafProjectId: project.overleafProjectId || '',
    kind: effectiveProjectKind(project),
    configuredKind: project.kind || 'paper',
    documentProfile: reviewProfileForProject(project),
    configuredDocumentProfile: project.documentProfile || 'auto',
    pushPaths: project.pushPaths || [],
    agentProvider: project.agentProvider || 'codex',
    promptSet: project.promptSet || [],
    modules: project.modules || [],
    skills: project.skills || [],
    audit: project.audit || { enabled: true, mode: 'post-diff' },
    rag: project.rag || { enabled: false },
    hasOverleaf: !!project.overleafProjectName,
    hasPromptOverrides: !!Object.keys(project.prompts || {}).length,
    hasSkillOverrides: !!Object.keys(project.skillPrompts || {}).length,
  };
}

function sanitizeAgent(agent = {}) {
  const { apiKey, password, token, secret, ...safe } = agent || {};
  if (apiKey || password || token || secret) safe.hasSecret = true;
  return safe;
}

function sanitizeAgents(agents = {}) {
  return Object.fromEntries(Object.entries(agents || {}).map(([id, agent]) => [id, sanitizeAgent(agent)]));
}

function projectMarkerPayload(project) {
  return projectContract.projectMarkerPayload(project, effectiveProjectKind(project), reviewProfileForProject(project));
}

function scaffoldProjectFiles(project) {
  return projectContract.scaffoldProjectFiles(project, effectiveProjectKind(project), reviewProfileForProject(project));
}

function splitCommandLine(s) {
  const parts = [];
  let cur = '';
  let quote = null;
  let esc = false;
  for (const ch of String(s || '').trim()) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { parts.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function getCodexSpawn() {
  const parts = splitCommandLine(config.agents?.codex?.command || config.codexCmd || DEFAULT_CONFIG.codexCmd);
  if (!parts.length) return { cmd: DEFAULT_AGENTS.codex.command, args: [] };
  return { cmd: parts[0], args: parts.slice(1) };
}

function currentAgent(project = currentProject()) {
  const id = project?.agentProvider || 'codex';
  return {
    ...(DEFAULT_AGENTS[id] || {}),
    ...(config.agents?.[id] || {}),
    id,
  };
}

function mergeAgentConfig(id, value = {}) {
  return {
    ...(DEFAULT_AGENTS[id] || { id }),
    ...(config.agents?.[id] || {}),
    ...(value || {}),
    id,
  };
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function modelIdsFromCatalog(json) {
  const rows = Array.isArray(json) ? json : (json?.models || json?.data || []);
  return uniqueStrings(rows.map((item) => {
    if (typeof item === 'string') return item;
    return item.id || item.name || item.slug || item.model || '';
  }));
}

function renderCommandArgs(template, vars) {
  return splitCommandLine(renderTemplate(template || '', vars));
}

function portablePrompt(project, text) {
  const prompts = skillPromptsForProject(project);
  const parts = [
    renderTemplate(prompts.projectAgent || '', projectVars(project)),
    prompts.brainstorm && project.modules?.includes('brainstorm') ? renderTemplate(prompts.brainstorm, projectVars(project)) : '',
    '',
    '# User Task',
    text,
  ].filter(Boolean);
  return parts.join('\n\n');
}

function portableApiPrompt(project, text) {
  return [
    '# Project Boundary',
    `- Active project: ${project.label} (${project.id})`,
    `- Work root: ${displayPathForProject(project, project.paperDir)}`,
    '- Do not claim you ran commands, edited files, pulled/pushed Overleaf, or read files outside the Project Context.',
    '- If the provided context is insufficient, say exactly what is missing.',
    '',
    '# User Task',
    text,
  ].join('\n');
}

function readTextForPrompt(file, maxChars = 16000) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length <= maxChars) return text;
    const head = text.slice(0, Math.floor(maxChars * 0.65));
    const tail = text.slice(-Math.floor(maxChars * 0.25));
    return `${head}\n\n[... omitted ${text.length - head.length - tail.length} chars ...]\n\n${tail}`;
  } catch {
    return '';
  }
}

function candidateApiContextFiles(project, prompt) {
  const requested = String(prompt || '');
  const names = ['main.tex', 'AGENTS.md'];
  const addName = (name) => {
    if (!names.includes(name)) names.push(name);
  };
  for (const rel of project.pushPaths || []) {
    if (String(rel).endsWith('.tex') || String(rel).endsWith('.bib')) addName(rel);
  }
  if (/术语|terminology|notation/i.test(requested)) {
    addName('docs/terminology.md');
  }
  return names;
}

function keywordsForPrompt(text) {
  return uniqueStrings(String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_一-龥ぁ-んァ-ヶー]+/u)
    .filter((token) => token.length >= 2)
    .concat(
      /部分トレース|partial\s*trace/i.test(text) ? ['部分トレース', 'partial', 'trace'] : [],
      /極分解|polar/i.test(text) ? ['極分解', 'polar'] : [],
      /特異値分解|svd|singular/i.test(text) ? ['特異値分解', 'singular'] : [],
      /等距離|isometry/i.test(text) ? ['等距離', 'isometry'] : [],
      /ユニタリ|unitary/i.test(text) ? ['ユニタリ', 'unitary'] : [],
    ));
}

function jstyleSourceSnippetsForApi(project, prompt, maxChars = 3000) {
  if (!project.modules?.includes('japanese-style-rag')) return '';
  const chunksFile = path.join(jstyleDataRoot(project), 'data/source_corpus/processed/source_chunks.jsonl');
  if (!fs.existsSync(chunksFile)) return '';
  const includeTemplates = /模板|格式|文体|风格|style|template|レポート|report|日语|日本語/i.test(prompt);
  const keywords = keywordsForPrompt(prompt);
  const rows = [];
  try {
    for (const line of fs.readFileSync(chunksFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line);
      const type = chunk.module_material_type || chunk.source_type || '';
      const isTemplate = type === 'report_template' || chunk.citation_role === 'template_structure';
      if (isTemplate && !includeTemplates) continue;
      const text = String(chunk.text || '');
      let score = 0;
      if (type === 'course_handout') score += 20;
      if (type === 'course_slide') score += 12;
      if (type === 'lecture_note' || type === 'book') score += 8;
      if (isTemplate) score += 3;
      if (/課題|assignment|作业|要求/.test(text)) score += 8;
      for (const key of keywords) {
        if (key && text.toLowerCase().includes(String(key).toLowerCase())) score += 5;
      }
      if (score > 0) rows.push({ chunk, score, isTemplate });
    }
  } catch {
    return '';
  }
  rows.sort((a, b) => b.score - a.score);
  const lines = [
    '## Japanese Style RAG Source Snippets',
    'These excerpts are extracted from processed source chunks. report_template excerpts are format/style references only, not factual support.',
  ];
  let used = lines.join('\n').length;
  for (const { chunk, isTemplate } of rows.slice(0, 8)) {
    const label = [
      chunk.module_material_label || chunk.module_material_type || chunk.source_type || 'source',
      chunk.source_file,
      chunk.page ? `p.${chunk.page}` : '',
      isTemplate ? 'FORMAT ONLY' : 'FACTUAL/COURSE SOURCE',
    ].filter(Boolean).join(' · ');
    const cap = isTemplate ? 360 : 560;
    const text = String(chunk.text || '').replace(/\s+/g, ' ').slice(0, cap);
    const block = `\n\n### ${label}\n${text}`;
    if (used + block.length > maxChars) break;
    lines.push(block);
    used += block.length;
  }
  return lines.length > 2 ? lines.join('\n') : '';
}

function apiProjectContext(project, prompt) {
  const profile = reviewProfileForProject(project);
  const maxTotal = 9500;
  const parts = [
    `# Project Context`,
    `Project: ${project.label} (${project.id})`,
    `Document profile: ${profile}`,
    `Root: ${displayPathForProject(project, project.paperDir)}`,
    project.overleafProjectName ? `Overleaf: ${project.overleafProjectName}` : '',
    profile === 'course_report_japanese'
      ? 'Important: current content is a Japanese course report. Do not apply unrelated paper-review criteria unless the document explicitly asks for them.'
      : '',
    '',
    'The API assistant receives only the context below. It cannot run shell commands, read additional files, edit files, or inspect Overleaf unless those capabilities are explicitly added by Paper Agent.',
  ].filter(Boolean);
  let used = parts.join('\n').length;
  const wantsJstyle = /japanese|jstyle|日语|日本語|レポート|資料|rag|课件|講義|授業/i.test(prompt);
  if (project.modules?.includes('japanese-style-rag') && (shouldAttachJstyleContext(project) || wantsJstyle)) {
    const moduleBlock = `\n\n## Enabled Module Paths\n${moduleContextForProject(project)}`;
    parts.push(moduleBlock);
    used += moduleBlock.length;
    const snippets = jstyleSourceSnippetsForApi(project, prompt);
    if (snippets) {
      parts.push(`\n\n${snippets}`);
      used += snippets.length;
    }
  }
  for (const rel of candidateApiContextFiles(project, prompt)) {
    const abs = path.resolve(project.paperDir, rel);
    if (!abs.startsWith(path.resolve(project.paperDir) + path.sep) && abs !== path.resolve(project.paperDir)) continue;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const remaining = maxTotal - used - 400;
    if (remaining <= 800) break;
    const fileCap = rel === 'main.tex' ? 4200 : 1600;
    const text = readTextForPrompt(abs, Math.min(fileCap, remaining));
    if (!text.trim()) continue;
    const block = `\n\n## File: ${rel}\n\`\`\`\n${text}\n\`\`\``;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n');
}

function apiSystemPrompt(project, agent) {
  return [
    `你是 ${agent.label || 'API assistant'}，运行在 Paper Agent 里。当前项目是 ${project.label}，目录是 ${displayPathForProject(project, project.paperDir)}。`,
    '你是 OpenAI-compatible API 文本助手，不是 Codex/Claude Code 这类可执行工具 agent。',
    '你不能真实运行命令、读取未提供的文件、修改文件、推送 Overleaf，除非 Paper Agent 在消息中提供了对应内容。',
    '回答必须基于用户任务和随请求附带的 Project Context；如果上下文不足，要直接说明缺少哪份文件/哪段内容。',
    '中文回答优先，除非用户要求其他语言。检查日语/レポート时，用中文说明问题，用日语给出修改例。',
    '不要使用 Markdown 表格；终端面板里表格很难阅读。请用短标题、编号列表、项目符号和“原文/问题/建议/改写例”的格式。',
    '保持简洁，不要输出通用教学清单；优先给当前文本中具体可改的句子和理由。',
  ].join('\n');
}

function normalizeApiAgentText(text) {
  return normalizeAgentTextForTerminal(text).trim();
}

function renderTemplate(template, vars = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    if (vars[key] === undefined || vars[key] === null) return '';
    return String(vars[key]);
  });
}

function readProjectTextSample(project, rel = 'main.tex', maxChars = 12000) {
  try {
    const file = path.resolve(project.paperDir, rel);
    const root = path.resolve(project.paperDir);
    if (!file.startsWith(root + path.sep) && file !== root) return '';
    return fs.readFileSync(file, 'utf8').slice(0, maxChars);
  } catch {
    return '';
  }
}

function reviewProfileForProject(project) {
  if (project?.documentProfile && project.documentProfile !== 'auto') return project.documentProfile;
  const mainTex = readProjectTextSample(project, 'main.tex');
  const haystack = `${project.id}\n${project.label}\n${project.overleafProjectName || ''}\n${mainTex}`;
  const looksJapaneseReport = /レポート|課題|講義|授業|course_slide|course_handout/.test(haystack);
  if (looksJapaneseReport) return 'course_report_japanese';
  if (/abstract|introduction|method|experiment|related work|\\bibliography|\\cite/i.test(haystack)) return 'research_paper';
  if (/\\documentclass|\\section|\\cite|references\.bib/i.test(haystack)) return 'latex_document';
  return 'generic_project';
}

function reviewInstructionsForProfile(profile) {
  if (profile === 'research_paper') {
    return [
      '按通用研究论文审查，而不是课程报告审查。',
      '重点检查：研究问题是否清楚、贡献是否可证、方法与实验是否支撑主张、相关工作与引用是否准确、限制是否诚实。',
      '不要套用其他项目的专属红线、实验数字、审稿标准或术语体系，除非当前项目 AGENTS.md/main.tex 明确要求。',
      '输出应包含总体判定、主要风险、需要补充的证据/实验/引用、修改路线图。',
    ].join('\n');
  }
  if (profile === 'course_report_japanese') {
    return [
      '按课程报告 / 日本語レポート审查，而不是按不相关的研究论文标准审稿。',
      '重点检查：是否逐条回答作业题目；是否依据课程 PPT/讲义/作业要求；数学定义、定理陈述、符号和推导是否准确；旧 report 是否只作为格式模板而非事实来源。',
      '日语层面检查：です・ます調/である調是否混用；术语是否统一；段落是否像レポート；是否存在中文直译腔；是否有不自然或过度口语表达。',
      'LaTeX 层面检查：标题、作者、学籍、页眉页脚、公式环境、数学符号、字体、编译风险、overfull hbox。',
      '如果资料不足，列出缺少的 PPT 页、题目要求或来源；不要编造课程内容。',
      '输出用中文说明问题，必要时给日语改写例。不要提无关项目、无关会议标准或无关实验术语，除非正文真的涉及这些内容。',
    ].join('\n');
  }
  if (profile === 'latex_document') {
    return [
      '按通用 LaTeX 文档审查。',
      '重点检查：结构是否完整，主张是否被当前文档材料支撑，术语是否一致，引用/公式/图表/编译是否存在风险。',
      '不要使用其他项目的专属审稿项；只有正文明确涉及相关内容时才讨论。',
    ].join('\n');
  }
  return [
    '按通用项目审查。',
    '先说明你根据哪些文件判断项目类型；若无法判断，先做边界和资料完整性检查。',
    '不要套用其他项目、论文审稿或日语报告模板，除非当前项目内容明确需要。',
  ].join('\n');
}

function reviewOutputPathForProfile(profile, date) {
  if (profile === 'course_report_japanese') return `reviews/report-review-${date}.md`;
  if (profile === 'research_paper') return `reviews/research-review-${date}.md`;
  return `reviews/project-review-${date}.md`;
}

function compileInstructionsForProfile(profile) {
  if (profile === 'course_report_japanese') {
    return [
      '课程报告项目不要假设存在论文仓库工具。',
      '先检查 main.tex 是否存在。',
      '优先运行 node tools/compile.mjs；这是 Paper Agent 项目内置的跨平台编译入口。',
      '然后运行 node tools/lint.mjs；如果脚本报告缺少本机 LaTeX/chktex，只说明依赖缺失，不要改用父级仓库脚本。',
      '只有当前项目目录内明确存在 tools/compile.sh、tools/lint.py 或 Makefile 时，才可以使用这些项目自带命令。',
      '不要调用父目录或其他项目的 tools/compile.sh、tools/lint.py、main.log。',
      '编译失败时读取当前项目的 build/main.log 或命令输出，再做最小修复。',
    ].join('\n');
  }
  if (profile === 'research_paper') {
    return [
      '研究论文项目优先使用项目自带工具。',
      '如果 tools/compile.mjs 存在，先运行 node tools/compile.mjs；否则再按项目 README/Makefile/tools/compile.sh 选择命令。',
      '如果 tools/lint.mjs 存在，编译后运行 node tools/lint.mjs；否则再运行项目内已有的 tools/lint.py。',
      '不要调用父目录或其他项目的编译、lint、日志文件。',
      '如果没有项目自带工具，则回退到 latexmk 或 xelatex/pdflatex，具体取决于 main.tex 的引擎注释和宏包需求。',
    ].join('\n');
  }
  return [
    '先检查项目中是否有 tools/compile.mjs、tools/lint.mjs、Makefile、latexmkrc、tools/compile.sh 或 README 编译说明。',
    '优先使用项目自带命令；没有时再尝试 latexmk 或 xelatex/pdflatex。',
    '不要调用不存在的工具，也不要调用父目录或其他项目的脚本。',
    '无法编译时说明缺少的命令或依赖。',
  ].join('\n');
}

function effectiveProjectKind(project) {
  const profile = reviewProfileForProject(project);
  if (profile === 'course_report_japanese') return 'report';
  if (profile === 'research_paper') return 'paper';
  return project.kind || 'generic';
}

function shouldAttachJstyleContext(project) {
  if (!project.modules?.includes('japanese-style-rag')) return false;
  const profile = reviewProfileForProject(project);
  return profile === 'course_report_japanese' || project.kind === 'report';
}

function paperAgentApiBase() {
  return `http://127.0.0.1:${config.port}/__agent/api`;
}

function paperAgentApiJson(project, extra = {}) {
  return JSON.stringify({ projectId: project.id, ...extra });
}

function paperAgentCurl(project, method, endpoint, body = {}) {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const actionByEndpoint = {
    '/pull': 'pull',
    '/push': 'push',
    '/jstyle/status': 'jstyle-status',
    '/jstyle/index': 'jstyle-index',
    '/jstyle/guard': 'jstyle-guard',
    '/jstyle/outputs/latest': 'jstyle-latest',
  };
  const action = actionByEndpoint[normalizedEndpoint];
  if (action && (!body || !Object.keys(body).length)) return `node tools/paper-agent-api.mjs ${action}`;
  const payload = paperAgentApiJson(project, body).replace(/'/g, "'\\''");
  const endpointArg = action || normalizedEndpoint;
  return `node tools/paper-agent-api.mjs ${endpointArg} '${payload}'`;
}

function toPromptPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function isInsidePath(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function displayPathForProject(project, target) {
  const abs = path.resolve(target || '.');
  if (project?.paperDir && isInsidePath(project.paperDir, abs)) {
    const rel = path.relative(path.resolve(project.paperDir), abs);
    return rel ? `<project>/${toPromptPath(rel)}` : '<project>';
  }
  if (isInsidePath(ROOT, abs)) {
    const rel = path.relative(ROOT, abs);
    return rel ? `<paper-agent>/${toPromptPath(rel)}` : '<paper-agent>';
  }
  if (isInsidePath(os.homedir(), abs)) {
    const rel = path.relative(os.homedir(), abs);
    return rel ? `~/${toPromptPath(rel)}` : '~';
  }
  return `<external>/${path.basename(abs)}`;
}

function moduleContextForProject(project) {
  const lines = ['# Paper Agent Modules'];
  if (project.modules?.includes('japanese-style-rag')) {
    if (!shouldAttachJstyleContext(project)) {
      lines.push(
        'Japanese Style RAG is available for this project but is not active for the current document profile.',
        'Use it only when the user explicitly asks for Japanese report/RAG/material-library work.',
      );
      return lines.join('\n');
    }
    const root = jstyleDataRoot(project);
    lines.push(
      'Japanese Style RAG is enabled for this project.',
      `- Module source code: ${displayPathForProject(project, JAPANESE_RAG_ROOT)}`,
      `- Project module data root: ${displayPathForProject(project, root)}`,
      `- Raw materials: ${displayPathForProject(project, path.join(root, 'data/source_corpus/raw'))}`,
      `- Processed source chunks: ${displayPathForProject(project, path.join(root, 'data/source_corpus/processed/source_chunks.jsonl'))}`,
      `- Source vector index: ${displayPathForProject(project, path.join(root, 'data/source_corpus/index/source_vectors.jsonl'))}`,
      `- Generated outputs: ${displayPathForProject(project, path.join(root, 'data/outputs'))}`,
      `- Status command: ${paperAgentCurl(project, 'POST', '/jstyle/status')}`,
      `- Rebuild index command: ${paperAgentCurl(project, 'POST', '/jstyle/index')}`,
      '- Use tools/paper-agent-api.mjs for Paper Agent API calls; it reads $PAPER_AGENT_TOKEN and the current project id.',
      'Use <project>/.paper-agent/modules/japanese-style-rag/data/source_corpus/processed/source_chunks.jsonl when you need readable extracted text.',
      'Use <project>/.paper-agent/modules/japanese-style-rag/data/source_corpus/raw for original PDFs/TXT and their .meta.json sidecars.',
      'Treat report_template files as format/style references only; do not use them as factual support.',
      'Use course_slide, course_handout, lecture_note, book, academic_paper, and public_report chunks as factual/course support according to metadata.',
    );
  } else {
    lines.push('No Japanese Style RAG module is enabled for this project.');
  }
  return lines.join('\n');
}

function localDateString() {
  const timezone = process.env.TZ || 'Asia/Tokyo';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function projectVars(project, extra = {}) {
  const date = localDateString();
  const reviewProfile = reviewProfileForProject(project);
  const moduleContext = moduleContextForProject(project);
  return {
    date,
    projectId: project.id,
    projectLabel: project.label,
    projectKind: effectiveProjectKind(project),
    paperDir: displayPathForProject(project, project.paperDir),
    paperDirAbs: project.paperDir,
    overleafProjectName: project.overleafProjectName || '',
    moduleContext,
    jstyleModuleContext: moduleContext,
    reviewProfile,
    reviewInstructions: reviewInstructionsForProfile(reviewProfile),
    reviewOutputPath: reviewOutputPathForProfile(reviewProfile, date),
    compileInstructions: compileInstructionsForProfile(reviewProfile),
    paperAgentApiBase: paperAgentApiBase(),
    paperAgentAuthHeader: 'x-paper-agent-token: $PAPER_AGENT_TOKEN',
    paperAgentPullCommand: paperAgentCurl(project, 'POST', '/pull'),
    paperAgentPushCommand: paperAgentCurl(project, 'POST', '/push'),
    jstyleStatusCommand: paperAgentCurl(project, 'POST', '/jstyle/status'),
    jstyleIndexCommand: paperAgentCurl(project, 'POST', '/jstyle/index'),
    ...extra,
  };
}

function flowsForProject(project) {
  const profile = reviewProfileForProject(project);
  let ids = Array.isArray(project.promptSet) ? [...project.promptSet] : [];
  if (profile === 'course_report_japanese') {
    ids = orderedUnique(
      ['brainstorm', 'reportPolish', 'review', 'compile', 'ruleAudit'],
      ids.filter((id) => ['brainstorm', 'reportPolish', 'review', 'compile', 'ruleAudit'].includes(id)),
    );
  } else if (profile === 'research_paper') {
    ids = orderedUnique(['brainstorm', 'polish', 'translate', 'review', 'citecheck', 'compile', 'ruleAudit'], ids);
  }
  return ids
    .map((id) => {
      const base = DEFAULT_FLOW_PROMPTS[id];
      if (!base) return null;
      return { id, ...base, prompt: project.prompts?.[id] || base.prompt };
    })
    .filter(Boolean);
}

function skillPromptsForProject(project) {
  const prompts = {
    projectAgent: project.skillPrompts?.projectAgent || DEFAULT_SKILL_PROMPTS.projectAgent,
    audit: project.skillPrompts?.audit || DEFAULT_SKILL_PROMPTS.audit,
  };
  if (project.modules?.includes('brainstorm') || project.skills?.includes('paper-agent-brainstorm')) {
    prompts.brainstorm = project.skillPrompts?.brainstorm || DEFAULT_SKILL_PROMPTS.brainstorm;
  }
  return prompts;
}

function writeIfChanged(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function skillMarkdown(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${String(body || '').trim()}\n`;
}

function linkOrCopy(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.symlinkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
    try { fs.chmodSync(dst, 0o600); } catch {}
  }
}

function ensureProjectCodexHome(project) {
  const home = path.resolve(project.codexHome || path.join(RUNTIME_ROOT, 'codex-home', project.id));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const globalHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  linkOrCopy(path.join(globalHome, 'auth.json'), path.join(home, 'auth.json'));
  linkOrCopy(path.join(globalHome, 'installation_id'), path.join(home, 'installation_id'));

  const skillsRoot = path.join(home, 'skills');
  const vars = projectVars(project);
  const skillPrompts = skillPromptsForProject(project);
  writeIfChanged(
    path.join(skillsRoot, 'paper-agent-project', 'SKILL.md'),
    skillMarkdown(
      'paper-agent-project',
      'Project-boundary guard for Paper Agent runs. Use when an agent is launched inside Paper Agent, switches project profiles, or needs to avoid cross-project context contamination.',
      renderTemplate(skillPrompts.projectAgent, vars),
    ),
  );
  writeIfChanged(
    path.join(skillsRoot, 'paper-agent-audit', 'SKILL.md'),
    skillMarkdown(
      'paper-agent-audit',
      'Audit Paper Agent changes against AGENTS.md, local skill rules, project boundaries, user instructions, and post-diff compliance. Use when asked for rule audit or after automated file changes.',
      renderTemplate(skillPrompts.audit, vars),
    ),
  );
  if (skillPrompts.brainstorm) {
    writeIfChanged(
      path.join(skillsRoot, 'paper-agent-brainstorm', 'SKILL.md'),
      skillMarkdown(
        'paper-agent-brainstorm',
        'Research planning and brainstorming module for Paper Agent. Use when clarifying paper ideas, claims, contribution names, project context, outlines, reviewer objections, or next writing actions.',
        renderTemplate(skillPrompts.brainstorm, vars),
      ),
    );
  }
  return home;
}

// ---------- Overleaf API 客户端 (cookie jar + csrf) ----------
const jar = new Map(); // name -> value
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of sc) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
async function olFetch(p, opts = {}) {
  const res = await fetch(config.overleafUrl + p, {
    redirect: 'manual',
    ...opts,
    headers: { cookie: cookieHeader(), ...(opts.headers || {}) },
  });
  storeCookies(res);
  return res;
}
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
function copyOverleafResponseHeaders(upstream, res) {
  for (const [key, value] of upstream.headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'x-frame-options' || lower === 'content-security-policy') continue;
    res.setHeader(key, value);
  }
}
function shouldRetryDownloadWithServerLogin(upstream) {
  const loc = upstream.headers.get('location') || '';
  return upstream.status === 401 || upstream.status === 403 || (upstream.status >= 300 && upstream.status < 400 && /\/login(?:\b|[/?#])/.test(loc));
}
async function fetchOverleafDownload(req, useServerJar = false) {
  const url = new URL(req.originalUrl || req.url, config.overleafUrl);
  const headers = {};
  for (const key of ['accept', 'accept-language', 'range', 'user-agent']) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }
  const cookie = useServerJar ? cookieHeader() : String(req.headers.cookie || '');
  if (cookie) headers.cookie = cookie;
  return fetch(url, { redirect: 'manual', headers });
}
async function pipeOverleafDownload(req, res) {
  try {
    let upstream = await fetchOverleafDownload(req, false);
    if (shouldRetryDownloadWithServerLogin(upstream)) {
      await ensureLogin();
      upstream = await fetchOverleafDownload(req, true);
    }
    copyOverleafResponseHeaders(upstream, res);
    res.status(upstream.status);
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).on('error', (err) => {
      if (!res.headersSent) res.status(502);
      res.destroy(err);
    }).pipe(res);
  } catch (e) {
    loggedIn = false;
    if (!res.headersSent) {
      res.status(502).type('text/plain').send(`Overleaf 下载代理失败: ${String(e.message || e)}`);
    } else {
      res.destroy(e);
    }
  }
}
async function getCsrf(page) {
  const res = await olFetch(page);
  const html = await res.text();
  const m = html.match(/name="ol-csrfToken"\s+content="([^"]+)"/);
  if (!m) throw new Error(`无法从 ${page} 获取 CSRF token (HTTP ${res.status})`);
  return m[1];
}
let loggedIn = false;
async function login() {
  if (!config.email || !config.password) throw new Error('未配置 Overleaf 邮箱/密码，请点击右上角设置');
  const csrf = await getCsrf('/login');
  const res = await olFetch('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ _csrf: csrf, email: config.email, password: config.password }),
  });
  const loc = res.headers.get('location') || '';
  const okRedirect = res.status === 302 && !loc.includes('/login');
  if (res.status !== 200 && !okRedirect) {
    const body = await res.text().catch(() => '');
    throw new Error(`Overleaf 登录失败 (HTTP ${res.status} → ${loc}): ${body.slice(0, 200)}`);
  }
  loggedIn = true;
}
async function ensureLogin() {
  if (!loggedIn) await login();
}

// ---------- mongo 查询 (项目/文件夹 id) ----------
function mongoEval(js) {
  const out = execFileSync('docker', ['exec', 'mongo', 'mongosh', 'sharelatex', '--quiet', '--eval', js], { encoding: 'utf8' });
  return JSON.parse(out);
}
function listOverleafProjects() {
  const js = 'EJSON.stringify(db.projects.find({}, {name:1,rootFolder:1,updatedAt:1}).sort({name:1}).toArray())';
  const rows = mongoEval(js);
  return (Array.isArray(rows) ? rows : []).map((doc) => ({
    id: oid(doc._id),
    name: doc.name,
    updatedAt: doc.updatedAt,
  })).filter((item) => item.name);
}
function getProjectInfo(name) {
  const js = `EJSON.stringify(db.projects.findOne({name: ${JSON.stringify(name)}}, {name:1, rootFolder:1}))`;
  const doc = mongoEval(js);
  if (!doc) throw new Error(`Overleaf 中找不到项目 "${name}"`);
  return doc;
}
const oid = (x) => (x && x.$oid) || x;
function getProjectInfoById(id) {
  const clean = String(id || '').trim();
  if (!/^[a-f0-9]{24}$/i.test(clean)) throw new Error(`Overleaf 项目 id 无效: ${clean}`);
  const js = `EJSON.stringify(db.projects.findOne({_id: ObjectId(${JSON.stringify(clean)})}, {name:1, rootFolder:1}))`;
  const doc = mongoEval(js);
  if (!doc) throw new Error(`Overleaf 中找不到项目 id "${clean}"`);
  return doc;
}

function getOverleafProjectFor(project) {
  if (project.overleafProjectId) return getProjectInfoById(project.overleafProjectId);
  return getProjectInfo(project.overleafProjectName);
}

function uniqueOverleafProjectName(baseName) {
  const base = String(baseName || '新建写作项目').trim() || '新建写作项目';
  const used = new Set(listOverleafProjects().map((p) => p.name));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}`;
    if (!used.has(next)) return next;
  }
  return `${base}-${Date.now().toString(36).slice(-6)}`;
}

async function createOverleafProject(baseName) {
  await ensureLogin();
  const projectName = uniqueOverleafProjectName(baseName);
  const csrf = await getCsrf('/project');
  const res = await olFetch('/project/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ _csrf: csrf, projectName }),
  });
  const body = await res.text().catch(() => '');
  if (res.status !== 200) {
    loggedIn = res.status !== 403 && loggedIn;
    throw new Error(`创建 Overleaf 项目失败 HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  let payload = {};
  try { payload = body ? JSON.parse(body) : {}; } catch {}
  return { name: projectName, id: oid(payload.project_id || getProjectInfo(projectName)?._id) };
}

function activeOverleafName() {
  return currentProject()?.overleafProjectName || '';
}

function requireOverleafProject() {
  const project = currentProject();
  if (!project?.overleafProjectName) {
    throw new Error(`项目 "${project?.label || ''}" 未绑定 Overleaf 项目`);
  }
  return project;
}

function requireOverleafProjectFor(input) {
  const requested = input && typeof input === 'object' ? input.projectId : input;
  const project = requested ? projectById(requested) : currentProject();
  if (!project?.overleafProjectName) {
    throw new Error(`项目 "${project?.label || ''}" 未绑定 Overleaf 项目`);
  }
  return project;
}

function verifyProjectBoundary(project, action) {
  const marker = projectContract.readProjectMarker(project.paperDir);
  projectContract.assertProjectMarker(project, marker, action);
  if (!marker) {
    scaffoldProjectFiles(project);
  }
}

const SYNC_DENY_PREFIXES = [
  '.git/',
  '.paper-agent/',
  '.claude/',
  '.codex/',
  '.ssh/',
  'node_modules/',
  'runtime/',
  'backups/',
  '.venv/',
  '__pycache__/',
];
const SYNC_ALLOWED_EXTS = new Set([
  '.tex', '.bib', '.bst', '.cls', '.sty', '.bbx', '.cbx',
  '.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg',
  '.otf', '.ttf', '.txt', '.md',
]);

function normalizeSyncRelPath(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!clean || clean === '.') throw new Error('同步路径不能为空');
  if (path.isAbsolute(rel) || clean.includes('\0') || clean.split('/').includes('..')) {
    throw new Error(`拒绝项目外路径: ${rel}`);
  }
  if (SYNC_DENY_PREFIXES.some((prefix) => clean === prefix.slice(0, -1) || clean.startsWith(prefix))) {
    throw new Error(`拒绝同步受保护路径: ${rel}`);
  }
  if (clean.startsWith('.') || clean.includes('/.')) {
    throw new Error(`拒绝同步隐藏文件路径: ${rel}`);
  }
  return clean;
}

function resolveInsideProject(project, rel) {
  const clean = normalizeSyncRelPath(rel);
  const root = path.resolve(project.paperDir);
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越过项目目录: ${rel}`);
  }
  return { clean, abs };
}

function isAllowedSyncFile(rel) {
  return SYNC_ALLOWED_EXTS.has(path.extname(rel).toLowerCase());
}

function collectPushFiles(project) {
  const files = [];
  const denied = [];
  const addFile = (rel, abs) => {
    if (!isAllowedSyncFile(rel)) {
      denied.push({ file: rel, reason: '文件类型不在同步白名单' });
      return;
    }
    files.push({ rel, abs });
  };
  for (const rawRel of project.pushPaths || []) {
    let resolved;
    try {
      resolved = resolveInsideProject(project, rawRel);
    } catch (e) {
      denied.push({ file: String(rawRel || ''), reason: String(e.message || e) });
      continue;
    }
    const { clean, abs } = resolved;
    if (!fs.existsSync(abs)) {
      files.push({ rel: clean, abs, missing: true });
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      addFile(clean, abs);
      continue;
    }
    if (stat.isDirectory()) {
      const walk = (dir, relBase) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = `${relBase}/${entry.name}`.replace(/^\.\//, '');
          if (entry.name.startsWith('.')) {
            denied.push({ file: rel, reason: '跳过隐藏文件' });
            continue;
          }
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(child, rel);
          else if (entry.isFile()) addFile(rel, child);
        }
      };
      walk(abs, clean);
    }
  }
  const seen = new Set();
  return {
    files: files.filter((file) => {
      if (seen.has(file.rel)) return false;
      seen.add(file.rel);
      return true;
    }),
    denied,
  };
}

function pullFileAllowed(rel) {
  try {
    const clean = normalizeSyncRelPath(rel);
    return isAllowedSyncFile(clean);
  } catch {
    return false;
  }
}

// ---------- 拉取 / 推送 ----------
async function pullProject(input) {
  const project = requireOverleafProjectFor(input);
  verifyProjectBoundary(project, '拉取');
  await ensureLogin();
  const proj = getOverleafProjectFor(project);
  const id = oid(proj._id);
  const res = await olFetch(`/project/${id}/download/zip`);
  if (res.status !== 200) { loggedIn = false; throw new Error(`下载失败 HTTP ${res.status}`); }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-pull-'));
  const zipPath = path.join(tmp, 'p.zip');
  fs.writeFileSync(zipPath, buf);
  const exDir = path.join(tmp, 'x');
  const unzip = await runPythonCapture(['-m', 'zipfile', '-e', zipPath, exDir], { timeoutMs: 120000 });
  if (unzip.code !== 0) {
    throw new Error((unzip.stderr || unzip.stdout || unzip.error?.message || `zip extract exited ${unzip.code}`).slice(0, 5000));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bakDir = path.join(ROOT, 'backups', stamp);
  const changed = [];
  const skipped = [];
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
      if (!pullFileAllowed(r)) {
        skipped.push({ file: r, reason: '不在安全同步白名单' });
        continue;
      }
      const src = path.join(dir, e.name);
      const { abs: dst } = resolveInsideProject(project, r);
      const oldExists = fs.existsSync(dst);
      if (oldExists && fs.readFileSync(dst).equals(fs.readFileSync(src))) continue;
      if (oldExists) {
        const bak = path.join(bakDir, r);
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(dst, bak);
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      changed.push(r);
    }
  };
  walk(exDir);
  fs.rmSync(tmp, { recursive: true, force: true });
  projectContract.appendSyncLog(project, {
    action: 'pull',
    overleafProjectName: project.overleafProjectName || proj.name || '',
    overleafProjectId: id,
    changed,
    skipped,
    backup: changed.length ? bakDir : null,
  });
  projectContract.writeProjectMarker({ ...project, overleafProjectId: project.overleafProjectId || id }, effectiveProjectKind(project), reviewProfileForProject(project));
  return { changed, skipped, backup: changed.length ? bakDir : null };
}

async function pushProject(input) {
  const project = requireOverleafProjectFor(input);
  verifyProjectBoundary(project, '推送');
  if (!Array.isArray(project.pushPaths) || !project.pushPaths.length) {
    throw new Error('当前项目没有配置要推送的文件。请在设置里添加 main.tex、references.bib、figures 等路径。');
  }
  await ensureLogin();
  const proj = getOverleafProjectFor(project);
  const id = oid(proj._id);
  const rootId = oid(proj.rootFolder[0]._id);
  const csrf = await getCsrf('/project');
  const results = [];
  const plan = collectPushFiles(project);
  for (const item of plan.denied) results.push({ file: item.file, ok: false, msg: item.reason });
  for (const { rel, abs, missing } of plan.files) {
    if (missing) { results.push({ file: rel, ok: false, msg: '本地不存在' }); continue; }
    if (!fs.existsSync(abs)) { results.push({ file: rel, ok: false, msg: '本地不存在' }); continue; }
    const dir = path.dirname(rel) === '.' ? '' : path.dirname(rel);
    const form = new FormData();
    form.append('name', path.basename(rel));
    form.append('relativePath', dir ? rel : 'null');
    form.append('qqfile', new Blob([fs.readFileSync(abs)]), path.basename(rel));
    const res = await olFetch(`/project/${id}/upload?folder_id=${rootId}`, {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
      body: form,
    });
    const body = await res.text().catch(() => '');
    if (res.status === 200) results.push({ file: rel, ok: true });
    else { loggedIn = res.status !== 403 && loggedIn; results.push({ file: rel, ok: false, msg: `HTTP ${res.status} ${body.slice(0, 120)}` }); }
  }
  projectContract.appendSyncLog(project, {
    action: 'push',
    overleafProjectName: project.overleafProjectName || proj.name || '',
    overleafProjectId: id,
    files: results.map((r) => r.file),
    ok: results.every((r) => r.ok),
  });
  projectContract.writeProjectMarker({ ...project, overleafProjectId: project.overleafProjectId || id }, effectiveProjectKind(project), reviewProfileForProject(project));
  return results;
}

// 服务端代登录，把拿到的 session cookie 种给浏览器 → iframe 免登录
async function autoLoginCookie() {
  if (!config.email || !config.password) throw new Error('未配置账号');
  const tmpJar = new Map();
  const grab = (res) => {
    for (const line of (res.headers.getSetCookie?.() || [])) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) tmpJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  const cookies = () => [...tmpJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  let res = await fetch(config.overleafUrl + '/login', { redirect: 'manual' });
  grab(res);
  const m = (await res.text()).match(/name="ol-csrfToken"\s+content="([^"]+)"/);
  if (!m) throw new Error('获取 CSRF 失败');
  res = await fetch(config.overleafUrl + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-csrf-token': m[1], cookie: cookies() },
    body: JSON.stringify({ _csrf: m[1], email: config.email, password: config.password }),
  });
  grab(res);
  const loc = res.headers.get('location') || '';
  if (res.status !== 200 && !(res.status === 302 && !loc.includes('/login'))) {
    throw new Error(`登录失败 HTTP ${res.status}`);
  }
  const sid = tmpJar.get('overleaf.sid');
  if (!sid) throw new Error('未获取到 session cookie');
  return sid;
}

// ---------- Codex exec runner ----------
let runProc = null;
let runnerBusy = false;
let activeRunId = 0;
const ptyClients = new Set();

function wsSend(ws, text) {
  if (ws.readyState === 1) ws.send(text);
}

function broadcast(text) {
  for (const ws of ptyClients) wsSend(ws, text);
}

function isNoiseLine(line) {
  return !line ||
    line === 'Reading additional input from stdin...' ||
    / WARN codex_core_(plugins|skills)::/.test(line) ||
    / WARN codex_file_watcher:/.test(line);
}

function wrapTerminalLine(line, width = 104) {
  const text = String(line || '');
  if (text.length <= width) return text;
  const out = [];
  let rest = text;
  while (rest.length > width) {
    let cut = Math.max(
      rest.lastIndexOf(' ', width),
      rest.lastIndexOf('，', width),
      rest.lastIndexOf('。', width),
      rest.lastIndexOf('；', width),
      rest.lastIndexOf('、', width),
      rest.lastIndexOf(',', width),
      rest.lastIndexOf('.', width),
      rest.lastIndexOf(';', width),
    );
    if (cut < Math.floor(width * 0.45)) cut = width;
    out.push(rest.slice(0, cut + 1).trimEnd());
    rest = rest.slice(cut + 1).trimStart();
  }
  if (rest) out.push(rest);
  return out.join('\n');
}

function normalizeAgentTextForTerminal(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  for (let line of lines) {
    const raw = line;
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      out.push(trimmed);
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(raw)) continue;
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()).filter(Boolean);
      if (cells.length) out.push(wrapTerminalLine(`- ${cells.join(' / ')}`));
      continue;
    }
    line = raw.replace(/^\s{3,}(?=\S)/, '');
    out.push(wrapTerminalLine(line));
  }
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd();
}

function toTermText(text, { normalize = false } = {}) {
  const body = normalize ? normalizeAgentTextForTerminal(text) : String(text || '');
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

function formatJsonEvent(obj, phase = 'main') {
  const audit = phase === 'audit';
  if (obj.type === 'thread.started') return `\r\n\x1b[2mthread ${obj.thread_id}\x1b[0m\r\n`;
  if (obj.type === 'turn.started') return `\x1b[36m${audit ? 'Skill 审核中...' : 'Codex 正在处理...'}\x1b[0m\r\n`;
  if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
    return `\r\n\x1b[1m${audit ? 'Skill 审核' : 'Codex'}\x1b[0m\r\n${toTermText(obj.item.text || '', { normalize: true })}\r\n`;
  }
  if (obj.type === 'item.completed' && obj.item?.type === 'command_execution') {
    const command = obj.item.command || '';
    return command ? `\r\n\x1b[2m$ ${command}\x1b[0m\r\n` : '';
  }
  if (obj.type === 'turn.completed') {
    const input = obj.usage?.input_tokens || 0;
    const output = obj.usage?.output_tokens || 0;
    return `\r\n\x1b[32m${audit ? '审核完成' : '完成'} · tokens ${input}/${output}\x1b[0m\r\n`;
  }
  if (obj.type === 'error') return `\r\n\x1b[31m${toTermText(obj.message || JSON.stringify(obj), { normalize: true })}\x1b[0m\r\n`;
  return '';
}

function stopRun(signal = 'SIGTERM') {
  activeRunId += 1;
  runnerBusy = false;
  const proc = runProc;
  runProc = null;
  if (!proc) return;
  try { process.kill(-proc.pid, signal); } catch {}
  try { proc.kill(signal); } catch {}
}

const STATUS_IGNORE_PARTS = [
  '/node_modules/',
  '/runtime/',
  '/backups/',
  '/build/',
  '/.venv/',
  '/__pycache__/',
];
const STATUS_IGNORE_SUFFIXES = [
  '/server.log',
  '/config.json',
  '/auth.json',
  '/installation_id',
];

function normalizeStatusPath(project, rel) {
  const clean = String(rel || '').replace(/^"|"$/g, '');
  if (path.isAbsolute(clean)) return clean;
  return path.relative(project.paperDir, path.resolve(project.paperDir, clean)).replace(/\\/g, '/');
}

function shouldIgnoreStatusPath(rel) {
  const p = `/${rel.replace(/\\/g, '/')}`;
  return STATUS_IGNORE_PARTS.some((part) => p.includes(part)) ||
    STATUS_IGNORE_SUFFIXES.some((suffix) => p.endsWith(suffix));
}

function filterStatus(project, status) {
  return String(status || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const rel = normalizeStatusPath(project, line.slice(3).trim());
      return !shouldIgnoreStatusPath(rel);
    })
    .join('\n');
}

function untrackedFingerprint(project, filteredStatus) {
  const rows = [];
  for (const line of String(filteredStatus || '').split(/\r?\n/).filter(Boolean)) {
    if (!line.startsWith('?? ')) continue;
    const rel = normalizeStatusPath(project, line.slice(3).trim());
    if (shouldIgnoreStatusPath(rel)) continue;
    const abs = path.join(project.paperDir, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      let marker = `${rel}:${st.size}:${Math.round(st.mtimeMs)}`;
      if (st.size <= 512 * 1024) {
        marker += `:${crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex')}`;
      }
      rows.push(marker);
    } catch {}
    if (rows.length >= 200) break;
  }
  return rows.sort().join('\n');
}

function repoState(project) {
  try {
    const rawStatus = execFileSync('git', ['-C', project.paperDir, 'status', '--short', '--untracked-files=all', '--', '.'], { encoding: 'utf8', timeout: 5000 });
    const status = filterStatus(project, rawStatus);
    const diffStat = execFileSync('git', ['-C', project.paperDir, 'diff', '--stat', '--', '.'], { encoding: 'utf8', timeout: 5000 });
    const stagedStat = execFileSync('git', ['-C', project.paperDir, 'diff', '--cached', '--stat', '--', '.'], { encoding: 'utf8', timeout: 5000 });
    const untrackedHash = untrackedFingerprint(project, status);
    return { ok: true, status, diffStat, stagedStat, untrackedHash };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function repoFingerprint(state) {
  if (!state?.ok) return '';
  return JSON.stringify([state.status, state.diffStat, state.stagedStat, state.untrackedHash]);
}

function shouldRunAudit(project, before, after) {
  if (!project.audit || project.audit.enabled === false) return false;
  if (project.audit.mode === 'always') return true;
  return before?.ok && after?.ok && repoFingerprint(before) !== repoFingerprint(after);
}

function buildAuditPrompt(project, originalPrompt, before, after) {
  const base = project.audit?.prompt || `请使用 paper-agent-audit skill，对刚才 Paper Agent 前端命令造成的改动做规则审核。禁止修改文件。

项目: {{projectLabel}} ({{projectId}})
工作目录: {{paperDir}}

用户原命令:
{{originalPrompt}}

运行前 git 状态:
{{beforeStatus}}

运行后 git 状态:
{{afterStatus}}

请只读取当前项目目录内的 .paper-agent/project.json、AGENTS.md 和相关 skill 规则；运行 git status --short -- .、git diff --stat -- .、git diff -- .；检查是否尊重完整规则、项目边界、用户最新命令、japanese-style-rag 数据边界、以及前端/后端实现要求。不要把父级仓库的 main.log、旧 reviews、旧论文 AGENTS、.gitignore 或其他项目文件作为当前任务证据。输出“通过/不通过”，列出阻塞问题和建议修复步骤。`;
  return renderTemplate(base, projectVars(project, {
    originalPrompt: String(originalPrompt || '').slice(0, 6000),
    beforeStatus: before?.ok ? before.status || '(clean)' : `无法读取: ${before?.error || ''}`,
    afterStatus: after?.ok ? after.status || '(clean)' : `无法读取: ${after?.error || ''}`,
  }));
}

function codexEnv(project, codexHome) {
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    PAPER_AGENT_API_BASE: paperAgentApiBase(),
    PAPER_AGENT_TOKEN: localAuth.token,
    PAPER_AGENT_PROJECT_ID: project.id,
    PAPER_AGENT_PROJECT_LABEL: project.label,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    NO_COLOR: '1',
  };
  if (project.rag?.enabled || project.modules?.includes('japanese-style-rag')) {
    env.JSTYLE_RAG_ROOT = jstyleDataRoot(project);
    env.JSTYLE_PROJECT_ROOT = jstyleDataRoot(project);
    env.JSTYLE_MODULE_SOURCE_ROOT = JAPANESE_RAG_ROOT;
    env.PYTHONPATH = [path.join(JAPANESE_RAG_ROOT, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }
  return env;
}

function runCodexExec(project, prompt, phase, runId) {
  return new Promise((resolve) => {
    const text = portablePrompt(project, prompt);
    const agent = currentAgent(project);
    const codexHome = ensureProjectCodexHome(project);
    const { cmd, args } = getCodexSpawn();
    const runArgs = [
      ...args,
      'exec',
      '--json',
      '--ignore-user-config',
      '--sandbox',
      'danger-full-access',
      '--skip-git-repo-check',
      '-C',
      project.paperDir,
      '-',
    ];
    if (agent.model) runArgs.splice(args.length + 1, 0, '--model', agent.model);

    const proc = spawn(cmd, runArgs, {
      cwd: project.paperDir,
      detached: true,
      env: codexEnv(project, codexHome),
    });
    runProc = proc;
    try { proc.stdin.end(text); } catch {}

    let stdoutBuf = '';
    const handleLine = (line) => {
      if (isNoiseLine(line)) return;
      try {
        const msg = formatJsonEvent(JSON.parse(line), phase);
        if (msg) broadcast(msg);
      } catch {
        broadcast(`${line}\r\n`);
      }
    };

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });
    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!isNoiseLine(line)) broadcast(`\x1b[31m${line}\x1b[0m\r\n`);
      }
    });
    proc.on('exit', (code, signal) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
      if (runProc === proc) runProc = null;
      if (runId === activeRunId) {
        broadcast(`\r\n\x1b[2m${phase === 'audit' ? '审核' : 'Codex'} 结束 (${signal ? `signal ${signal}` : `code ${code}`})\x1b[0m\r\n`);
      }
      resolve({ code, signal });
    });
    proc.on('error', (e) => {
      if (runProc === proc) runProc = null;
      broadcast(`\r\n\x1b[31mCodex 启动失败: ${String(e.message || e)}\x1b[0m\r\n`);
      resolve({ code: -1, signal: null, error: e });
    });
  });
}

function runCliAgentExec(project, agent, prompt, phase, runId) {
  return new Promise((resolve) => {
    const text = String(prompt || '').trim();
    const baseParts = splitCommandLine(agent.command || '');
    if (!baseParts.length) {
      broadcast(`\r\n\x1b[31m助手命令为空: ${agent.label || agent.id}\x1b[0m\r\n`);
      return resolve({ code: -1, signal: null });
    }

    const promptFile = path.join(RUNTIME_ROOT, 'prompts', `${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, text);
    const vars = { cwd: project.paperDir, prompt: text, promptFile };

    let args = baseParts.slice(1);
    if (agent.type === 'claude-code') {
      args = [
        ...args,
        '--print',
        '--output-format',
        'text',
        '--permission-mode',
        agent.permissionMode || 'bypassPermissions',
        '--no-session-persistence',
      ];
      if (agent.model) args.push('--model', agent.model);
      if (agent.cwdFlag === true) args.push('--cwd', project.paperDir);
    } else {
      args = [...args, ...renderCommandArgs(agent.args || '', vars)];
      if (agent.promptMode === 'arg') args.push(text);
      if (agent.promptMode === 'file') args.push(promptFile);
    }

    broadcast(`\r\n\x1b[36m${agent.label || agent.id} 正在处理...\x1b[0m\r\n`);
    const proc = spawn(baseParts[0], args, {
      cwd: project.paperDir,
      detached: true,
      env: {
        ...process.env,
        PAPER_AGENT_API_BASE: paperAgentApiBase(),
        PAPER_AGENT_TOKEN: localAuth.token,
        PAPER_AGENT_PROJECT_ID: project.id,
        PAPER_AGENT_PROJECT_LABEL: project.label,
        JSTYLE_RAG_ROOT: project.modules?.includes('japanese-style-rag') ? jstyleDataRoot(project) : '',
        JSTYLE_PROJECT_ROOT: project.modules?.includes('japanese-style-rag') ? jstyleDataRoot(project) : '',
        JSTYLE_MODULE_SOURCE_ROOT: project.modules?.includes('japanese-style-rag') ? JAPANESE_RAG_ROOT : '',
        TERM: 'xterm-256color',
        NO_COLOR: '1',
      },
    });
    runProc = proc;
    if (agent.type === 'claude-code' || agent.promptMode !== 'arg') {
      try { proc.stdin.end(text); } catch {}
    } else {
      try { proc.stdin.end(); } catch {}
    }

    proc.stdout.on('data', (chunk) => {
      broadcast(chunk.toString().replace(/\n/g, '\r\n'));
    });
    proc.stderr.on('data', (chunk) => {
      broadcast(`\x1b[31m${chunk.toString().replace(/\n/g, '\r\n')}\x1b[0m`);
    });
    proc.on('exit', (code, signal) => {
      if (runProc === proc) runProc = null;
      try { fs.rmSync(promptFile, { force: true }); } catch {}
      if (runId === activeRunId) {
        broadcast(`\r\n\x1b[2m${agent.label || agent.id} 结束 (${signal ? `signal ${signal}` : `code ${code}`})\x1b[0m\r\n`);
      }
      resolve({ code, signal });
    });
    proc.on('error', (e) => {
      if (runProc === proc) runProc = null;
      try { fs.rmSync(promptFile, { force: true }); } catch {}
      broadcast(`\r\n\x1b[31m${agent.label || agent.id} 启动失败: ${String(e.message || e)}\x1b[0m\r\n`);
      resolve({ code: -1, signal: null, error: e });
    });
  });
}

async function runApiAgentExec(project, agent, prompt) {
  const apiKey = agent.apiKey || (agent.apiKeyEnv ? process.env[agent.apiKeyEnv] : '');
  const baseUrl = String(agent.baseUrl || '').replace(/\/+$/g, '');
  if (!baseUrl) throw new Error('API 助手缺少 baseUrl');
  const url = `${baseUrl}/chat/completions`;
  const userTask = String(prompt || '').trim();
  const context = apiProjectContext(project, userTask);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: agent.model || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: apiSystemPrompt(project, agent),
        },
        { role: 'user', content: `${context}\n\n${portableApiPrompt(project, userTask)}` },
      ],
      temperature: Number.isFinite(Number(agent.temperature)) ? Number(agent.temperature) : 0.3,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 1000)}`);
  const json = JSON.parse(body);
  return normalizeApiAgentText(json.choices?.[0]?.message?.content || JSON.stringify(json, null, 2));
}

async function modelsForAgent(provider, incomingAgents = {}) {
  const id = provider || currentProject()?.agentProvider || 'codex';
  const agent = mergeAgentConfig(id, incomingAgents[id]);
  const selected = currentProject();
  if (agent.type === 'codex') {
    const parts = splitCommandLine(agent.command || DEFAULT_AGENTS.codex.command);
    const cmd = parts[0] || DEFAULT_AGENTS.codex.command;
    const args = [...parts.slice(1), 'debug', 'models'];
    try {
      const stdout = execFileSync(cmd, args, {
        cwd: selected?.paperDir || ROOT,
        env: codexEnv(selected || defaultWorkspaceProject(config), ensureProjectCodexHome(selected || defaultWorkspaceProject(config))),
        encoding: 'utf8',
        timeout: 12000,
      });
      return { source: 'codex debug models', models: uniqueStrings([agent.model, ...modelIdsFromCatalog(JSON.parse(stdout))]) };
    } catch (e) {
      return { source: 'codex fallback', models: uniqueStrings([agent.model]), warning: String(e.message || e) };
    }
  }
  if (agent.type === 'openai-compatible') {
    const apiKey = agent.apiKey || (agent.apiKeyEnv ? process.env[agent.apiKeyEnv] : '');
    const baseUrl = String(agent.baseUrl || '').replace(/\/+$/g, '');
    if (!baseUrl) throw new Error('API 助手缺少 baseUrl');
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 1000)}`);
    return { source: `${baseUrl}/models`, models: uniqueStrings([agent.model, ...modelIdsFromCatalog(JSON.parse(body))]) };
  }
  const key = id === 'claude' || agent.type === 'claude-code' ? 'claude' : id;
  return {
    source: agent.type === 'claude-code' ? 'claude aliases' : 'manual',
    models: uniqueStrings([agent.model, ...(FALLBACK_MODEL_OPTIONS[key] || [])]),
  };
}

async function runAgentExec(project, prompt, phase, runId) {
  const agent = currentAgent(project);
  if (agent.type === 'codex') return runCodexExec(project, prompt, phase, runId);
  const effectivePrompt = portablePrompt(project, prompt);
  if (agent.type === 'openai-compatible') {
    broadcast(`\r\n\x1b[36m${agent.label || agent.id} 正在处理...\x1b[0m\r\n`);
    try {
      const text = await runApiAgentExec(project, agent, prompt);
      broadcast(`\r\n\x1b[1m${agent.label || agent.id}\x1b[0m\r\n${toTermText(text, { normalize: true })}\r\n`);
      broadcast(`\r\n\x1b[2m${agent.label || agent.id} 结束 (api)\x1b[0m\r\n`);
      return { code: 0, signal: null };
    } catch (e) {
      broadcast(`\r\n\x1b[31m${agent.label || agent.id} 失败: ${toTermText(String(e.message || e), { normalize: true })}\x1b[0m\r\n`);
      return { code: -1, signal: null, error: e };
    }
  }
  return runCliAgentExec(project, agent, effectivePrompt, phase, runId);
}

function runProcessCapture(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
    }, options.timeoutMs || 120000);
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr, error });
    });
  });
}

function venvPythonPath(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function pythonCommandCandidates() {
  const configured = process.env.PAPER_AGENT_PYTHON || process.env.PYTHON || '';
  const out = [];
  if (configured.trim()) {
    const parts = splitCommandLine(configured);
    if (parts.length) out.push({ cmd: parts[0], prefix: parts.slice(1) });
  }
  if (process.platform === 'win32') {
    out.push({ cmd: 'py', prefix: ['-3'] });
    out.push({ cmd: 'python', prefix: [] });
    out.push({ cmd: 'python3', prefix: [] });
  } else {
    out.push({ cmd: 'python3', prefix: [] });
    out.push({ cmd: 'python', prefix: [] });
  }
  return out;
}

async function runPythonCapture(args, options = {}) {
  let last = null;
  for (const item of pythonCommandCandidates()) {
    const res = await runProcessCapture(item.cmd, [...item.prefix, ...args], options);
    last = res;
    if (!res.error) return res;
    if (res.error?.code && res.error.code !== 'ENOENT') return res;
  }
  return last || { code: -1, signal: null, stdout: '', stderr: '', error: new Error('python not found') };
}

function sanitizeUploadName(name) {
  const base = path.basename(String(name || 'material.txt'));
  return base.replace(/[^\w.\-\u4e00-\u9fff ]+/g, '_').trim() || 'material.txt';
}

const MATERIAL_ALLOWED_EXTS = new Set(['.pdf', '.txt', '.md', '.tex', '.bib', '.docx']);
const MATERIAL_MAX_FILE_BYTES = 60 * 1024 * 1024;

function collectRequestBuffer(req, limitBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('上传内容太大，请分批导入资料'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartBuffer(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(marker);
  while (start !== -1) {
    start += marker.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const next = buffer.indexOf(marker, start);
    if (next === -1) break;
    let part = buffer.slice(start, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.slice(0, -2);
    }
    const split = part.indexOf(Buffer.from('\r\n\r\n'));
    if (split !== -1) {
      const headerText = part.slice(0, split).toString('utf8');
      const body = part.slice(split + 4);
      const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
      const name = disposition.match(/name="([^"]+)"/)?.[1] || '';
      const filename = disposition.match(/filename="([^"]*)"/)?.[1] || '';
      if (name) parts.push({ name, filename, data: body });
    }
    start = next;
  }
  return parts;
}

async function parseMultipartRequest(req) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) throw new Error('缺少上传边界，请使用文件选择器导入');
  const buffer = await collectRequestBuffer(req);
  const fields = {};
  const files = [];
  for (const part of parseMultipartBuffer(buffer, boundary)) {
    if (part.filename) {
      files.push({
        field: part.name,
        filename: sanitizeUploadName(part.filename),
        data: part.data,
      });
    } else {
      fields[part.name] = part.data.toString('utf8');
    }
  }
  if (files.length > 60) throw new Error('一次最多导入 60 个文件，请分批导入资料');
  for (const file of files) {
    const ext = path.extname(file.filename).toLowerCase();
    if (!MATERIAL_ALLOWED_EXTS.has(ext)) {
      throw new Error(`资料类型不支持: ${file.filename}`);
    }
    if (file.data.length > MATERIAL_MAX_FILE_BYTES) {
      throw new Error(`单个资料文件过大: ${file.filename}`);
    }
  }
  return { fields, files };
}

function jstyleProject(input) {
  const requestedId = input && typeof input === 'object' ? input.projectId : input;
  const project = requestedId ? projectById(requestedId) : currentProject();
  if (!project) throw new Error('没有可用项目');
  if (!fs.existsSync(path.join(JAPANESE_RAG_ROOT, 'src', 'jstyle_rag'))) {
    throw new Error(`日语报告助手源码不存在: ${JAPANESE_RAG_ROOT}`);
  }
  return project;
}

function jstyleDataRoot(project) {
  const configured = project?.rag?.root ? resolveLocalPath(project.rag.root) : '';
  if (configured && path.resolve(configured) !== path.resolve(JAPANESE_RAG_ROOT)) return configured;
  if (project?.paperDir && path.resolve(project.paperDir) !== path.resolve(JAPANESE_RAG_ROOT)) {
    return path.join(project.paperDir, '.paper-agent', 'modules', 'japanese-style-rag');
  }
  return path.join(JSTYLE_DATA_ROOT, safeProjectId(project?.id || 'project'));
}

function legacyJstyleDataRoots(project) {
  const ids = uniqueStrings([
    project?.id,
    project?.overleafProjectName,
    project?.label,
    ...(Array.isArray(project?.rag?.legacyProjectIds) ? project.rag.legacyProjectIds : []),
  ].map((value) => safeProjectId(value || '')));
  const roots = ids.map((id) => path.join(JSTYLE_DATA_ROOT, id));
  if (Array.isArray(project?.rag?.legacyRoots)) {
    for (const item of project.rag.legacyRoots) roots.push(resolveLocalPath(item));
  }
  return uniqueStrings(roots.map((item) => path.resolve(item)));
}

function copyMissingTree(src, dst) {
  if (!fs.existsSync(src)) return { files: 0, dirs: 0 };
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    let files = 0;
    let dirs = 0;
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(dst, { recursive: true, mode: 0o755 });
      dirs += 1;
    }
    for (const name of fs.readdirSync(src)) {
      const child = copyMissingTree(path.join(src, name), path.join(dst, name));
      files += child.files;
      dirs += child.dirs;
    }
    return { files, dirs };
  }
  if (stat.isFile()) {
    if (fs.existsSync(dst)) return { files: 0, dirs: 0 };
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o755 });
    fs.copyFileSync(src, dst);
    try { fs.chmodSync(dst, stat.mode & 0o777); } catch {}
    return { files: 1, dirs: 0 };
  }
  return { files: 0, dirs: 0 };
}

function ensureJstyleProjectData(project) {
  const target = jstyleDataRoot(project);
  fs.mkdirSync(target, { recursive: true, mode: 0o755 });
  const migrations = [];
  for (const legacyRoot of legacyJstyleDataRoots(project)) {
    if (!fs.existsSync(legacyRoot)) continue;
    if (path.resolve(legacyRoot) === path.resolve(target)) continue;
    const result = copyMissingTree(legacyRoot, target);
    if (result.files || result.dirs) {
      migrations.push({ from: legacyRoot, files: result.files, dirs: result.dirs });
    }
  }
  const statePath = path.join(target, 'paper-agent-module.json');
  const prev = readJson(statePath, {});
  const state = {
    schemaVersion: 1,
    projectId: project.id,
    projectLabel: project.label,
    hostProjectRoot: project.paperDir,
    dataRoot: target,
    migratedFrom: uniqueStrings([...(prev.migratedFrom || []), ...migrations.map((item) => item.from)]),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  return { target, migrations };
}

function latestJsonFile(dir) {
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile())
    .sort();
  return files.at(-1) || '';
}

function jstyleLatestOutputFile(project) {
  return latestJsonFile(path.join(jstyleDataRoot(project), 'data', 'outputs'));
}

function jstyleHostDraftJson(project) {
  return path.join(project.paperDir, 'outputs', 'japanese-style-rag', 'latest-draft.json');
}

function jstyleHostDraftMarkdown(project) {
  return path.join(project.paperDir, 'outputs', 'japanese-style-rag', 'latest-draft.md');
}

function jstyleDraftMarkdown(data, sourceLabel = '') {
  const lines = [
    '# Japanese Style RAG Latest Draft',
    '',
    sourceLabel ? `Source: ${sourceLabel}` : '',
    data?.topic ? `Topic: ${data.topic}` : '',
    data?.word_count ? `Word count: ${data.word_count}` : '',
    '',
    '## Draft',
    '',
    data?.draft || '',
  ].filter((line) => line !== '');
  if (Array.isArray(data?.citation_warnings) && data.citation_warnings.length) {
    lines.push('', '## Citation Warnings', '', JSON.stringify(data.citation_warnings, null, 2));
  }
  if (Array.isArray(data?.similarity_warnings) && data.similarity_warnings.length) {
    lines.push('', '## Similarity Warnings', '', JSON.stringify(data.similarity_warnings, null, 2));
  }
  if (Array.isArray(data?.sources_used) && data.sources_used.length) {
    lines.push('', '## Sources Used', '', JSON.stringify(data.sources_used, null, 2));
  }
  if (Array.isArray(data?.paragraph_sources) && data.paragraph_sources.length) {
    lines.push('', '## Paragraph Sources', '', JSON.stringify(data.paragraph_sources, null, 2));
  }
  if (data?.run_manifest && typeof data.run_manifest === 'object') {
    lines.push('', '## Run Manifest', '', JSON.stringify(data.run_manifest, null, 2));
  }
  return `${lines.join('\n')}\n`;
}

function syncJstyleLatestDraftArtifacts(project, result = null) {
  let data = result;
  let source = 'api-result';
  if (!data) {
    const latest = jstyleLatestOutputFile(project);
    if (!latest) return null;
    data = readJson(latest, null);
    source = path.relative(project.paperDir, latest);
  }
  if (!data || typeof data !== 'object' || !data.draft) return null;
  const jsonPath = jstyleHostDraftJson(project);
  const mdPath = jstyleHostDraftMarkdown(project);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true, mode: 0o755 });
  const payload = {
    schemaVersion: 1,
    projectId: project.id,
    source,
    syncedAt: new Date().toISOString(),
    output: data,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(mdPath, jstyleDraftMarkdown(data, source));
  return {
    latestDraftJson: path.relative(project.paperDir, jsonPath),
    latestDraftMarkdown: path.relative(project.paperDir, mdPath),
  };
}

function readPersistedJstyleDraft(project) {
  const file = jstyleHostDraftJson(project);
  if (!fs.existsSync(file)) return null;
  const payload = readJson(file, null);
  const output = payload?.output && typeof payload.output === 'object' ? payload.output : payload;
  if (!output?.draft) return null;
  return { file, payload, output };
}

function pythonForProject(project) {
  const modulePython = venvPythonPath(path.join(JSTYLE_RUNTIME_ROOT, '.venv'));
  if (fs.existsSync(modulePython)) return modulePython;
  const localPython = venvPythonPath(path.join(project.paperDir, '.venv'));
  if (fs.existsSync(localPython)) return localPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function jstyleEnv(project) {
  const dataRoot = jstyleDataRoot(project);
  return {
    ...process.env,
    JSTYLE_RAG_ROOT: dataRoot,
    PAPER_AGENT_HOST_PROJECT_ROOT: project.paperDir,
    PAPER_AGENT_HOST_PROJECT_ID: project.id,
    PAPER_AGENT_HOST_PROJECT_LABEL: project.label,
    JSTYLE_VECTOR_BACKEND: process.env.JSTYLE_VECTOR_BACKEND || 'json',
    JSTYLE_EMBEDDING_MODEL: process.env.JSTYLE_EMBEDDING_MODEL || 'openai:qwen3-embedding',
    JSTYLE_EMBEDDING_BASE_URL: process.env.JSTYLE_EMBEDDING_BASE_URL || 'http://127.0.0.1:8001/v1',
    JSTYLE_EMBEDDING_API_KEY: process.env.JSTYLE_EMBEDDING_API_KEY || '',
    JSTYLE_ALLOW_HASH_EMBEDDINGS: process.env.JSTYLE_ALLOW_HASH_EMBEDDINGS || '0',
    PYTHONPATH: [path.join(JAPANESE_RAG_ROOT, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
}

async function ensureJstyleRuntime(project, install = false) {
  fs.mkdirSync(JSTYLE_RUNTIME_ROOT, { recursive: true });
  const projectData = ensureJstyleProjectData(project);
  const venvDir = path.join(JSTYLE_RUNTIME_ROOT, '.venv');
  const python = venvPythonPath(venvDir);
  const created = !fs.existsSync(python);
  if (created) {
    const res = await runPythonCapture(['-m', 'venv', venvDir], {
      cwd: JAPANESE_RAG_ROOT,
      env: process.env,
      timeoutMs: 120000,
    });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout || `venv exited ${res.code}`).slice(0, 5000));
  }
  const marker = path.join(JSTYLE_RUNTIME_ROOT, 'module-runtime.json');
  const payload = {
    python,
    moduleSourceRoot: JAPANESE_RAG_ROOT,
    hostProjectRoot: project.paperDir,
    dataRoot: projectData.target,
    projectDataMigrations: projectData.migrations,
    embeddingBackend: process.env.JSTYLE_EMBEDDING_MODEL || 'openai:qwen3-embedding',
    embeddingBaseUrl: process.env.JSTYLE_EMBEDDING_BASE_URL || 'http://127.0.0.1:8001/v1',
    vectorBackend: process.env.JSTYLE_VECTOR_BACKEND || 'json',
    createdAt: fs.existsSync(marker) ? readJson(marker, {}).createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(marker, JSON.stringify(payload, null, 2));
  if (install) {
    const res = await runProcessCapture(python, ['-m', 'pip', 'install', '-e', '.', '--no-deps'], {
      cwd: JAPANESE_RAG_ROOT,
      env: jstyleEnv(project),
      timeoutMs: 180000,
    });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout || `pip exited ${res.code}`).slice(0, 5000));
    payload.installedEditable = true;
    payload.updatedAt = new Date().toISOString();
    fs.writeFileSync(marker, JSON.stringify(payload, null, 2));
  }
  syncJstyleLatestDraftArtifacts(project);
  return { ok: true, created, ...payload };
}

async function runJstyleInline(project, script, payload = {}, timeoutMs = 120000) {
  await ensureJstyleRuntime(project, false);
  const code = `${script}\n`;
  const res = await runProcessCapture(
    pythonForProject(project),
    ['-c', code, JSON.stringify(payload)],
    { cwd: JAPANESE_RAG_ROOT, env: jstyleEnv(project), timeoutMs },
  );
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || res.error?.message || `python exited ${res.code}`).slice(0, 5000));
  }
  try {
    return JSON.parse(res.stdout);
  } catch (e) {
    throw new Error(`无法解析日语报告助手输出: ${String(e.message || e)}\n${res.stdout.slice(0, 2000)}`);
  }
}

async function jstyleModuleStatus() {
  const project = jstyleProject(arguments[0]);
  const runtime = await ensureJstyleRuntime(project, false);
  const status = await runJstyleInline(project, `
import json
from jstyle_rag.module import module_status

print(json.dumps(module_status(), ensure_ascii=False))
`, {}, 120000);
  const persisted = syncJstyleLatestDraftArtifacts(project);
  return {
    ...status,
    runtime,
    persisted,
    display: {
      projectRoot: displayPathForProject(project, project.paperDir),
      moduleSourceRoot: displayPathForProject(project, JAPANESE_RAG_ROOT),
      projectRootData: displayPathForProject(project, status.project_root || jstyleDataRoot(project)),
      rawMaterials: displayPathForProject(project, path.join(jstyleDataRoot(project), 'data/source_corpus/raw')),
      processedSourceChunks: displayPathForProject(project, path.join(jstyleDataRoot(project), 'data/source_corpus/processed/source_chunks.jsonl')),
      sourceVectorIndex: displayPathForProject(project, path.join(jstyleDataRoot(project), 'data/source_corpus/index/source_vectors.jsonl')),
      outputs: displayPathForProject(project, path.join(jstyleDataRoot(project), 'data/outputs')),
    },
    host_project: {
      id: project.id,
      label: project.label,
      root: project.paperDir,
      overleafProjectName: project.overleafProjectName || '',
    },
  };
}

async function bootstrapJstyleModule(install = false, input = {}) {
  const project = jstyleProject(input);
  const runtime = await ensureJstyleRuntime(project, !!install);
  const status = await jstyleModuleStatus(input);
  return { runtime, status };
}

async function importJstyleMaterial(params) {
  const project = jstyleProject(params);
  const sourcePath = params?.sourcePath && !path.isAbsolute(String(params.sourcePath))
    ? path.resolve(project.paperDir, String(params.sourcePath))
    : params?.sourcePath;
  return runJstyleInline(project, `
import json, sys
from jstyle_rag.module import import_material

payload = json.loads(sys.argv[1])
result = import_material(
    source_path=payload.get("sourcePath") or "",
    material_id=payload.get("materialType") or "user_note",
    title=payload.get("title") or "",
    publisher=payload.get("publisher") or "",
    published_date=payload.get("publishedDate") or "",
    source_url=payload.get("sourceUrl") or "",
)
print(json.dumps(result, ensure_ascii=False))
`, { ...(params || {}), sourcePath }, 120000);
}

async function generateJstyleReport(params) {
  const project = jstyleProject(params);
  const result = await runJstyleInline(project, `
import json, sys
from jstyle_rag.generation.report_pipeline import generate_report
from jstyle_rag.module import build_task_requirements, task_preset

payload = json.loads(sys.argv[1])
task_type = payload.get("taskType") or "report"
preset = task_preset(task_type)
requirements = build_task_requirements(
    task_type=task_type,
    requirements=payload.get("requirements") or "",
    course_name=payload.get("courseName") or "",
    assignment=payload.get("assignment") or "",
)
result = generate_report(
    topic=payload.get("topic") or "未指定テーマ",
    word_count=int(payload.get("wordCount") or preset.get("default_word_count") or 1600),
    discipline=payload.get("discipline") or "general",
    target_style=payload.get("targetStyle") or preset.get("target_style") or "undergraduate_report",
    requirements=requirements,
    user_points=payload.get("userPoints") or [],
    save=True,
)
result.pop("prompt", None)
print(json.dumps(result, ensure_ascii=False))
`, params, 180000);
  const persisted = syncJstyleLatestDraftArtifacts(project, result);
  return { ...result, persisted };
}

async function guardJstyleProject() {
  const project = jstyleProject(arguments[0]);
  return runJstyleInline(project, `
import json, os
from pathlib import Path
from jstyle_rag.config import get_config
from jstyle_rag.sources.citation_guard import check_citations
from jstyle_rag.style.similarity_guard import check_similarity
from jstyle_rag.style.style_index import load_style_raw_chunks

cfg = get_config()
outputs = sorted(cfg.outputs_dir.glob("*.json"))
latest = outputs[-1] if outputs else None
if latest is None:
    host = os.environ.get("PAPER_AGENT_HOST_PROJECT_ROOT") or ""
    fallback = Path(host) / "outputs" / "japanese-style-rag" / "latest-draft.json" if host else None
    if fallback and fallback.exists():
        latest = fallback
if latest is None:
    print(json.dumps({
        "passed": False,
        "output_file": "",
        "checks": [{
            "name": "latest_draft_exists",
            "passed": False,
            "warnings": [{"reason": "まだ生成済み草稿がありません。先に草稿を生成してください。"}],
        }],
    }, ensure_ascii=False))
else:
    data = json.loads(latest.read_text(encoding="utf-8"))
    data = data.get("output") if isinstance(data, dict) and isinstance(data.get("output"), dict) else data
    draft = data.get("draft") or ""
    sources = data.get("sources_used") or []
    citation = check_citations(draft, sources)
    similarity = check_similarity(citation.text, style_chunks=load_style_raw_chunks(cfg))
    checks = [
        {
            "name": "latest_draft_exists",
            "passed": True,
            "warnings": [],
        },
        {
            "name": "source_grounding",
            "passed": not citation.warnings,
            "warnings": [warning.to_dict() for warning in citation.warnings],
        },
        {
            "name": "style_similarity",
            "passed": not similarity,
            "warnings": [warning.to_dict() for warning in similarity],
        },
    ]
    try:
        output_file = str(latest.relative_to(cfg.project_root))
    except ValueError:
        output_file = str(latest)
    print(json.dumps({
        "passed": all(item["passed"] for item in checks),
        "output_file": output_file,
        "checks": checks,
        "annotated_draft": citation.text,
    }, ensure_ascii=False))
`, {}, 120000);
}

async function searchJstyleSources(params = {}) {
  const project = jstyleProject(params);
  return runJstyleInline(project, `
import json, sys
from jstyle_rag.sources.source_index import retrieve_source_chunks

payload = json.loads(sys.argv[1])
rows = retrieve_source_chunks(
    topic=payload.get("query") or "",
    top_k=int(payload.get("topK") or 8),
    source_type=payload.get("sourceType") or None,
    citation_role=payload.get("citationRole") or None,
)
print(json.dumps({"query": payload.get("query") or "", "chunks": rows}, ensure_ascii=False))
`, params, 120000);
}

async function latestJstyleOutput(params = {}) {
  const project = jstyleProject(params);
  return runJstyleInline(project, `
import json, os
from pathlib import Path
from jstyle_rag.config import get_config

cfg = get_config()
outputs = sorted(cfg.outputs_dir.glob("*.json"))
latest = outputs[-1] if outputs else None
if latest is None:
    host = os.environ.get("PAPER_AGENT_HOST_PROJECT_ROOT") or ""
    fallback = Path(host) / "outputs" / "japanese-style-rag" / "latest-draft.json" if host else None
    if fallback and fallback.exists():
        latest = fallback
if latest is None:
    print(json.dumps({"output_file": "", "output": None}, ensure_ascii=False))
else:
    data = json.loads(latest.read_text(encoding="utf-8"))
    data = data.get("output") if isinstance(data, dict) and isinstance(data.get("output"), dict) else data
    try:
        output_file = str(latest.relative_to(cfg.project_root))
    except ValueError:
        output_file = str(latest)
    print(json.dumps({
        "output_file": output_file,
        "output": data,
    }, ensure_ascii=False))
`, params, 120000);
}

async function indexJstyleProject() {
  const project = jstyleProject(arguments[0]);
  return runJstyleInline(project, `
import json
from jstyle_rag.config import ensure_directories, get_config
from jstyle_rag.module import ensure_module_directories, module_status
from jstyle_rag.style.style_seed_profiles import seed_style_profiles
from jstyle_rag.style.style_index import build_style_indexes
from jstyle_rag.sources.source_metadata import classify_source_files
from jstyle_rag.sources.source_ingest import ingest_sources
from jstyle_rag.sources.source_index import build_source_index

cfg = get_config()
ensure_directories(cfg)
ensure_module_directories(cfg)
seed_path = seed_style_profiles(cfg, overwrite=False)
style_counts = build_style_indexes(cfg)
source_rows = classify_source_files(cfg.source_raw_dir)
chunks = ingest_sources(cfg)
source_count = build_source_index(cfg)
print(json.dumps({
    "seed_profiles": str(seed_path),
    "style_counts": style_counts,
    "source_files": source_rows,
    "source_chunks": len(chunks),
    "source_index_count": source_count,
    "module": module_status(cfg),
}, ensure_ascii=False))
`, {}, 180000);
}

async function runCodexPrompt(ws, prompt, projectId = '') {
  const text = String(prompt || '').trim();
  if (!text) return;
  if (runnerBusy || runProc) {
    wsSend(ws, '\r\n\x1b[33m已有助手任务在运行，请先点“停止”或等待完成。\x1b[0m\r\n');
    return;
  }

  const project = projectById(projectId);
  if (!project) {
    wsSend(ws, '\r\n\x1b[31m没有可用项目。\x1b[0m\r\n');
    return;
  }

  const runId = activeRunId + 1;
  activeRunId = runId;
  runnerBusy = true;
  const before = repoState(project);
  const agent = currentAgent(project);
  const boundary = agent.type === 'codex'
    ? `项目隔离目录: ${path.basename(project.codexHome)}`
    : `cwd: ${project.paperDir}`;
  broadcast(`\r\n\x1b[1m你 · ${project.label}\x1b[0m\r\n${toTermText(text, { normalize: true })}\r\n\r\n\x1b[36m已提交给 ${agent.label || agent.id}（${boundary}）...\x1b[0m\r\n`);

  try {
    const main = await runAgentExec(project, text, 'main', runId);
    if (runId !== activeRunId || main.signal) return;
    const after = repoState(project);
    if (shouldRunAudit(project, before, after)) {
      broadcast('\r\n\x1b[35m检测到工作区变化，进入规则检查...\x1b[0m\r\n');
      const auditPrompt = buildAuditPrompt(project, text, before, after);
      await runAgentExec(project, auditPrompt, 'audit', runId);
    }
  } finally {
    if (runId === activeRunId) {
      runnerBusy = false;
      runProc = null;
    }
  }
}

// ---------- HTTP 服务 ----------
const app = express();
app.disable('x-powered-by');
// 只对自己的 API 解析 JSON；绝不能碰代理到 Overleaf 的请求体，否则代理转发会挂起
app.use('/__agent/api', localAuth.middleware);
app.use('/__agent/api', express.json({ limit: '2mb' }));

// Agent UI 与静态资源
app.use('/__agent', express.static(path.join(ROOT, 'public'), { dotfiles: 'deny', index: 'index.html' }));
app.use('/__agent/vendor/xterm', express.static(path.join(ROOT, 'node_modules/@xterm/xterm'), { dotfiles: 'deny', index: false }));
app.use('/__agent/vendor/addon-fit', express.static(path.join(ROOT, 'node_modules/@xterm/addon-fit'), { dotfiles: 'deny', index: false }));

// API
app.get('/__agent/api/session', (req, res) => {
  res.json({ ok: true, token: localAuth.token });
});

app.get('/__agent/api/projects', (req, res) => {
  res.json({
    ok: true,
    activeProjectId: config.activeProjectId,
    projects: config.projects.map(sanitizeProject),
  });
});

app.get('/__agent/api/overleaf/projects', (req, res) => {
  try {
    res.json({ ok: true, projects: listOverleafProjects() });
  } catch (e) {
    res.json({ ok: false, projects: [], error: String(e.message || e) });
  }
});

app.get('/__agent/api/modules', (req, res) => {
  res.json({
    ok: true,
    activeProjectId: config.activeProjectId,
    activeModules: currentProject()?.modules || [],
    modules: moduleManifests(),
  });
});

app.post('/__agent/api/project/select', (req, res) => {
  const id = safeProjectId(req.body?.id);
  const project = config.projects.find((p) => p.id === id);
  if (!project) return res.status(404).json({ ok: false, error: `未知项目: ${id}` });
  stopRun('SIGTERM');
  config.activeProjectId = project.id;
  const active = currentProject();
  config.paperDir = active.paperDir;
  config.projectName = active.overleafProjectName || '';
  config.pushPaths = active.pushPaths;
  saveConfig(config);
  loggedIn = false;
  broadcast(`\r\n\x1b[36m已切换项目: ${active.label} (${displayPathForProject(active, active.paperDir)})\x1b[0m\r\n`);
  res.json({ ok: true, activeProjectId: active.id, project: sanitizeProject(active) });
});

app.post('/__agent/api/project/from-overleaf', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: '缺少 Overleaf 项目名' });
    const existing = config.projects.find((p) => p.overleafProjectName === name || p.label === name);
    stopRun('SIGTERM');
    let active = existing;
    if (!active) {
      active = defaultPaperProjectFromOverleaf(name);
      scaffoldProjectFiles(active);
      config.projects = [...config.projects, active];
    } else {
      scaffoldProjectFiles(active);
    }
    config.activeProjectId = active.id;
    config.paperDir = active.paperDir;
    config.projectName = active.overleafProjectName || '';
    config.pushPaths = active.pushPaths;
    saveConfig(config);
    loggedIn = false;
    broadcast(`\r\n\x1b[36m已切换 Overleaf 项目: ${active.label} (${displayPathForProject(active, active.paperDir)})\x1b[0m\r\n`);
    res.json({ ok: true, activeProjectId: active.id, project: sanitizeProject(currentProject()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/project/delete', (req, res) => {
  const id = safeProjectId(req.body?.id || config.activeProjectId);
  if (config.projects.length <= 1) return res.status(400).json({ ok: false, error: '至少保留一个项目' });
  const project = config.projects.find((p) => p.id === id);
  if (!project) return res.status(404).json({ ok: false, error: `未知项目: ${id}` });
  stopRun('SIGTERM');
  config.projects = config.projects.filter((p) => p.id !== id);
  if (config.activeProjectId === id) config.activeProjectId = config.projects[0].id;
  const active = currentProject();
  config.paperDir = active.paperDir;
  config.projectName = active.overleafProjectName || '';
  config.pushPaths = active.pushPaths;
  saveConfig(config);
  loggedIn = false;
  broadcast(`\r\n\x1b[36m已删除项目: ${project.label}；当前项目: ${active.label}\x1b[0m\r\n`);
  res.json({ ok: true, activeProjectId: active.id, project: sanitizeProject(active) });
});

app.post('/__agent/api/project/create-overleaf', async (req, res) => {
  try {
    const project = projectById(req.body?.projectId) || currentProject();
    if (!project) return res.status(404).json({ ok: false, error: '没有可用项目' });
    if (project.overleafProjectName) {
      return res.json({ ok: true, project: sanitizeProject(project), overleaf: { name: project.overleafProjectName, existing: true } });
    }
    const created = await createOverleafProject(project.label);
    const updated = normalizeProject({ ...project, overleafProjectName: created.name, overleafProjectId: created.id || '' });
    config.projects = config.projects.map((item) => (item.id === updated.id ? updated : item));
    if (config.activeProjectId === updated.id) {
      config.paperDir = updated.paperDir;
      config.projectName = updated.overleafProjectName || '';
      config.pushPaths = updated.pushPaths;
    }
    saveConfig(config);
    const active = config.projects.find((item) => item.id === updated.id) || updated;
    loggedIn = false;
    broadcast(`\r\n\x1b[36m已为当前项目创建 Overleaf: ${created.name}\x1b[0m\r\n`);
    res.json({ ok: true, project: sanitizeProject(active), overleaf: created });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/projects', async (req, res) => {
  try {
    const incoming = normalizeProject(req.body?.project || {});
    const existingProject = config.projects.find((p) => p.id === incoming.id);
    let createdOverleaf = null;
    if (req.body?.createOverleaf && !incoming.overleafProjectName && !existingProject?.overleafProjectName) {
      createdOverleaf = await createOverleafProject(incoming.label);
      incoming.overleafProjectName = createdOverleaf.name;
      incoming.overleafProjectId = createdOverleaf.id || '';
    }
    if (req.body?.createDir !== false) {
      scaffoldProjectFiles(incoming);
    } else if (!fs.existsSync(incoming.paperDir)) {
      return res.status(400).json({ ok: false, error: `本地目录不存在: ${incoming.paperDir}` });
    } else {
      scaffoldProjectFiles(incoming);
    }
    const exists = config.projects.some((p) => p.id === incoming.id);
    config.projects = exists
      ? config.projects.map((p) => (p.id === incoming.id ? normalizeProject({ ...p, ...incoming }) : p))
      : [...config.projects, incoming];
    if (req.body?.activate) config.activeProjectId = incoming.id;
    saveConfig(config);
    if (req.body?.activate) loggedIn = false;
    res.json({ ok: true, project: sanitizeProject(config.projects.find((p) => p.id === incoming.id)), overleaf: createdOverleaf });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/__agent/api/config', (req, res) => {
  const { password, projects, ...rest } = config;
  const project = currentProject();
  res.json({
    ...rest,
    hasPassword: !!password,
    project: sanitizeProject(project),
    projects: projects.map(sanitizeProject),
    agents: sanitizeAgents(config.agents),
    paperDir: project.paperDir,
    projectName: project.overleafProjectName || '',
    pushPaths: project.pushPaths,
  });
});

app.post('/__agent/api/agents/models', async (req, res) => {
  try {
    const result = await modelsForAgent(req.body?.provider, req.body?.agents || {});
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/config', (req, res) => {
  const body = req.body || {};
  if (body.email !== undefined) config.email = body.email;
  if (body.password !== undefined && body.password !== '') config.password = body.password;
  if (body.codexCmd !== undefined && body.codexCmd !== '') config.codexCmd = body.codexCmd || DEFAULT_CONFIG.codexCmd;
  if (body.agents && typeof body.agents === 'object') {
    config.agents = {
      ...config.agents,
      ...Object.fromEntries(Object.entries(body.agents).map(([id, value]) => [
        id,
        { ...(config.agents?.[id] || DEFAULT_AGENTS[id] || { id }), ...(value || {}) },
      ])),
    };
    if (config.agents.codex?.command) config.codexCmd = config.agents.codex.command;
  }
  if (!config.codexCmd) config.codexCmd = DEFAULT_CONFIG.codexCmd;

  const patch = {};
  if (body.label !== undefined && body.label !== '') patch.label = body.label;
  if (body.paperDir !== undefined && body.paperDir !== '') patch.paperDir = body.paperDir;
  if (body.agentProvider !== undefined && body.agentProvider !== '') patch.agentProvider = body.agentProvider;
  if (body.projectName !== undefined) patch.overleafProjectName = body.projectName;
  if (body.pushPaths !== undefined) patch.pushPaths = Array.isArray(body.pushPaths)
    ? body.pushPaths
    : String(body.pushPaths).split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  if (body.auditEnabled !== undefined) patch.audit = { ...currentProject().audit, enabled: !!body.auditEnabled };
  if (Object.keys(patch).length) updateActiveProject(patch);
  else saveConfig(config);

  loggedIn = false; // 凭据或项目可能变了
  res.json({ ok: true, project: sanitizeProject(currentProject()) });
});

app.get('/__agent/api/prompts', (req, res) => {
  const project = projectById(req.query?.projectId) || currentProject();
  res.json({
    ok: true,
    flows: flowsForProject(project),
    skillPrompts: skillPromptsForProject(project),
    overrides: project.prompts || {},
    skillOverrides: project.skillPrompts || {},
  });
});

app.post('/__agent/api/prompts', (req, res) => {
  const project = projectById(req.body?.projectId) || currentProject();
  const prompts = req.body?.prompts && typeof req.body.prompts === 'object' ? req.body.prompts : {};
  const skillPrompts = req.body?.skillPrompts && typeof req.body.skillPrompts === 'object' ? req.body.skillPrompts : {};
  const updated = normalizeProject({
    ...project,
    prompts: { ...(project.prompts || {}), ...prompts },
    skillPrompts: { ...(project.skillPrompts || {}), ...skillPrompts },
  });
  config.projects = config.projects.map((item) => (item.id === updated.id ? updated : item));
  saveConfig(config);
  res.json({ ok: true });
});

app.post('/__agent/api/prompts/render', (req, res) => {
  const project = projectById(req.body?.projectId) || currentProject();
  const id = req.body?.id;
  const flow = flowsForProject(project).find((f) => f.id === id);
  if (!flow) return res.status(404).json({ ok: false, error: `未知 prompt: ${id}` });
  const target = req.body?.arg ?? flow.defaultArg ?? '';
  const prompt = renderTemplate(flow.prompt, projectVars(project, { target, mode: target }));
  res.json({ ok: true, prompt });
});

app.post('/__agent/api/jstyle/generate', async (req, res) => {
  try {
    const result = await generateJstyleReport(req.body || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/__agent/api/jstyle/status', async (req, res) => {
  try {
    const result = await jstyleModuleStatus(req.query || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/jstyle/status', async (req, res) => {
  try {
    const result = await jstyleModuleStatus(req.body || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/jstyle/bootstrap', async (req, res) => {
  try {
    const result = await bootstrapJstyleModule(!!req.body?.install, req.body || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/jstyle/materials/import', async (req, res) => {
  try {
    const result = await importJstyleMaterial(req.body || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/jstyle/materials/upload', async (req, res) => {
  try {
    const { fields, files } = await parseMultipartRequest(req);
    if (!files.length) return res.status(400).json({ ok: false, error: '没有收到文件，请先选择文件或文件夹' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-agent-upload-'));
    const results = [];
    try {
      for (const file of files) {
        const tmp = path.join(tmpDir, `${Date.now()}-${Math.random().toString(16).slice(2)}-${file.filename}`);
        fs.writeFileSync(tmp, file.data);
        const title = fields.title || file.filename;
        results.push(await importJstyleMaterial({
          projectId: fields.projectId,
          sourcePath: tmp,
          materialType: fields.materialType || 'user_note',
          title,
          publisher: fields.publisher || '',
          publishedDate: fields.publishedDate || '',
          sourceUrl: fields.sourceUrl || '',
        }));
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/jstyle/guard', async (req, res) => {
  try {
    const result = await guardJstyleProject(req.body || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/jstyle/sources/search', async (req, res) => {
  try {
    const result = await searchJstyleSources(req.body || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/jstyle/outputs/latest', async (req, res) => {
  try {
    const result = await latestJstyleOutput(req.body || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/__agent/api/jstyle/index', async (req, res) => {
  try {
    const result = await indexJstyleProject(req.body || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// iframe 免登录: 代登录拿 cookie 种给浏览器，并返回项目编辑器地址
app.get('/__agent/api/autologin', async (req, res) => {
  const project = currentProject();
  if (!project?.overleafProjectName) {
    return res.json({ ok: true, overleaf: false, url: 'about:blank' });
  }
  try {
    const sid = await autoLoginCookie();
    res.setHeader('Set-Cookie', `overleaf.sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    let url = '/project';
    try { url = `/project/${oid(getProjectInfo(activeOverleafName())._id)}`; } catch {}
    res.json({ ok: true, overleaf: true, url });
  } catch (e) {
    res.json({ ok: false, overleaf: true, error: String(e.message || e), url: '/project' });
  }
});

app.post('/__agent/api/pull', async (req, res) => {
  try { res.json({ ok: true, ...(await pullProject(req.body || {})) }); }
  catch (e) { loggedIn = false; res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post('/__agent/api/push', async (req, res) => {
  try {
    const results = await pushProject(req.body || {});
    res.json({ ok: results.every((r) => r.ok), results });
  } catch (e) { loggedIn = false; res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Overleaf 的 PDF/zip 下载走显式流式转发，避免浏览器下载被通用 iframe 代理的边角响应影响。
app.get(/^\/download\/project\/.+$/, pipeOverleafDownload);
app.get(/^\/project\/[^/]+\/download\/.+$/, pipeOverleafDownload);

// 其余全部反代到 Overleaf；剥掉禁止 iframe 的响应头
const olProxy = createProxyMiddleware({
  target: config.overleafUrl,
  ws: false, // ws 升级在下面手动路由
  changeOrigin: false,
  on: {
    proxyRes: (proxyRes) => {
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
    },
  },
});
app.use('/', olProxy);

const server = http.createServer(app);

// WebSocket: /__agent/pty 归我们，其余 (socket.io 等) 交给代理
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/__agent/pty')) {
    if (!localAuth.verifyUpgrade(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    olProxy.upgrade(req, socket, head);
  }
});
wss.on('connection', (ws) => {
  ptyClients.add(ws);
  const project = currentProject();
  const agent = currentAgent(project);
  wsSend(ws, `\r\n\x1b[36mPaper Agent 已连接。当前项目: ${project.label}。当前助手: ${agent.label || agent.id}。\x1b[0m\r\n`);
  if (runProc || runnerBusy) wsSend(ws, '\x1b[33m已有助手任务正在运行，后续输出会继续显示在这里。\x1b[0m\r\n');
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'prompt') runCodexPrompt(ws, m.d, m.projectId);
    else if (m.t === 'cancel') {
      if (runProc || runnerBusy) {
        stopRun('SIGTERM');
        wsSend(ws, '\r\n\x1b[33m已请求停止当前助手任务。\x1b[0m\r\n');
      }
    } else if (m.t === 'restart') {
      stopRun('SIGTERM');
      wsSend(ws, '\r\n\x1b[36m写作助手已重置。\x1b[0m\r\n');
    }
  });
  ws.on('close', () => ptyClients.delete(ws));
});

server.listen(config.port, '127.0.0.1', () => {
  const project = currentProject();
  console.log(`Paper Agent: http://localhost:${config.port}/__agent/`);
  console.log(`当前项目: ${project.label}  目录: ${project.paperDir}  Overleaf: ${project.overleafProjectName || '(未绑定)'}`);
});

process.on('exit', () => stopRun('SIGTERM'));
process.on('SIGINT', () => { stopRun('SIGTERM'); process.exit(130); });
process.on('SIGTERM', () => { stopRun('SIGTERM'); process.exit(143); });
