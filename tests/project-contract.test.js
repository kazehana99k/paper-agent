const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const contract = require('../lib/project-contract');

function tempProject(kind = 'report') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-agent-contract-'));
  return {
    id: `${kind}-demo`,
    label: `${kind} demo`,
    paperDir: dir,
    kind,
    documentProfile: kind === 'report' ? 'course_report_japanese' : 'auto',
    overleafProjectName: `${kind}-overleaf`,
    overleafProjectId: '0123456789abcdef01234567',
    pushPaths: contract.defaultPushPathsForKind(kind),
    modules: contract.defaultModulesForKind(kind),
  };
}

test('report projects get usable Overleaf push defaults', () => {
  assert.deepEqual(contract.defaultPushPathsForKind('report'), ['main.tex', 'references.bib', 'figures']);
  assert.deepEqual(contract.defaultPromptSetForKind('report'), ['brainstorm', 'reportPolish', 'reportHumanize', 'review', 'compile', 'ruleAudit']);
  assert.deepEqual(contract.defaultModulesForKind('report'), ['brainstorm', 'japanese-style-rag']);
});

test('scaffoldProjectFiles creates project marker and starter files', () => {
  const project = tempProject('report');
  contract.scaffoldProjectFiles(project, 'report', 'course_report_japanese');

  assert.equal(fs.existsSync(path.join(project.paperDir, '.paper-agent', 'project.json')), true);
  assert.equal(fs.existsSync(path.join(project.paperDir, 'main.tex')), true);
  assert.equal(fs.existsSync(path.join(project.paperDir, 'references.bib')), true);
  assert.equal(fs.existsSync(path.join(project.paperDir, 'figures')), true);
  assert.match(fs.readFileSync(path.join(project.paperDir, 'AGENTS.md'), 'utf8'), /课程报告/);

  const marker = contract.readProjectMarker(project.paperDir);
  assert.equal(marker.id, project.id);
  assert.equal(marker.overleafProjectId, project.overleafProjectId);
  assert.equal(marker.documentProfile, 'course_report_japanese');
});

test('project marker blocks accidental cross-project sync', () => {
  const project = tempProject('report');
  contract.scaffoldProjectFiles(project, 'report', 'course_report_japanese');
  const marker = contract.readProjectMarker(project.paperDir);
  assert.doesNotThrow(() => contract.assertProjectMarker(project, marker, '推送'));

  const wrongProject = { ...project, id: 'other-project' };
  assert.throws(
    () => contract.assertProjectMarker(wrongProject, marker, '推送'),
    /项目边界校验失败/,
  );
});
