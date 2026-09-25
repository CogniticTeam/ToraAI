// 项目影响雷达：基于相对导入关系的有界静态推断，不执行代码，也不声称覆盖运行时依赖。
import { readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, dirname, join } from 'node:path';
import { runGit } from './tools/git.js';
import { walkCodeFiles } from './tools/repomap.js';

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];
const MAX_FILES = 3000;
const MAX_TARGETS = 40;

function localPath(cwd, value) {
  const input = String(value || '').trim();
  if (!input || isAbsolute(input)) return null;
  const path = relative(cwd, resolve(cwd, input)).replaceAll('\\', '/');
  return path && path !== '..' && !path.startsWith('../') ? path : null;
}

async function gitTargets(cwd) {
  const result = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, { timeout: 8000, maxBuffer: 300000 });
  if (!result.ok) return { paths: [], warning: '无法读取 Git 状态；可手动输入要分析的相对路径。' };
  const entries = result.stdout.split('\0');
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    if (!item || item.length < 4) continue;
    const path = localPath(cwd, item.slice(3));
    if (path) paths.push(path);
    if (/[RC]/.test(item.slice(0, 2))) {
      const previous = localPath(cwd, entries[++i]);
      if (previous) paths.push(previous);
    }
  }
  return { paths, warning: result.stdout && !result.stdout.endsWith('\0') ? 'Git 状态输出被截断，目标文件可能不完整。' : null };
}

function testFile(path) {
  return /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:\.|_)(?:test|spec)\.[^/]+$/i.test(path);
}

function resolveImport(from, spec, known) {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(from), spec).replaceAll('\\', '/');
  for (const candidate of [base, ...SOURCE_EXTS.map((ext) => `${base}${ext}`), ...SOURCE_EXTS.map((ext) => `${base}/index${ext}`)]) {
    const normalized = candidate.replace(/^\.\//, '');
    if (known.has(normalized)) return normalized;
  }
  return null;
}

