import type { OrchestrationLaneResult } from './types.js';

const MAX_ORCHESTRATION_WARNING_NOTICE_LENGTH = 512;
const MAX_ORCHESTRATION_WARNING_DETAILS = 3;
const ORCHESTRATION_WARNING_DETAIL_SEPARATOR = ':';

function sanitizeWarningDetail(message: string): string {
  const sanitized = message.replace(/[\r\n\0]/g, ' ').replace(/\s+/g, ' ').trim();
  const separatorIndex = sanitized.indexOf(ORCHESTRATION_WARNING_DETAIL_SEPARATOR);
  return separatorIndex === -1
    ? sanitized
    : sanitized.slice(separatorIndex + 1).trim();
}

function boundWarningNotice(message: string, suffix?: string): string {
  const suffixText = suffix ? `. ${suffix}` : '';
  const messageLimit = MAX_ORCHESTRATION_WARNING_NOTICE_LENGTH - suffixText.length;
  if (message.length <= messageLimit) {
    return `${message}${suffixText}`;
  }
  return `${message.slice(0, messageLimit - 1).trimEnd()}…${suffixText}`;
}

export function summarizeOrchestrationWarnings(
  lanes: readonly OrchestrationLaneResult[],
  suffix?: string,
): string | undefined {
  const warnedLanes = lanes.filter(
    (lane) => lane.status === 'completed' && lane.warnings?.length,
  );
  if (warnedLanes.length === 0) {
    return undefined;
  }

  const details = Array.from(new Set(
    warnedLanes.flatMap((lane) =>
      lane.status === 'completed'
        ? (lane.warnings ?? []).map((warning) => sanitizeWarningDetail(warning.message))
        : []
    ).filter(Boolean),
  ));
  const visibleDetails = details.slice(0, MAX_ORCHESTRATION_WARNING_DETAILS);
  const omittedDetails = details.length - visibleDetails.length;
  const subject = warnedLanes.length === 1
    ? 'Pane launched'
    : `${warnedLanes.length} panes launched`;
  let message = `${subject}, but orchestration metadata was not saved`;

  if (visibleDetails.length > 0) {
    message += `: ${visibleDetails.join('; ')}`;
    if (omittedDetails > 0) {
      message += ` (+${omittedDetails} more)`;
    }
  }
  return boundWarningNotice(message, suffix);
}
