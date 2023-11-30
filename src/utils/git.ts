import { execaSync } from 'execa';
import winston from 'winston';
import { readFileSync } from 'fs';
import ignore, { Ignore } from 'ignore';

export const assertGitRepo = () => {
  try {
    execaSync('git', ['rev-parse']);
  } catch (error) {
    throw new Error(error as string);
  }
};

// const excludeBigFilesFromDiff = ['*-lock.*', '*.lock'].map(
//   (file) => `:(exclude)${file}`
// );

export const getOpenCommitIgnore = (): Ignore => {
  const ig = ignore();

  try {
    ig.add(readFileSync('.opencommitignore').toString().split('\n'));
  } catch (e) {}

  return ig;
};

export const getCoreHooksPath = (): string => {
  const { stdout } = execaSync('git', ['config', 'core.hooksPath']);

  return stdout;
};

export const getStagedFiles = (): string[] => {
  winston.info('gitting root directory');
  const { stdout: gitDir } = execaSync('git', [
    'rev-parse',
    '--show-toplevel'
  ]);
  winston.info(`gitting staged files in ${gitDir}`);
  const { stdout: files } = execaSync('git', [
    'diff',
    '--name-only',
    '--cached',
    '--relative',
    gitDir
  ]);

  if (!files) return [];

  const filesList = files.split('\n');

  const ig = getOpenCommitIgnore();
  const allowedFiles = filesList.filter((file) => !ig.ignores(file));

  if (!allowedFiles) return [];

  return allowedFiles.sort();
};

export const getChangedFiles = (): string[] => {
  winston.info('gitting changed files');
  const { stdout: modified } = execaSync('git', ['ls-files', '--modified']);
  const { stdout: others } = execaSync('git', [
    'ls-files',
    '--others',
    '--exclude-standard'
  ]);
  winston.info(`${modified}\n${others}}`);

  const files = [...modified.split('\n'), ...others.split('\n')].filter(
    (file) => !!file
  );

  return files.sort();
};

export const gitAdd = ({ files }: { files: string[] }) => {
  winston.info('Adding files to commit');
  execaSync('git', ['add', ...files]);
  winston.info('Done');
};

export const getDiff = (files: string[]): string => {
  const lockFiles = files.filter(
    (file) =>
      file.includes('.lock') ||
      file.includes('-lock.') ||
      file.includes('.svg') ||
      file.includes('.png') ||
      file.includes('.jpg') ||
      file.includes('.jpeg') ||
      file.includes('.webp') ||
      file.includes('.gif')
  );

  if (lockFiles.length) {
    winston.info(
      `Some files are excluded by default from 'git diff'. No commit messages are generated for this files:\n${lockFiles.join(
        '\n'
      )}`
    );
  }

  const filesWithoutLocks = files.filter(
    (file) => !file.includes('.lock') && !file.includes('-lock.')
  );

  winston.info('gitting diff');
  const { stdout: diff } = execaSync('git', [
    'diff',
    '--staged',
    '--',
    ...filesWithoutLocks
  ]);

  return diff;
};
