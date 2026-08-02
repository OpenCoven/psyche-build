import { createConnection, type Socket } from 'node:net';
import os from 'os';
import path from 'path';
import {
  supportsNativePsycheHelper,
  type PsycheHelperPreviewSoundMessage,
} from './focusDetection.js';
import type { NotificationSoundId } from './notificationSounds.js';
import { getNotificationSoundDefinition } from './notificationSounds.js';

export interface NotificationSoundPreviewPlayer {
  play(soundId: NotificationSoundId): void;
  stop(): void;
}

export function buildNotificationSoundPreviewMessage(
  soundId: NotificationSoundId,
  platform: NodeJS.Platform = process.platform
): PsycheHelperPreviewSoundMessage | null {
  if (!supportsNativePsycheHelper(platform)) {
    return null;
  }

  const definition = getNotificationSoundDefinition(soundId);
  return {
    type: 'preview-sound',
    soundName: definition.resourceFileName,
  };
}

export function getPsycheHelperSocketPath(homeDirectory: string = os.homedir()): string {
  return path.join(homeDirectory, '.psyche', 'native-helper', 'run', 'psyche-helper.sock');
}

export function createNotificationSoundPreviewPlayer(
  platform: NodeJS.Platform = process.platform,
  socketPath: string = getPsycheHelperSocketPath()
): NotificationSoundPreviewPlayer {
  let activeSocket: Socket | null = null;

  const clearActiveSocket = (socketToClear: Socket) => {
    if (activeSocket === socketToClear) {
      activeSocket = null;
    }
  };

  return {
    play(soundId: NotificationSoundId) {
      this.stop();

      const message = buildNotificationSoundPreviewMessage(soundId, platform);
      if (!message) {
        return;
      }

      const socket = createConnection(socketPath);
      activeSocket = socket;

      socket.once('connect', () => {
        socket.end(`${JSON.stringify(message)}\n`);
      });
      socket.once('error', () => {
        clearActiveSocket(socket);
      });
      socket.once('close', () => {
        clearActiveSocket(socket);
      });
    },

    stop() {
      if (!activeSocket) {
        return;
      }

      activeSocket.destroy();
      activeSocket = null;
    },
  };
}
