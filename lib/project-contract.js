const fs = require('fs');
const path = require('path');

const PAPER_PUSH_PATHS = ['main.tex', 'references.bib', 'figures'];
const REPORT_PUSH_PATHS = ['main.tex', 'references.bib', 'figures'];
const GENERIC_PUSH_PATHS = ['main.tex', 'references.bib', 'figures'];

const PAPER_PROMPTS = ['brainstorm', 'polish', 'translate', 'review', 'citecheck', 'compile', 'ruleAudit'];
const REPORT_PROMPTS = ['brainstorm', 'reportPolish', 'review', 'compile', 'ruleAudit'];
const GENERIC_PROMPTS = ['brainstorm', 'review', 'compile', 'ruleAudit'];

function defaultPushPathsForKind(kind) {
  if (kind === 'report') return [...REPORT_PUSH_PATHS];
  if (kind === 'generic' || kind === 'module') return [...GENERIC_PUSH_PATHS];
  return [...PAPER_PUSH_PATHS];
}

function defaultPromptSetForKind(kind) {
  if (kind === 'report') return [...REPORT_PROMPTS];
  if (kind === 'generic' || kind === 'module') return [...GENERIC_PROMPTS];
  return [...PAPER_PROMPTS];
}

function defaultModulesForKind(kind) {
  if (kind === 'report') return ['brainstorm', 'japanese-style-rag'];
  if (kind === 'module') return ['brainstorm', 'japanese-style-rag'];
  return ['brainstorm'];
}

function projectMarkerPayload(project, effectiveKind, documentProfile) {
  return {
    schemaVersion: 1,
    id: project.id,
    label: project.label,
    kind: effectiveKind || project.kind || 'paper',
    configuredKind: project.kind || 'paper',
    documentProfile: documentProfile || project.documentProfile || 'auto',
    overleafProjectName: project.overleafProjectName || '',
    overleafProjectId: project.overleafProjectId || '',
    modules: project.modules || [],
    pushPaths: project.pushPaths || [],
    updatedAt: new Date().toISOString(),
  };
}

