import {
  ChatCompletionRequestMessage,
  ChatCompletionRequestMessageRoleEnum
} from 'openai';
import { api } from './api';
import { getConfig } from './commands/config';
import { mergeDiffs } from './utils/mergeDiffs';
import { i18n, I18nLocals } from './i18n';
import { tokenCount } from './utils/tokenCount';
import winston from 'winston';

const config = getConfig();
const translation = i18n[(config?.OCO_LANGUAGE as I18nLocals) || 'en'];

const INIT_MESSAGES_PROMPT: Array<ChatCompletionRequestMessage> = [
  {
    role: ChatCompletionRequestMessageRoleEnum.System,
    // prettier-ignore
    content: `You are to act as the author of a commit message in git. Your mission is to create clean and comprehensive commit messages in the conventional commit convention and explain WHAT were the changes and WHY the changes were done. I'll send you an output of 'git diff --staged' command, and you convert it into a commit message.
${config?.OCO_EMOJI ? 'Use GitMoji convention to preface the commit.' : 'Do not preface the commit with anything.'}
${config?.OCO_DESCRIPTION ? 'Add a short description of WHY the changes are done after the commit message. Don\'t start it with "This commit", just describe the changes.' : "Don't add any descriptions to the commit, only commit message."}
Use the present tense. Lines must not be longer than 74 characters. Use ${translation.localLanguage} to answer.`
  },
  {
    role: ChatCompletionRequestMessageRoleEnum.User,
    content: `diff --git a/src/server.ts b/src/server.ts
index ad4db42..f3b18a9 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -10,7 +10,7 @@
import {
  initWinstonLogger();
  
  const app = express();
 -const port = 7799;
 +const PORT = 7799;
  
  app.use(express.json());
  
@@ -34,6 +34,6 @@
app.use((_, res, next) => {
  // ROUTES
  app.use(PROTECTED_ROUTER_URL, protectedRouter);
  
 -app.listen(port, () => {
 -  console.log(\`Server listening on port \${port}\`);
 +app.listen(process.env.PORT || PORT, () => {
 +  console.log(\`Server listening on port \${PORT}\`);
  });`
  },
  {
    role: ChatCompletionRequestMessageRoleEnum.Assistant,
    content: `${config?.OCO_EMOJI ? '🐛 ' : ''}${translation.commitFix}
${config?.OCO_EMOJI ? '✨ ' : ''}${translation.commitFeat}
${config?.OCO_DESCRIPTION ? translation.commitDescription : ''}`
  }
];

const generateCommitMessageChatCompletionPrompt = (
  diff: string
): Array<ChatCompletionRequestMessage> => {
  const chatContextAsCompletionRequest = [...INIT_MESSAGES_PROMPT];

  chatContextAsCompletionRequest.push({
    role: ChatCompletionRequestMessageRoleEnum.User,
    content: diff
  });

  return chatContextAsCompletionRequest;
};

export enum GenerateCommitMessageErrorEnum {
  tooMuchTokens = 'TOO_MUCH_TOKENS',
  internalError = 'INTERNAL_ERROR',
  emptyMessage = 'EMPTY_MESSAGE'
}

const INIT_MESSAGES_PROMPT_LENGTH = INIT_MESSAGES_PROMPT.map(
  (msg) => tokenCount(msg.content ?? '') + 4
).reduce((a, b) => a + b, 0);

const ADJUSTMENT_FACTOR = 20;

export const generateCommitMessageByDiff = (
  diff: string,
  cb: (message: string | undefined) => void
) => {
  const DEFAULT_MODEL_TOKEN_LIMIT = config?.OCO_DEFAULT_MODEL_TOKEN_LIMIT || 2048;
  const MAX_REQUEST_TOKENS =
    DEFAULT_MODEL_TOKEN_LIMIT -
    ADJUSTMENT_FACTOR -
    INIT_MESSAGES_PROMPT_LENGTH -
    config?.OCO_OPENAI_MAX_TOKENS;

  if (MAX_REQUEST_TOKENS < 100) {
    throw new Error(
      'MAX_REQUEST_TOKENS is too small. Please, decrease OCO_OPENAI_MAX_TOKENS or increase DEFAULT_MODEL_TOKEN_LIMIT'
    );
  }

  const diffTokCount = tokenCount(diff);
  if (diffTokCount >= MAX_REQUEST_TOKENS) {
    winston.info(`diff ${diffTokCount} is bigger than gpt context — split diff into file-diffs`);
    getCommitMsgsFromFileDiffs(
      diff,
      MAX_REQUEST_TOKENS,
      (message: string | undefined) => {
        cb(message);
      }
    );
  } else {
    const messages = generateCommitMessageChatCompletionPrompt(diff);

    api.generateCommitMessage(messages, (commitMessage: string | undefined) => {
      if (!commitMessage)
        throw new Error(GenerateCommitMessageErrorEnum.emptyMessage);
      cb(commitMessage);
    });
  }
};