function dependencyGraph(cwd, files, targets) {
  const known = new Set([...files.map((file) => relative(cwd, file.path).replaceAll('\\', '/')), ...targets]);
  const reverse = new Map();
  for (const file of files) {
    if (!SOURCE_EXTS.includes(extname(file.path))) continue;
    let source;
    try { source = readFileSync(file.path, 'utf8'); } catch { continue; }
    const from = relative(cwd, file.path).replaceAll('\\', '/');
    const re = /(?:\b(?:import|export)\s+(?:[\s\S]{0,120}?\s+from\s*)?|\brequire\s*\(|\bimport\s*\()\s*['"](\.[^'"\n]+)['"]/g;
    for (const match of source.matchAll(re)) {
      const target = resolveImport(from, match[1], known);
      if (!target) continue;
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(from);
    }
  }
  return reverse;
}

/** paths 为空时分析当前 Git 改动；否则可在动手前模拟指定文件的影响。 */
export async function analyzeImpact(cwd, { paths = [] } = {}) {
  if (!cwd) throw new Error('该会话还没有工作目录');
  const supplied = Array.isArray(paths) ? paths : [];
  const fromGit = supplied.length ? null : await gitTargets(cwd);
  const raw = supplied.length ? supplied : fromGit.paths;
  const targets = [...new Set(raw.map((path) => localPath(cwd, path)).filter(Boolean))].slice(0, MAX_TARGETS);
  const warnings = [
    '仅分析本地相对导入；路径别名、动态加载、运行时调用与跨语言依赖可能遗漏。',
    '测试文件建议基于导入关系和同名规则推断，尚未执行。',
  ];
  const warningsEn = [
    'Only local relative imports are analyzed; aliases, dynamic loading, runtime calls, and cross-language dependencies may be missed.',
    'Suggested test files are inferred from imports or matching names and have not been run.',
  ];
  if (fromGit?.warning) { warnings.push(fromGit.warning); warningsEn.push(fromGit.warning.includes('截断') ? 'Git status output was truncated; target files may be incomplete.' : 'Git status is unavailable; enter relative paths manually.'); }
  if (raw.length > MAX_TARGETS) { warnings.push(`目标文件超过 ${MAX_TARGETS} 个，仅分析前 ${MAX_TARGETS} 个。`); warningsEn.push(`More than ${MAX_TARGETS} targets were found; only the first ${MAX_TARGETS} were analyzed.`); }
  if (supplied.length && supplied.length !== targets.length) { warnings.push('部分输入路径无效、重复或超出工作目录，已跳过。'); warningsEn.push('Some paths were invalid, duplicated, or outside the workspace and were skipped.'); }
  const files = walkCodeFiles(cwd, { maxFiles: MAX_FILES, maxBytes: 256 * 1024 });
  if (files.length >= MAX_FILES) { warnings.push(`源码扫描达到 ${MAX_FILES} 个文件上限，结果可能不完整。`); warningsEn.push(`The ${MAX_FILES}-file source scan limit was reached; results may be incomplete.`); }
  const reverse = dependencyGraph(cwd, files, targets);
  const found = new Map();
  let frontier = targets.map((path) => ({ path, via: null, depth: 0 }));
  const visited = new Set(targets);
  for (let depth = 1; depth <= 2 && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const dependent of reverse.get(node.path) || []) {
        if (visited.has(dependent)) continue;
        visited.add(dependent);
        found.set(dependent, { path: dependent, via: node.path, depth });
        next.push({ path: dependent, depth });
      }
    }
    frontier = next;
  }
  const affected = [...found.values()].sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)).slice(0, 120);
  if (found.size > 120) { warnings.push('受影响文件超过 120 个，仅展示前 120 个。'); warningsEn.push('More than 120 affected files were found; only the first 120 are shown.'); }
  const targetStems = new Set(targets.map((path) => basename(path).replace(/\.[^.]+$/, '')));
  const namedTests = files.map((file) => relative(cwd, file.path).replaceAll('\\', '/')).filter((path) => {
    if (!testFile(path)) return false;
    const name = basename(path).replace(/\.[^.]+$/, '').replace(/(?:\.|_)(?:test|spec)$/i, '').replace(/^test_/, '');
    return targetStems.has(name);
  });
  const tests = [...new Set([...targets, ...found.keys()].filter(testFile).concat(namedTests))].slice(0, 40);
  const reasons = [];
  const reasonsEn = [];
  const sensitivePath = targets.some((path) => /(?:^|\/)(?:auth|security|permission|payment|billing|database|migration)(?:\/|\.|-)/i.test(path));
  if (sensitivePath) { reasons.push('涉及认证、安全、支付或数据层路径'); reasonsEn.push('Touches authentication, security, payments, or data-layer paths'); }
  if (found.size >= 12) { reasons.push(`静态依赖扩散到 ${found.size} 个文件`); reasonsEn.push(`Static dependencies reach ${found.size} files`); }
  if (targets.some((path) => /(?:package\.json|wrangler\.|\.config\.|schema\.|routes?\/|^\.github\/)/i.test(path))) { reasons.push('涉及配置、接口、CI 或路由文件'); reasonsEn.push('Touches configuration, API, CI, or route files'); }
  if (!targets.length) { reasons.push('没有可分析的目标文件'); reasonsEn.push('No target files to analyze'); }
  else if (!reasons.length) { reasons.push('未命中高风险路径或大范围静态依赖'); reasonsEn.push('No high-risk path or large static dependency fanout detected'); }
  return {
    cwd,
    source: supplied.length ? 'manual' : 'git',
    targets,
    affected,
    suggestedTests: tests,
    risk: !targets.length ? 'unknown' : found.size >= 12 || sensitivePath ? 'high' : reasons.length === 1 && reasons[0].startsWith('未命中') ? 'low' : 'medium',
    reasons,
    reasonsEn,
    warnings,
    warningsEn,
    scannedFiles: files.length,
    analyzedAt: Date.now(),
  };
}