function readProjectMarker(projectDir) {
  const file = path.join(projectDir, '.paper-agent', 'project.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function assertProjectMarker(project, marker, action = '同步') {
  if (!marker) return;
  const errors = [];
  if (marker.id && marker.id !== project.id) errors.push(`目录属于项目 ${marker.id}，当前是 ${project.id}`);
  if (marker.overleafProjectName && project.overleafProjectName && marker.overleafProjectName !== project.overleafProjectName) {
    errors.push(`目录绑定 Overleaf ${marker.overleafProjectName}，当前要${action} ${project.overleafProjectName}`);
  }
  if (marker.overleafProjectId && project.overleafProjectId && marker.overleafProjectId !== project.overleafProjectId) {
    errors.push(`目录绑定 Overleaf id ${marker.overleafProjectId}，当前是 ${project.overleafProjectId}`);
  }
  if (errors.length) {
    throw new Error(`项目边界校验失败，已停止${action}：${errors.join('；')}`);
  }
}

function writeProjectMarker(project, effectiveKind, documentProfile) {
  const markerDir = path.join(project.paperDir, '.paper-agent');
  fs.mkdirSync(markerDir, { recursive: true, mode: 0o755 });
  const payload = projectMarkerPayload(project, effectiveKind, documentProfile);
  fs.writeFileSync(path.join(markerDir, 'project.json'), JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

function syncLogPath(project) {
  return path.join(project.paperDir, '.paper-agent', 'sync-log.jsonl');
}

function appendSyncLog(project, event) {
  const file = syncLogPath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

function reportMainTex(project) {
  return [
    '% !TEX program = xelatex',
    '\\documentclass[11pt,a4paper,fontset=none]{ctexart}',
    '\\usepackage[a4paper,margin=25mm]{geometry}',
    '\\usepackage{amsmath,amssymb,mathtools}',
    '\\usepackage{fancyhdr}',
    '\\usepackage[hidelinks]{hyperref}',
    '',
    '\\newcommand{\\CourseName}{Course Name}',
    '\\newcommand{\\ReportTitle}{Report Title}',
    '\\newcommand{\\StudentName}{Student Name}',
    '\\newcommand{\\StudentId}{Student ID}',
    '\\newcommand{\\SubmissionDate}{\\today}',
    '',
    '\\pagestyle{fancy}',
    '\\fancyhf{}',
    '\\fancyhead[L]{\\CourseName}',
    '\\fancyhead[R]{\\ReportTitle}',
    '\\fancyfoot[C]{\\thepage}',
    '',
    '\\title{\\ReportTitle}',
    '\\author{\\StudentName\\\\\\StudentId}',
    '\\date{\\SubmissionDate}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '\\section{課題}',
    'ここに課題文と回答方針を書く。',
    '',
    '\\section{本文}',
    'ここに本文を書く。',
    '',
    '\\section{まとめ}',
    'ここにまとめを書く。',
    '',
    '\\end{document}',
    '',
  ].join('\n');
}

function paperMainTex(project) {
  return [
    '% !TEX program = xelatex',
    '\\documentclass[11pt]{article}',
    '\\usepackage[a4paper,margin=25mm]{geometry}',
    '\\usepackage{amsmath,amssymb,graphicx}',
    '\\usepackage[hidelinks]{hyperref}',
    '',
    `\\title{${String(project.label || 'Paper Project').replace(/[{}\\]/g, '')}}`,
    '\\author{}',
    '\\date{\\today}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '\\begin{abstract}',
    'Write the abstract here.',
    '\\end{abstract}',
    '',
    '\\section{Introduction}',
    'Write the introduction here.',
    '',
    '\\bibliographystyle{plain}',
    '\\bibliography{references}',
    '\\end{document}',
    '',
  ].join('\n');
}

function projectAgentsMd(kind) {
  if (kind === 'report') {
    return [
      '# Paper Agent 课程报告项目',
      '',
      '这是课程报告 / 日本語レポート项目，不是特定论文项目。',
      '',
      '写作与审查规则：',
      '- 按课程报告要求完成，不套用不相关的研究论文审稿标准。',
      '- 事实、定义、定理、课程要求必须来自已导入资料或用户明确提供的内容。',
      '- Japanese Style RAG 的格式模板只作为结构和文体参考，不能作为事实来源。',
      '- 课堂 PPT、讲义、作业说明、教材、论文和公开报告按资料分类使用。',
      '- 不编造引用、页码、课程内容、老师要求或数学结论。',
      '- 修改 LaTeX 后优先运行 `node tools/compile.mjs` 和 `node tools/lint.mjs`。',
      '- 不调用父目录或其他项目的编译脚本、lint 脚本、日志或资料。',
      '- 本机缺少 TeX 时说明依赖缺失；可以继续使用 Overleaf 编译。',
      '- 如需调用 Paper Agent API，使用 `node tools/paper-agent-api.mjs pull`、`push` 或 `jstyle-status`，不要手写 curl。',
      '',
    ].join('\n');
  }
  return [
    '# Paper Agent 项目',
    '',
    '这是一个 Paper Agent 管理的 LaTeX 写作项目。',
    '',
    '规则：',
    '- 只在当前项目目录内工作，除非用户明确要求跨项目读取。',
    '- 不编造实验结果、引用、DOI、课程资料或外部事实。',
    '- 修改后优先运行 `node tools/compile.mjs` 和 `node tools/lint.mjs`。',
    '- 不调用父目录或其他项目的编译脚本、lint 脚本、日志或资料。',
    '- 如需调用 Paper Agent API，使用 `node tools/paper-agent-api.mjs pull`、`push` 或 `jstyle-status`，不要手写 curl。',
    '- 如果项目启用了 Japanese Style RAG，style 资料只用于文体，source 资料才支撑事实。',
    '',
  ].join('\n');
}

function compileTool() {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const main = path.join(cwd, 'main.tex');
const buildDir = path.join(cwd, 'build');

function executable(name) {
  const paths = String(process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of paths) {
    for (const ext of exts) {
      const file = path.join(dir, process.platform === 'win32' && ext && name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext);
      if (fs.existsSync(file)) return file;
    }
  }
  return '';
}

function run(cmd, args) {
  console.log('$ ' + [cmd, ...args].join(' '));
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  return typeof res.status === 'number' ? res.status : 1;
}

if (!fs.existsSync(main)) {
  console.error('main.tex not found in ' + cwd);
  process.exit(2);
}

fs.mkdirSync(buildDir, { recursive: true });

const latexmk = executable('latexmk');
if (latexmk) {
  process.exit(run(latexmk, ['-xelatex', '-interaction=nonstopmode', '-halt-on-error', '-outdir=build', 'main.tex']));
}

const xelatex = executable('xelatex');
if (xelatex) {
  let code = run(xelatex, ['-interaction=nonstopmode', '-halt-on-error', '-output-directory=build', 'main.tex']);
  if (code === 0) code = run(xelatex, ['-interaction=nonstopmode', '-halt-on-error', '-output-directory=build', 'main.tex']);
  process.exit(code);
}

console.error([
  '未找到本机 LaTeX 编译器。',
  '请安装 TeX Live / MacTeX / MiKTeX，并确保 latexmk 或 xelatex 在 PATH 中；也可以直接在 Overleaf 编译。',
  'Paper Agent 没有修改 aux/log/pdf 等编译产物。',
].join('\\n'));
process.exit(2);
`;
}

function lintTool() {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const main = path.join(cwd, 'main.tex');
const warnings = [];

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function executable(name) {
  const paths = String(process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of paths) {
    for (const ext of exts) {
      const file = path.join(dir, process.platform === 'win32' && ext && name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext);
      if (fs.existsSync(file)) return file;
    }
  }
  return '';
}

if (!fs.existsSync(main)) {
  console.error('main.tex not found in ' + cwd);
  process.exit(2);
}

const tex = read(main);
const beginCount = (tex.match(/\\\\begin\\{document\\}/g) || []).length;
const endCount = (tex.match(/\\\\end\\{document\\}/g) || []).length;
if (beginCount !== 1 || endCount !== 1) warnings.push('main.tex should contain exactly one \\\\begin{document} and one \\\\end{document}.');
if ((tex.match(/\\{/g) || []).length !== (tex.match(/\\}/g) || []).length) warnings.push('brace count is not balanced.');
if (/TODO|FIXME/i.test(tex)) warnings.push('TODO/FIXME remains in main.tex.');

let forbiddenTerms = [];
try {
  const marker = JSON.parse(read(path.join(cwd, '.paper-agent', 'project.json')) || '{}');
  if (Array.isArray(marker.forbiddenTerms)) forbiddenTerms = marker.forbiddenTerms.filter(Boolean);
} catch {}

if (forbiddenTerms.length) {
  const sourceText = tex + '\\n' + read(path.join(cwd, 'references.bib'));
  const found = forbiddenTerms.filter((term) => sourceText.includes(String(term)));
  if (found.length) warnings.push('forbidden terms appear in project sources: ' + found.join(', '));
}

const chktex = executable('chktex');
if (chktex) {
  const res = spawnSync(chktex, ['-q', 'main.tex'], { cwd, encoding: 'utf8', shell: false });
  if (res.stdout.trim()) warnings.push('chktex output:\\n' + res.stdout.trim());
  if (res.stderr.trim()) warnings.push('chktex stderr:\\n' + res.stderr.trim());
}

if (warnings.length) {
  console.error(warnings.map((item) => '- ' + item).join('\\n'));
  process.exit(1);
}

console.log('lint passed');
`;
}

function paperAgentApiTool() {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const actions = {
  pull: ['POST', '/pull'],
  push: ['POST', '/push'],
  'jstyle-status': ['POST', '/jstyle/status'],
  'jstyle-index': ['POST', '/jstyle/index'],
  'jstyle-guard': ['POST', '/jstyle/guard'],
  'jstyle-latest': ['POST', '/jstyle/outputs/latest'],
};

function readMarkerProjectId() {
  try {
    const file = path.join(process.cwd(), '.paper-agent', 'project.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).id || '';
  } catch {
    return '';
  }
}

function parseJsonArg(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error('JSON 参数解析失败: ' + error.message);
    process.exit(2);
  }
}

const action = process.argv[2] || '';
const route = actions[action] || (action.startsWith('/') ? ['POST', action] : null);
if (!route) {
  console.error('用法: node tools/paper-agent-api.mjs <pull|push|jstyle-status|jstyle-index|jstyle-guard|jstyle-latest|/custom/path> [json]');
  process.exit(2);
}

const base = process.env.PAPER_AGENT_API_BASE || 'http://127.0.0.1:8080/__agent/api';
let token = process.env.PAPER_AGENT_TOKEN || '';
const projectId = process.env.PAPER_AGENT_PROJECT_ID || readMarkerProjectId();
if (!projectId) {
  console.error('缺少 projectId。请确认当前目录包含 .paper-agent/project.json。');
  process.exit(2);
}

async function refreshToken() {
  const response = await fetch(base + '/session', { headers: token ? { 'x-paper-agent-token': token } : {} });
  const payload = await response.json();
  if (!payload.ok || !payload.token) throw new Error(payload.error || '无法获取 Paper Agent 本机访问令牌');
  token = payload.token;
  return token;
}

async function request(retry = true) {
  if (!token) await refreshToken();
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-paper-agent-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  if (response.status === 403 && retry && /令牌|token/i.test(String(payload?.error || text))) {
    await refreshToken();
    return request(false);
  }
  return { response, text, payload };
}

const [method, endpoint] = route;
const body = { projectId, ...parseJsonArg(process.argv[3] || '') };
const { response, text, payload } = await request(true);
if (payload) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(text);
}

if (!response.ok || payload?.ok === false) process.exit(1);
`;
}

function scaffoldProjectFiles(project, effectiveKind, documentProfile) {
  const kind = effectiveKind || project.kind || 'paper';
  fs.mkdirSync(project.paperDir, { recursive: true, mode: 0o755 });
  writeProjectMarker(project, kind, documentProfile);

  for (const dir of ['figures', 'materials', 'reviews', 'outputs', 'tools']) {
    fs.mkdirSync(path.join(project.paperDir, dir), { recursive: true, mode: 0o755 });
  }
  writeIfMissing(path.join(project.paperDir, 'references.bib'), '% Add BibTeX entries here.\n');
  writeIfMissing(path.join(project.paperDir, 'main.tex'), kind === 'report' ? reportMainTex(project) : paperMainTex(project));
  writeIfMissing(path.join(project.paperDir, 'AGENTS.md'), projectAgentsMd(kind));
  writeIfMissing(path.join(project.paperDir, 'tools', 'compile.mjs'), compileTool());
  writeIfMissing(path.join(project.paperDir, 'tools', 'lint.mjs'), lintTool());
  writeIfMissing(path.join(project.paperDir, 'tools', 'paper-agent-api.mjs'), paperAgentApiTool());
  writeIfMissing(path.join(project.paperDir, '.gitignore'), [
    'build/',
    '*.aux',
    '*.bbl',
    '*.blg',
    '*.fls',
    '*.fdb_latexmk',
    '*.log',
    '*.out',
    '*.synctex.gz',
    '.paper-agent/modules/',
    '.paper-agent/sync-log.jsonl',
    '.venv/',
    '',
  ].join('\n'));
}

module.exports = {
  PAPER_PUSH_PATHS,
  REPORT_PUSH_PATHS,
  GENERIC_PUSH_PATHS,
  defaultPushPathsForKind,
  defaultPromptSetForKind,
  defaultModulesForKind,
  projectMarkerPayload,
  readProjectMarker,
  assertProjectMarker,
  writeProjectMarker,
  appendSyncLog,
  scaffoldProjectFiles,
};