function getMessagesByChangesInFile(
  fileDiff: string,
  separator: string,
  maxChangeLength: number,
  cb: (messages: (string | undefined)[]) => void
) {
  const hunkHeaderSeparator = '@@ ';
  const [fileHeader, ...fileDiffByLines] = fileDiff.split(hunkHeaderSeparator);

  // merge multiple line-diffs into 1 to save tokens
  winston.info('merge multiple line-diffs into 1 to save tokens');
  const mergedChanges = mergeDiffs(
    fileDiffByLines.map((line) => hunkHeaderSeparator + line),
    maxChangeLength
  );

  let requestCount = 0;
  let commitMsgsFromFileLineDiffs: (string | undefined)[] = [];

  const f = (lineDiff: string) => {
    const messages = generateCommitMessageChatCompletionPrompt(
      separator + lineDiff
    );

    // generate commit message from line-diff
    
    requestCount = requestCount + 1;
    winston.info(`generate commit message from line-diff (${requestCount})`);
    api.generateCommitMessage(messages, (commitMessage: string | undefined) => {
      commitMsgsFromFileLineDiffs.push(commitMessage);
      winston.info(`line-diff generate complete (${commitMsgsFromFileLineDiffs.length} of ${requestCount})`);
      if (commitMsgsFromFileLineDiffs.length === requestCount) {
        cb(commitMsgsFromFileLineDiffs);
      }
    });
  }

  for (const change of mergedChanges) {
    const totalChange = fileHeader + change;
    const changeTokCount = tokenCount(totalChange);
    if (changeTokCount > maxChangeLength) {
      // If the totalChange is too large, split it into smaller pieces
      winston.info(`totalChange (${changeTokCount}) is too large, split it into smaller pieces`);
      const splitChanges = splitDiff(totalChange, maxChangeLength);
      splitChanges.forEach(f);
    } else {
      winston.info(`totalChange (${changeTokCount}) accepted.`);
      f(totalChange)
    }
  }
}

function splitDiff(diff: string, maxChangeLength: number) {
  const lines = diff.split('\n');
  const splitDiffs = [];
  let currentDiff = '';

  for (let line of lines) {
    // If a single line exceeds maxChangeLength, split it into multiple lines
    while (tokenCount(line) > maxChangeLength) {
      winston.info('line exceeds maxChangeLength, split it into multiple lines');
      const subLine = line.substring(0, maxChangeLength);
      line = line.substring(maxChangeLength);
      splitDiffs.push(subLine);
    }

    const nextLineAddTokenCount = tokenCount(currentDiff) + tokenCount(line) + 1;
    // Check the tokenCount of the currentDiff and the line separately
    if (nextLineAddTokenCount > maxChangeLength) {
      // If adding the next line would exceed the maxChangeLength, start a new diff
      winston.info(`adding the next line (${nextLineAddTokenCount}) would exceed the maxChangeLength (${maxChangeLength}), start a new diff`);
      splitDiffs.push(currentDiff);
      currentDiff = line;

    } else {
      // Otherwise, add the line to the current diff
      currentDiff += '\n' + line;
    }
  }

  // Add the last diff
  if (currentDiff) {
    splitDiffs.push(currentDiff);
  }

  return splitDiffs;
}

export function getCommitMsgsFromFileDiffs(
  diff: string,
  maxDiffLength: number,
  cb: (message: string | undefined) => void
) {
  const separator = 'diff --git ';

  const diffByFiles = diff.split(separator).slice(1);

  // merge multiple files-diffs into 1 prompt to save tokens
  const mergedFilesDiffs = mergeDiffs(diffByFiles, maxDiffLength);

  let messagesAcc: (string | undefined)[] = [];

  for (const fileDiff of mergedFilesDiffs) {
    const tokCount = tokenCount(fileDiff)
    if (tokCount >= maxDiffLength) {
      // if file-diff is bigger than gpt context — split fileDiff into lineDiff
      winston.info(`fileDiff (${tokCount}) is bigger than max gpt context (${maxDiffLength}) — splitting fileDiff into lineDiff`);
      getMessagesByChangesInFile(
        fileDiff,
        separator,
        maxDiffLength,
        (messages: (string | undefined)[]) => {
          messagesAcc.push(messages.join('\n\n'));
        }
      );
    } else {
      winston.info(`generating commit message from file-diff (${tokCount})`);
      const messages = generateCommitMessageChatCompletionPrompt(
        separator + fileDiff
      );

      api.generateCommitMessage(messages, (commitMessage: string | undefined) => {
        messagesAcc.push(commitMessage);
      });
    }
  }

  const f = () => {
    setTimeout(() => {
      if (messagesAcc.length === mergedFilesDiffs.length)
        cb(messagesAcc.join('\n\n'));
      else f();
    }, 100);
  }

  f();
}