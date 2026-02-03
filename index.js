import { readFileSync, existsSync } from 'fs';
import { resolve, relative } from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';

const LCOV_COMMENT_MARKER = '<!-- lcov-comment -->';
const MAX_FILES_PER_PAGE = 100;

async function run() {
  try {
    const lcovFile = core.getInput('lcov-file', { required: true });
    const githubToken = core.getInput('github-token', { required: true });
    const testSummaryFile = core.getInput('test-summary-file') || null;
    const allFilesMin = parseFloat(core.getInput('all-files-minimum-coverage')) || 0;
    const changedFilesMin = parseFloat(core.getInput('changed-files-minimum-coverage')) || 0;

    if (!existsSync(lcovFile)) {
      throw new Error(`LCOV file not found: ${lcovFile}`);
    }

    const coverage = parseLcovFile(lcovFile);
    const changedFiles = await getChangedFiles(githubToken);
    const testSummary = testSummaryFile && existsSync(testSummaryFile)
      ? readFileSync(testSummaryFile, 'utf8').trim()
      : null;

    const allCoverage = calculateCoverage(coverage);
    const changedCoverage = calculateCoverage(coverage, changedFiles);

    const allPassed = allCoverage.percentage >= allFilesMin;
    const changedPassed = changedFiles.size === 0 || changedCoverage.percentage >= changedFilesMin;
    const passed = allPassed && changedPassed;

    if (!passed) {
      core.setFailed('Coverage is below the minimum threshold');
    }

    if (github.context.eventName === 'pull_request') {
      const comment = buildComment(
        allCoverage,
        changedCoverage,
        allFilesMin,
        changedFilesMin,
        passed,
        changedFiles.size > 0,
        testSummary
      );
      await postComment(githubToken, comment);
    }
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}\n${error.stack}`);
  }
}

function parseLcovFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const files = [];
  let currentFile = null;

  for (const line of content.split('\n')) {
    if (line.startsWith('SF:')) {
      const filePath = line.substring(3);
      const absolutePath = resolve(process.cwd(), filePath);
      const relativePath = relative(process.cwd(), absolutePath);
      currentFile = { file: relativePath, lines: { found: 0, hit: 0 } };
    } else if (line.startsWith('LF:') && currentFile) {
      currentFile.lines.found = parseInt(line.substring(3), 10);
    } else if (line.startsWith('LH:') && currentFile) {
      currentFile.lines.hit = parseInt(line.substring(3), 10);
    } else if (line === 'end_of_record' && currentFile) {
      files.push(currentFile);
      currentFile = null;
    }
  }

  return files;
}

function calculatePercentage(hit, found) {
  return found > 0 ? (hit / found) * 100 : 0;
}

function calculateCoverage(coverage, changedFiles = null) {
  let filtered = coverage;

  if (changedFiles && changedFiles.size > 0) {
    filtered = coverage.filter(f => changedFiles.has(f.file));
  }

  if (filtered.length === 0) {
    return { found: 0, hit: 0, percentage: 0, files: [] };
  }

  const total = filtered.reduce(
    (acc, f) => {
      acc.found += f.lines.found;
      acc.hit += f.lines.hit;
      acc.files.push(f);
      return acc;
    },
    { found: 0, hit: 0, files: [] }
  );

  total.percentage = calculatePercentage(total.hit, total.found);
  return total;
}

async function getChangedFiles(token) {
  if (github.context.eventName !== 'pull_request') {
    return new Set();
  }

  const octokit = github.getOctokit(token);
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    basehead: `${github.context.payload.pull_request.base.sha}...${github.context.payload.pull_request.head.sha}`,
    per_page: MAX_FILES_PER_PAGE
  });

  return new Set(data.files.map(f => f.filename));
}

function buildComment(allCov, changedCov, allMin, changedMin, passed, hasChanged, testSummary) {
  const hasThresholds = allMin > 0 || changedMin > 0;
  const emoji = hasThresholds ? (passed ? '✅' : '❌') : '';
  const header = `## ${emoji} LCOV report`;

  const allSection = buildAllFilesSection(allCov, allMin);
  const changedSection = hasChanged
    ? buildChangedFilesSection(changedCov, changedMin)
    : '### Changed files\n\n> No files changed';

  const performanceSection = testSummary ? buildPerformanceSection(testSummary) : '';

  return `${LCOV_COMMENT_MARKER}\n${header}\n\n${allSection}\n\n${changedSection}${performanceSection}`;
}

function buildAllFilesSection(cov, min) {
  if (cov.found === 0) {
    return '### All files\n\nNo coverage data available';
  }

  const pct = cov.percentage.toFixed(1);
  const passed = cov.percentage >= min;
  const emoji = passed ? '✅' : '❌';

  const threshold = min > 0
    ? `${emoji} **${pct}%** of ${cov.found.toLocaleString()} lines (threshold: ${min}%)`
    : `**${pct}%** of ${cov.found.toLocaleString()} lines`;

  return `### All files\n\n${threshold}`;
}

function buildChangedFilesSection(cov, min) {
  if (cov.found === 0) {
    return '### Changed files\n\nChanged files not in coverage';
  }

  const pct = cov.percentage.toFixed(1);
  const passed = cov.percentage >= min;
  const emoji = passed ? '✅' : '❌';

  const threshold = min > 0
    ? `${emoji} **${pct}%** of ${cov.found.toLocaleString()} lines (threshold: ${min}%)`
    : `**${pct}%** of ${cov.found.toLocaleString()} lines`;

  const sortedFiles = [...cov.files].sort((a, b) => {
    if (a.lines.found === 0 && b.lines.found === 0) return 0;
    if (a.lines.found === 0) return 1;
    if (b.lines.found === 0) return -1;
    const aPct = calculatePercentage(a.lines.hit, a.lines.found);
    const bPct = calculatePercentage(b.lines.hit, b.lines.found);
    if (aPct !== bPct) return aPct - bPct;
    return b.lines.found - a.lines.found;
  });

  const table = buildEnhancedTable(sortedFiles);

  return `### Changed files\n\n${threshold}\n\n${table}`;
}

function buildPerformanceSection(summary) {
  if (!summary) {
    return '';
  }

  return `

### Test performance

\`\`\`
${summary}
\`\`\``;
}

function buildEnhancedTable(files) {
  if (files.length === 0) return '';

  const rows = files
    .map(f => {
      const fileName = f.file.replace(/^\//, '');
      if (f.lines.found === 0) return `| \`${fileName}\` | - |`;

      const pct = calculatePercentage(f.lines.hit, f.lines.found).toFixed(1);
      return `| \`${fileName}\` | ${pct}% of ${f.lines.found} lines |`;
    })
    .join('\n');

  return `| File | Coverage |\n| --- | --- |\n${rows}`;
}

async function postComment(token, comment) {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const issue_number = github.context.payload.pull_request.number;

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number,
    per_page: MAX_FILES_PER_PAGE
  });

  const existing = comments.find(c => c.body?.includes(LCOV_COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: comment
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body: comment
    });
  }
}

run();
