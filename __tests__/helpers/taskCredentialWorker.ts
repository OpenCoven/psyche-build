import {
  issueControlTaskCredential,
  revokeControlTaskCredential,
} from '../../src/control/credentials.js';

async function main(): Promise<void> {
  const [mode, projectRoot, filePath, taskId, subjectId] = process.argv.slice(2);
  const stateRoot = process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_STATE_ROOT?.trim();
  if (!mode || !projectRoot || !filePath || !taskId) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: { message: 'usage: <issue|revoke> <projectRoot> <filePath> <taskId> [subjectId]' },
    })}\n`);
    return;
  }

  try {
    const result = mode === 'issue'
      ? await issueControlTaskCredential({
          projectRoot,
          filePath,
          taskId,
          ...(stateRoot ? { stateRoot } : {}),
          ...(subjectId ? { previousSubjectId: subjectId } : {}),
        })
      : mode === 'revoke'
        ? await revokeControlTaskCredential({
            projectRoot,
            filePath,
            taskId,
            ...(stateRoot ? { stateRoot } : {}),
            ...(subjectId ? { subjectId } : {}),
          })
        : (() => { throw new Error(`unsupported mode: ${mode}`); })();
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
      },
    })}\n`);
  }
}

await main();
