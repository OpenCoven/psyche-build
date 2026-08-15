import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlResponseError } from '../src/control/client.js';
import {
  MCP_CONTROL_ERROR_CODE,
  SERVER_NAME,
  TOOLS,
  handleMcpRequest,
  listLegacyWorktrees,
  setMcpDeps,
} from '../src/mcp/server.js';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  vi.restoreAllMocks();
});

function inject(next: Parameters<typeof setMcpDeps>[0]): void {
  restores.push(setMcpDeps(next));
}

__MERGE_CALL_PAYLOAD_HELPERS_AND_KEEP_CURRENT_REGISTRY_ASSERTIONS__
      'psyche_execute_task',
      'psyche_create_pane',
      'psyche_kill_pane',
      'psyche_list_panes',
      'psyche_get_pane_output',
      'psyche_list_rituals',
      'psyche_list_worktrees',
      'psyche_pane_action',
      'psyche_pane_observe',
    ]);
  });

__MERGE_README_DOC_CHECK_AND_ERROR-MAPPING_TESTS_WITH_CURRENT_LEGACY-HELPER_TESTS__
      },
    });
  });

__MERGE_ALIAS_TRANSLATION_TESTS_KEEPING_CURRENT_CREATE-PROMPT-REJECTION_EXPECTATION__
      },
    });
  });
});
