import { describe, expect, it } from 'vitest';
import {
  buildNotificationSoundPreviewMessage,
  getPsycheHelperSocketPath,
} from '../src/utils/notificationSoundPreview.js';

describe('notification sound preview commands', () => {
  it('routes the system sound preview through the helper without a bundled resource', () => {
    expect(
      buildNotificationSoundPreviewMessage('default-system-sound', 'darwin')
    ).toEqual({
      type: 'preview-sound',
      soundName: undefined,
    });
  });

  it('routes bundled sound previews through the helper resource name', () => {
    expect(buildNotificationSoundPreviewMessage('harp', 'darwin')).toEqual({
      type: 'preview-sound',
      soundName: 'psyche-harp.caf',
    });
  });

  it('disables preview messages outside macOS', () => {
    expect(buildNotificationSoundPreviewMessage('harp', 'linux')).toBeNull();
  });

  it('uses the default helper socket path', () => {
    expect(getPsycheHelperSocketPath('/tmp/home')).toBe(
      '/tmp/home/.psyche/native-helper/run/psyche-helper.sock'
    );
  });
});
